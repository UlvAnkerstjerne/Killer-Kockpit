import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { implementationDatabase, RUN_NEW, RUN_OLD, seedRun, uid } from '../../../../helpers/paid-strategy-implementation-db'

let db: PGlite
const claim = async (run: string, index: number, actor: number, mode: string, budget: number, id = 'x') =>
  (await db.query<{ r: Record<string, unknown> }>('SELECT approve_paid_strategy_implementation($1,$2::smallint,$3,$4,$5,$6::jsonb,$7::jsonb) AS r', [run, index, uid(actor), mode, budget, JSON.stringify({ id }), JSON.stringify({}) ])).rows[0].r
const prepare = (run: string, index: number, mode = 'campaign_creation') =>
  db.query(`INSERT INTO marketing_paid_strategy_implementations(strategy_run_id,recommendation_index,recommendation_snapshot,implementation_mode,status,prepared_by_user_id) VALUES ($1,$2,'{}',$3,'prepared',$4)`, [run, index, mode, uid(2)])
const asUser = async (n: number, check: () => Promise<void>) => {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(n)])
  await db.exec('SET ROLE authenticated')
  try { await check() } finally { await db.exec('RESET ROLE') }
}

beforeAll(async () => {
  db = await implementationDatabase()
  await seedRun(db, RUN_OLD, '2026-10-01T10:00:00Z')
  await seedRun(db, RUN_NEW, '2026-10-08T10:00:00Z', { headroom: 8800 })
}, 120_000)
afterAll(async () => { await db?.close() })

describe('Paid Strategy implementations: real PostgreSQL migration', () => {
  it('replays after the Paid Strategy runs migration and enforces one implementation per run + recommendation', async () => {
    await prepare(RUN_NEW, 0, 'tracking_execution')
    await expect(prepare(RUN_NEW, 0, 'tracking_execution')).rejects.toThrow(/paid_strategy_implementation_once|unique/i)
    await prepare(RUN_NEW, 1, 'creative_execution'); await prepare(RUN_NEW, 2)
    await expect(prepare(RUN_NEW, 3)).rejects.toThrow() // index is 0..2
  })
  it('validates mode, status, shape and the reservation rules', async () => {
    const bad = (set: string) => db.query(`UPDATE marketing_paid_strategy_implementations SET ${set} WHERE recommendation_index = 0 AND strategy_run_id = '${RUN_NEW}'`)
    await expect(bad("implementation_mode = 'create_meta_campaign'")).rejects.toThrow()
    await expect(bad("status = 'launched'")).rejects.toThrow()
    await expect(bad("compiled = '[]'")).rejects.toThrow()
    await expect(bad('budget_reserved_dkk = 20000')).rejects.toThrow()
    await expect(bad('budget_reserved_dkk = 5')).rejects.toThrow() // only an approved implementation can hold budget
    await expect(bad("status = 'started'")).rejects.toThrow() // started requires an approver and approval time
  })
  it('lets only active Paid Strategy readers read, and nobody write through the user JWT', async () => {
    await asUser(1, async () => { expect((await db.query('SELECT * FROM marketing_paid_strategy_implementations')).rows.length).toBe(3) })
    await asUser(3, async () => { expect((await db.query('SELECT * FROM marketing_paid_strategy_implementations')).rows.length).toBe(3) })
    for (const n of [4, 5, 6]) await asUser(n, async () => { expect((await db.query('SELECT * FROM marketing_paid_strategy_implementations')).rows).toHaveLength(0) })
    await db.exec('SET ROLE anon')
    try { await expect(db.query('SELECT * FROM marketing_paid_strategy_implementations')).rejects.toThrow('permission denied') } finally { await db.exec('RESET ROLE') }
    await asUser(1, async () => {
      await expect(db.query("UPDATE marketing_paid_strategy_implementations SET status='completed'")).rejects.toThrow('permission denied')
      await expect(db.query('DELETE FROM marketing_paid_strategy_implementations')).rejects.toThrow('permission denied')
      await expect(prepare(RUN_NEW, 0)).rejects.toThrow('permission denied')
      await expect(db.query('SELECT approve_paid_strategy_implementation($1,0::smallint,$2,$3,0,$4::jsonb,$4::jsonb)', [RUN_NEW, uid(1), 'tracking_execution', '{}'])).rejects.toThrow('permission denied')
    })
  })
})

