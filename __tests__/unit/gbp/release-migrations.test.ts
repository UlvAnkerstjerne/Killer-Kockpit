import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { mainSchemaDatabase, migrationSql, REVIEW_DESK_RELEASE } from '../../helpers/gbp-release-postgres'
import { ACTOR, LOCATION, replyId, seedReview } from '../../helpers/gbp-postgres'

let db: PGlite
let originalTables: string[]
let before: Record<string, unknown>
const releaseSql = () => REVIEW_DESK_RELEASE.map(migrationSql).join('\n')
const functions = [
  'capture_gbp_review_health(uuid,numeric,bigint,timestamptz)',
  'get_gbp_review_desk(uuid,timestamptz,uuid)',
  'claim_gbp_reply_publish(uuid,uuid,text,boolean)',
  'finish_gbp_reply_publish(uuid,uuid,uuid,text)',
]
async function snapshot() {
  const result: Record<string, unknown> = {}
  for (const table of originalTables) {
    const value = table === 'gbp_review_replies'
      ? "to_jsonb(t) - 'publish_attempt_id' - 'publish_started_at'" : 'to_jsonb(t)'
    result[table] = (await db.query(`SELECT ${value} AS row FROM "${table}" t ORDER BY (${value})::text`)).rows
  }
  return result
}
beforeAll(async () => {
  db = await mainSchemaDatabase()
  await db.query(`INSERT INTO app_users (id,email,display_name,role) VALUES ($1,'ulv@killerkebab.com','Synthetic Ulv','SUPER_ADMIN')`, [ACTOR])
  await db.query(`INSERT INTO locations (id,name,short_name) VALUES ($1,'Synthetic release store','Release')`, [LOCATION])
  await db.query(`INSERT INTO gbp_locations (id,google_account_id,google_location_id,store_name,store_short_name,location_id)
    VALUES ($1,'1','2','Synthetic release store','Release',$1)`, [LOCATION])
  for (const [i, status] of ['new', 'awaiting_review', 'approved', 'rejected', 'published', 'publish_failed', 'externally_published'].entries()) {
    await seedReview(db, i + 1, new Date(Date.now() - 86400_000).toISOString(), status)
  }
  await db.query(`UPDATE gbp_review_replies SET approved_by_user_id=$1, approved_at=now(), approved_text='Existing approval'
    WHERE status IN ('approved','published')`, [ACTOR])
  await db.query(`INSERT INTO audit_events (actor_user_id,action,entity_type) VALUES ($1,'synthetic.existing','gbp_review_reply')`, [ACTOR])
  originalTables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename)
  before = await snapshot()
}, 30_000)
afterAll(async () => { await db?.close() })

describe('GBP Review Desk release on the complete pre-release migration schema', () => {
  it('applies in timestamp order and can roll back DDL before use without changing existing rows', async () => {
    expect(REVIEW_DESK_RELEASE).toEqual([...REVIEW_DESK_RELEASE].sort())
    await db.exec(`BEGIN;\n${releaseSql()}\nROLLBACK;`)
    expect((await db.query("SELECT to_regclass('gbp_review_session_state') AS state")).rows).toEqual([{ state: null }])
    expect(await snapshot()).toEqual(before)
    await db.exec(releaseSql())
    expect(await snapshot()).toEqual(before)
    expect((await db.query('SELECT publish_attempt_id,publish_started_at FROM gbp_review_replies')).rows)
      .toEqual(Array.from({ length: 7 }, () => ({ publish_attempt_id: null, publish_started_at: null })))
  })

  it('enforces claim pairing and new-table constraints against real foreign keys and enums', async () => {
    await expect(db.query('UPDATE gbp_review_replies SET publish_attempt_id=gen_random_uuid() WHERE id=$1', [replyId(1)]))
      .rejects.toThrow('gbp_publish_claim_pair')
    await expect(db.query("INSERT INTO gbp_review_session_state (user_id) VALUES (gen_random_uuid())"))
      .rejects.toThrow('foreign key')
    await expect(db.query("INSERT INTO gbp_review_session_state (user_id,started_at,last_completed_at) VALUES ($1,now(),now()-interval '1 day')", [ACTOR]))
      .rejects.toThrow('check constraint')
    await expect(db.query('SELECT capture_gbp_review_health($1,6,10,now())', [LOCATION])).rejects.toThrow('check constraint')
    await expect(db.query('SELECT capture_gbp_review_health($1,4.5,-1,now())', [LOCATION])).rejects.toThrow('check constraint')
    const index = (await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='gbp_review_replies_voice_examples_idx'")).rows[0].indexdef
    expect(index).toContain('(approved_by_user_id, approved_at DESC, id DESC)')
  })

  it('revokes browser/public access despite broad default grants and enables RLS', async () => {
    for (const table of ['gbp_review_session_state', 'gbp_review_health_daily']) {
      expect((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [table])).rows).toEqual([{ relrowsecurity: true }])
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, table, privilege])).rows).toEqual([{ allowed: false }])
        }
      }
    }
    for (const fn of functions) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, fn])).rows)
          .toEqual([{ allowed: role === 'service_role' }])
      }
      expect((await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [fn])).rows)
        .toEqual([{ prosecdef: false, proconfig: ['search_path=public'] }])
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      try {
        await expect(db.query('SELECT * FROM gbp_review_session_state')).rejects.toThrow('permission denied')
        await expect(db.query('SELECT get_gbp_review_desk($1)', [ACTOR])).rejects.toThrow('permission denied')
      } finally { await db.exec('RESET ROLE') }
    }
  })

  it('executes all release functions as service_role with real approval/audit constraints', async () => {
    await db.exec('SET ROLE service_role')
    try {
      await db.query('SELECT capture_gbp_review_health($1,4.7123,3883,now())', [LOCATION])
      const desk = await db.query<{ result: { reviews: unknown[] } }>('SELECT get_gbp_review_desk($1) AS result', [ACTOR])
      expect(desk.rows[0].result.reviews).toHaveLength(5)
      const claim = await db.query<{ result: { attempt_id: string } }>('SELECT claim_gbp_reply_publish($1,$2,$3,true) AS result', [replyId(2), ACTOR, 'Synthetic Ulv edit'])
      await db.query('SELECT finish_gbp_reply_publish($1,$2,$3)', [replyId(2), claim.rows[0].result.attempt_id, ACTOR])
      expect((await db.query('SELECT status,approved_by_user_id,publish_attempt_id FROM gbp_review_replies WHERE id=$1', [replyId(2)])).rows)
        .toEqual([{ status: 'published', approved_by_user_id: ACTOR, publish_attempt_id: null }])
      expect((await db.query("SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY action", [replyId(2)])).rows)
        .toEqual([{ action: 'marketing.gbp_reply.approved' }, { action: 'marketing.gbp_reply.published' }])
    } finally { await db.exec('RESET ROLE') }
  })
})