describe('approve_paid_strategy_implementation', () => {
  it('refuses an unprepared recommendation, an invalid mode and an inactive actor', async () => {
    await seedRun(db, '58000000-0000-4000-8000-000000000003', '2026-10-09T09:00:00Z') // newest -> RUN_NEW is now superseded
    await db.query("DELETE FROM marketing_paid_strategy_runs WHERE id = '58000000-0000-4000-8000-000000000003'")
    expect((await claim(RUN_NEW, 0, 2, 'needs_input', 0)).result).toBe('invalid_mode')
    expect((await claim(RUN_NEW, 0, 5, 'tracking_execution', 0)).result).toBe('actor_inactive')
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', -1)).result).toBe('invalid_budget')
    await db.query("DELETE FROM marketing_paid_strategy_implementations WHERE recommendation_index = 2 AND strategy_run_id = $1", [RUN_NEW])
    expect((await claim(RUN_NEW, 2, 2, 'campaign_creation', 0)).result).toBe('not_prepared')
    await prepare(RUN_NEW, 2)
  })
  it('refuses a run that is not the latest completed one', async () => {
    await prepare(RUN_OLD, 0, 'tracking_execution')
    expect((await claim(RUN_OLD, 0, 2, 'tracking_execution', 0)).result).toBe('superseded')
    expect((await db.query("SELECT status FROM marketing_paid_strategy_implementations WHERE strategy_run_id = $1", [RUN_OLD])).rows[0]).toEqual({ status: 'prepared' })
  })
  it('claims once: a second claim is a no-op that reports the current state, and writes one audit event', async () => {
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)).result).toBe('claimed')
    const again = await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)
    expect(again).toMatchObject({ result: 'already_claimed', status: 'approved' })
    const audit = (await db.query("SELECT count(*)::int AS n, max(after_json->>'mode') AS mode FROM audit_events WHERE action = 'marketing.paid_strategy_implementation.approved'")).rows[0]
    expect(audit).toEqual({ n: 1, mode: 'tracking_execution' })
  })
  it('serialises concurrent claims so only one wins', async () => {
    const results = await Promise.all([claim(RUN_NEW, 1, 2, 'creative_execution', 0), claim(RUN_NEW, 1, 3, 'creative_execution', 0)])
    expect(results.map(r => r.result).sort()).toEqual(['already_claimed', 'claimed'])
  })
  it('reserves budget against the run\'s own stored headroom and keeps the sum under it', async () => {
    expect((await claim(RUN_NEW, 2, 2, 'campaign_creation', 6000)).result).toBe('claimed')
    expect(Number((await db.query<{ r: string }>('SELECT paid_strategy_reserved_dkk() AS r')).rows[0].r)).toBe(6000)
  })
  it('rejects an amount above remaining headroom, and any amount when headroom is null or unreliable', async () => {
    await db.query("UPDATE marketing_paid_strategy_implementations SET status='prepared', budget_reserved_dkk=0, approved_at=NULL WHERE strategy_run_id=$1 AND recommendation_index=1", [RUN_NEW])
    expect(await claim(RUN_NEW, 1, 2, 'creative_execution', 3000)).toMatchObject({ result: 'exceeds_headroom', available: 2800 })
    expect((await claim(RUN_NEW, 1, 2, 'creative_execution', 2800)).result).toBe('claimed')
    expect(Number((await db.query<{ r: string }>('SELECT paid_strategy_reserved_dkk() AS r')).rows[0].r)).toBe(8800) // exactly the headroom, never beyond
    for (const [headroom, reliable] of [[null, true], [8800, false]] as const) {
      const id = `58000000-0000-4000-8000-00000000009${reliable ? 1 : 2}`
      await seedRun(db, id, '2026-10-09T11:00:00Z', { headroom, reliable })
      await prepare(id, 0, 'campaign_creation')
      expect((await claim(id, 0, 2, 'campaign_creation', 1)).result).toBe('headroom_unreliable')
      expect((await claim(id, 0, 2, 'campaign_creation', 0)).result).toBe('claimed') // a 0 DKK start never needs headroom
      await db.query("DELETE FROM marketing_paid_strategy_implementations WHERE strategy_run_id = $1", [id])
      await db.query("DELETE FROM marketing_paid_strategy_runs WHERE id = $1", [id])
    }
  })
  it('releases reservations when the work completes, is cancelled or fails', async () => {
    const reserved = async () => Number((await db.query<{ r: string }>('SELECT paid_strategy_reserved_dkk() AS r')).rows[0].r)
    expect(await reserved()).toBe(8800)
    const task = (await db.query<{ id: string }>("INSERT INTO tasks(title,status) VALUES ('t','open') RETURNING id")).rows[0].id
    await db.query("UPDATE marketing_paid_strategy_implementations SET linked_task_id=$1, status='started' WHERE strategy_run_id=$2 AND recommendation_index=2", [task, RUN_NEW])
    expect(await reserved()).toBe(8800) // started and open: still reserved
    await db.query("UPDATE tasks SET status='done' WHERE id=$1", [task])
    expect(await reserved()).toBe(2800) // task done: settled, spend is now visible in the projection
    await db.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [task])
    expect(await reserved()).toBe(2800)
    await db.query("UPDATE marketing_paid_strategy_implementations SET status='cancelled' WHERE strategy_run_id=$1 AND recommendation_index=1", [RUN_NEW])
    expect(await reserved()).toBe(0)
    await db.query("UPDATE marketing_paid_strategy_implementations SET status='failed' WHERE strategy_run_id=$1 AND recommendation_index=0", [RUN_NEW])
    expect(await reserved()).toBe(0)
  })
  it('lets a cleanly failed implementation (no task) be claimed again, but never one that already has a task', async () => {
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)).result).toBe('claimed')
    const task = (await db.query<{ id: string }>("INSERT INTO tasks(title) VALUES ('t2') RETURNING id")).rows[0].id
    await db.query("UPDATE marketing_paid_strategy_implementations SET status='failed', linked_task_id=$1 WHERE strategy_run_id=$2 AND recommendation_index=0", [task, RUN_NEW])
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)).result).toBe('already_claimed')
  })
})

describe('autonomous execution migration (state machine, ledger, creative drafts)', () => {
  const setStatus = (status: string, index: number, extra = '') => db.query(`UPDATE marketing_paid_strategy_implementations SET status='${status}', approved_at=COALESCE(approved_at, now()) ${extra} WHERE strategy_run_id=$1 AND recommendation_index=$2`, [RUN_NEW, index])
  const reserved = async () => Number((await db.query<{ r: string }>('SELECT paid_strategy_reserved_dkk() AS r')).rows[0].r)

  it('accepts every execution status and mode, and still rejects anything invented', async () => {
    for (const status of ['planning', 'executing', 'verifying', 'waiting_for_input', 'waiting_for_access', 'ready_to_activate', 'in_motion', 'completed', 'cancelled', 'needs_attention', 'failed']) await setStatus(status, 1)
    for (const mode of ['tracking_execution', 'creative_execution', 'campaign_creation', 'platform_action', 'needs_input']) await db.query(`UPDATE marketing_paid_strategy_implementations SET implementation_mode='${mode}' WHERE strategy_run_id=$1 AND recommendation_index=1`, [RUN_NEW])
    await expect(setStatus('launched', 1)).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_implementations SET implementation_mode='create_meta_campaign_directly'")).rejects.toThrow()
  })
  it('a running or finished state always has an approver and approval time; a prepared one does not need them', async () => {
    await db.query("UPDATE marketing_paid_strategy_implementations SET status='prepared', approved_at=NULL, budget_reserved_dkk=0 WHERE recommendation_index=1")
    await expect(db.query("UPDATE marketing_paid_strategy_implementations SET status='ready_to_activate' WHERE recommendation_index=1")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_implementations SET status='waiting_for_access' WHERE recommendation_index=1")).rejects.toThrow()
  })
  it('keeps a step ledger, bounded and object-shaped', async () => {
    await db.query(`UPDATE marketing_paid_strategy_implementations SET execution='{"version":"v1","steps":[]}' WHERE recommendation_index=1`)
    await expect(db.query("UPDATE marketing_paid_strategy_implementations SET execution='[]' WHERE recommendation_index=1")).rejects.toThrow()
  })
  it('budget stays reserved while work waits on a person or is ready to activate, and is released on cancel or failure', async () => {
    await db.query("UPDATE marketing_paid_strategy_implementations SET budget_reserved_dkk=0, status='cancelled', approved_at=now()")
    await db.query("UPDATE marketing_paid_strategy_implementations SET budget_reserved_dkk=500, linked_task_id=NULL WHERE recommendation_index=1")
    for (const status of ['approved', 'planning', 'executing', 'verifying', 'waiting_for_input', 'waiting_for_access', 'ready_to_activate', 'in_motion', 'needs_attention']) { await setStatus(status, 1); expect(await reserved(), status).toBe(500) }
    for (const status of ['completed', 'cancelled', 'failed']) { await setStatus(status, 1); expect(await reserved(), status).toBe(0) }
  })
  it('claims only the new execution modes; the v1 task modes are no longer admissible', async () => {
    await db.query("DELETE FROM marketing_paid_strategy_implementations WHERE strategy_run_id=$1", [RUN_NEW])
    await prepare(RUN_NEW, 0, 'tracking_execution')
    expect((await claim(RUN_NEW, 0, 2, 'implementation_task', 0)).result).toBe('invalid_mode')
    expect((await claim(RUN_NEW, 0, 2, 'creative_task', 0)).result).toBe('invalid_mode')
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)).result).toBe('claimed')
  })
  it('a failed implementation can be claimed again only when it created nothing outside', async () => {
    await db.query(`UPDATE marketing_paid_strategy_implementations SET status='failed', execution='{"version":"v1","steps":[{"key":"preflight","status":"failed"}]}' WHERE recommendation_index=0`)
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)).result).toBe('claimed')
    await db.query(`UPDATE marketing_paid_strategy_implementations SET status='failed', execution='{"version":"v1","steps":[{"key":"create_campaign","status":"done","externalId":"9"}]}' WHERE recommendation_index=0`)
    expect((await claim(RUN_NEW, 0, 2, 'tracking_execution', 0)).result).toBe('already_claimed') // something exists in Meta: resume, never re-admit
  })
  it('creative drafts: one per implementation, bounded, readable only by Paid Strategy readers, writable only by the server', async () => {
    const id = (await db.query<{ id: string }>("SELECT id FROM marketing_paid_strategy_implementations WHERE recommendation_index=0")).rows[0].id
    const draft = (cta = 'GET_QUOTE') => db.query(`INSERT INTO marketing_paid_strategy_creative_drafts(implementation_id,title,angle,primary_text,headline,description,cta) VALUES ($1,'t','a','p','h','d','${cta}')`, [id])
    await db.exec('SET ROLE service_role'); try { await draft() } finally { await db.exec('RESET ROLE') }
    await expect(draft()).rejects.toThrow(/unique|duplicate/i)
    await expect(draft('BUY_NOW')).rejects.toThrow()
    await asUser(1, async () => { expect((await db.query('SELECT * FROM marketing_paid_strategy_creative_drafts')).rows).toHaveLength(1) })
    await asUser(4, async () => { expect((await db.query('SELECT * FROM marketing_paid_strategy_creative_drafts')).rows).toHaveLength(0) })
    await asUser(1, async () => {
      await expect(db.query("UPDATE marketing_paid_strategy_creative_drafts SET headline='x'")).rejects.toThrow('permission denied')
      await expect(db.query("INSERT INTO marketing_paid_strategy_creative_drafts(implementation_id,title,angle,primary_text,headline,description,cta) VALUES (gen_random_uuid(),'t','a','p','h','d','SEE_MENU')")).rejects.toThrow('permission denied')
    })
    await db.exec('SET ROLE anon'); try { await expect(db.query('SELECT * FROM marketing_paid_strategy_creative_drafts')).rejects.toThrow('permission denied') } finally { await db.exec('RESET ROLE') }
  })
})
