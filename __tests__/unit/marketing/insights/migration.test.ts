import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { migrationSql } from '../../../helpers/gbp-release-postgres'

// Self-contained, like paid-strategy/migration.test.ts: only the Supabase platform pieces and the three tables the policy reads are
// synthetic, so the real SQL is exercised without replaying unrelated history.
const MIGRATION = '20261013120000_cmo_insights.sql'
const uid = (n: number) => `66000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RUN = '77000000-0000-4000-8000-000000000001'
const INSIGHT = '88000000-0000-4000-8000-000000000001'
let db: PGlite
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    -- Model broad Supabase defaults: the migration must explicitly revoke access.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE TABLE public.app_users (id uuid PRIMARY KEY, auth_user_id uuid, email text, display_name text, role text, marketing_access boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.user_marketing_permissions (user_id uuid REFERENCES public.app_users(id), permission text, PRIMARY KEY (user_id, permission));
    CREATE FUNCTION public.get_my_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public.app_users WHERE auth_user_id = auth.uid() $$;
  `)
  await db.exec(migrationSql(MIGRATION))
  for (let n = 1; n <= 5; n++) {
    await db.query('INSERT INTO auth.users(id) VALUES ($1)', [uid(n)])
    await db.query(`INSERT INTO app_users(id,auth_user_id,email,display_name,role,marketing_access,active)
      VALUES ($1,$1,$2,'Synthetic reader',$3,$4,$5)`, [uid(n), `insights-${n}@example.invalid`, n === 1 ? 'SUPER_ADMIN' : 'MEMBER', n === 2 || n === 4, n !== 5])
  }
  await db.query(`INSERT INTO user_marketing_permissions(user_id,permission) VALUES ($1,'paid_manage'),($2,'paid_manage'),($3,'paid_manage')`, [uid(2), uid(3), uid(5)])
  await db.exec(`INSERT INTO marketing_insights(id,domain,origin_kind,kind,scope_key,title,statement,strength,peak_strength,trend,first_seen_at,last_seen_at,last_supported_at)
      VALUES ('${INSIGHT}','organic','creative_run','finding','organic:finding','Title','Statement','weak_signal','weak_signal','new','2026-10-01','2026-10-01','2026-10-01');
    INSERT INTO marketing_insight_observations(insight_id,source_kind,source_run_id,observed_at,strength,change,statement)
      VALUES ('${INSIGHT}','creative_run','${RUN}','2026-10-01','weak_signal','new','Statement');
    INSERT INTO marketing_insight_links(insight_id,target_type,target_run_id,target_index,relation)
      VALUES ('${INSIGHT}','paid_strategy_recommendation','${RUN}',1,'derived_from');`)
}, 60_000)
afterAll(async () => { await db?.close() })

async function asUser(n: number, check: () => Promise<void>) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(n)])
  await db.exec('SET ROLE authenticated')
  try { await check() } finally { await db.exec('RESET ROLE') }
}
const TABLES = ['marketing_insights', 'marketing_insight_observations', 'marketing_insight_links', 'marketing_insight_actions']

describe('CMO Insights real PostgreSQL migration', () => {
  it('replays after current main and grants reads to the same people as Creative Intelligence (active SUPER_ADMIN, or marketing access + paid_manage)', async () => {
    for (let n = 1; n <= 5; n++) await asUser(n, async () => {
      for (const table of TABLES) expect((await db.query(`SELECT * FROM ${table}`)).rows.length).toBe(n <= 2 ? (table === 'marketing_insight_actions' ? 0 : 1) : 0)
    })
  })
  it('denies anon entirely and every direct authenticated mutation, including SUPER_ADMIN', async () => {
    await db.exec('SET ROLE anon')
    try { for (const table of TABLES) await expect(db.query(`SELECT * FROM ${table}`)).rejects.toThrow('permission denied') } finally { await db.exec('RESET ROLE') }
    await asUser(1, async () => {
      for (const table of TABLES) {
        await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow('permission denied')
        await expect(db.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toThrow('permission denied')
        await expect(db.query(`UPDATE ${table} SET created_at = now()`)).rejects.toThrow('permission denied')
      }
    })
  })
  it('keeps the vocabularies closed: domain, kind, strength, trend, status, change, relation and link target', async () => {
    for (const sql of [
      "UPDATE marketing_insights SET domain='social'", "UPDATE marketing_insights SET origin_kind='morning_brief'", "UPDATE marketing_insights SET origin_kind=NULL", "UPDATE marketing_insights SET kind='recommendation'", "UPDATE marketing_insights SET strength='proven'",
      "UPDATE marketing_insights SET peak_strength='certain'", "UPDATE marketing_insights SET trend='rising'", "UPDATE marketing_insights SET status='retired'",
      "UPDATE marketing_insight_observations SET change='confirmed'", "UPDATE marketing_insight_observations SET source_kind='morning_brief'",
      "UPDATE marketing_insight_links SET relation='caused'", "UPDATE marketing_insight_links SET target_type='implementation'",
    ]) await expect(db.query(sql)).rejects.toThrow()
  })
  it('enforces sane values: counts, dates, text bounds and JSON bounds', async () => {
    for (const sql of [
      "UPDATE marketing_insights SET times_observed=0", "UPDATE marketing_insights SET runs_since_seen=-1",
      "UPDATE marketing_insights SET first_seen_at='2026-11-01'", "UPDATE marketing_insights SET title=''", "UPDATE marketing_insights SET statement=repeat('x',2001)",
      "UPDATE marketing_insights SET refs='{}'::jsonb", "UPDATE marketing_insights SET refs=(SELECT jsonb_agg('{}'::jsonb) FROM generate_series(1,31))",
    ]) await expect(db.query(sql)).rejects.toThrow()
  })
  it('admits an exact stable key only once per domain and kind, but allows many without one', async () => {
    await db.exec('SET ROLE service_role')
    try {
      const insert = (key: string | null) => db.query(`INSERT INTO marketing_insights(domain,origin_kind,kind,scope_key,stable_key,title,statement,strength,peak_strength,trend,first_seen_at,last_seen_at,last_supported_at)
        VALUES ('creative','creative_run','finding','creative:finding',$1,'T','S','weak_signal','weak_signal','new','2026-10-01','2026-10-01','2026-10-01')`, [key])
      await insert('creative:a|b')
      await expect(insert('creative:a|b')).rejects.toThrow('duplicate key')
      await insert(null); await insert(null)
    } finally { await db.exec('RESET ROLE') }
  })
  it('accepts the deterministic checklist as an origin and as an observation source', async () => {
    await db.exec('SET ROLE service_role')
    try {
      await db.query(`INSERT INTO marketing_insights(id,domain,origin_kind,kind,scope_key,stable_key,title,statement,strength,peak_strength,trend,first_seen_at,last_seen_at,last_supported_at)
        VALUES ('88000000-0000-4000-8000-000000000002','paid','meta_account_checks','finding','paid:finding:facebook_ads_check','facebook-ads:M-CR12','T','S','weak_signal','weak_signal','new','2026-10-01','2026-10-01','2026-10-01')`)
      await db.query(`INSERT INTO marketing_insight_observations(insight_id,source_kind,source_run_id,observed_at,strength,change,statement)
        VALUES ('88000000-0000-4000-8000-000000000002','meta_account_checks','${RUN}','2026-10-01','weak_signal','new','S')`)
      await db.query("DELETE FROM marketing_insights WHERE id='88000000-0000-4000-8000-000000000002'")
    } finally { await db.exec('RESET ROLE') }
  })
  it('keeps actions honest: one chosen option per draft, vocabularies closed, implement rows point at a recommendation, briefs carry a brief', async () => {
    await db.exec('SET ROLE service_role')
    try {
      const A = '99000000-0000-4000-8000-0000000000'
      const batch = '99000000-0000-4000-8000-0000000000b1'
      const insert = (n: number, over: { kind?: string; status?: string; brief?: string; run?: string; idx?: string; chosen?: string; outcome?: string } = {}) => db.query(
        `INSERT INTO marketing_insight_actions(id,insight_id,batch_id,kind,status,title,why,brief,target_run_id,target_index,chosen_at,outcome)
         VALUES ($1,'${INSIGHT}','${batch}',$2,$3,'Title','Why',${over.brief ?? 'NULL'},${over.run ?? 'NULL'},${over.idx ?? 'NULL'},${over.chosen ?? 'NULL'},${over.outcome ?? 'NULL'})`,
        [`${A}${String(n).padStart(2, '0')}`, over.kind ?? 'manual_task', over.status ?? 'proposed'])
      await insert(1); await insert(2)                                                                                // two drafts of one batch
      await expect(insert(3, { kind: 'bogus' })).rejects.toThrow()
      await expect(insert(3, { status: 'bogus' })).rejects.toThrow()
      await expect(insert(3, { kind: 'implement_recommendation' })).rejects.toThrow()                                 // needs a recommendation target
      await expect(insert(3, { kind: 'manual_task', run: `'${RUN}'`, idx: '1' })).rejects.toThrow()                  // only implement rows have one
      await expect(insert(3, { kind: 'content_brief' })).rejects.toThrow()                                           // a brief needs its brief
      await expect(insert(3, { brief: `'{"concept":"x"}'::jsonb` })).rejects.toThrow()                               // only a content brief has one
      await expect(insert(3, { status: 'chosen' })).rejects.toThrow()                                                // chosen needs chosen_at
      await expect(insert(3, { status: 'completed', chosen: 'now()' })).rejects.toThrow()                            // finished needs an outcome
      await insert(3, { kind: 'implement_recommendation', run: `'${RUN}'`, idx: '1' })
      await db.query(`UPDATE marketing_insight_actions SET status='chosen', chosen_at=now() WHERE id='${A}01'`)
      await expect(db.query(`UPDATE marketing_insight_actions SET status='chosen', chosen_at=now() WHERE id='${A}02'`)).rejects.toThrow('duplicate key') // the second choice loses
      await db.query(`UPDATE marketing_insight_actions SET status='not_chosen' WHERE id='${A}02'`)                    // siblings can be set aside
      await db.query(`UPDATE marketing_insight_actions SET status='completed', completed_at=now(), outcome='{"source":"task"}'::jsonb WHERE id='${A}01'`)
      await expect(db.query(`UPDATE marketing_insight_actions SET status='chosen', chosen_at=now() WHERE id='${A}03'`)).rejects.toThrow('duplicate key') // still one per draft once finished
    } finally { await db.exec('RESET ROLE') }
  })
  it('one task carries out at most one action, a deleted task only unlinks it, and a deleted insight takes its actions with it', async () => {
    await db.exec('SET ROLE service_role')
    try {
      const task = '77000000-0000-4000-8000-0000000000aa'
      await db.query('INSERT INTO tasks(id) VALUES ($1)', [task])
      const B = '99000000-0000-4000-8000-0000000000b2'
      const row = (id: string) => db.query(`INSERT INTO marketing_insight_actions(id,insight_id,batch_id,kind,status,title,why,linked_task_id,chosen_at) VALUES ($1,'${INSIGHT}',$2,'manual_task','chosen','T','W',$3,now())`, [id, B, task])
      await row('99000000-0000-4000-8000-0000000000c1')
      await expect(row('99000000-0000-4000-8000-0000000000c2')).rejects.toThrow('duplicate key')
      await db.query('DELETE FROM tasks WHERE id=$1', [task])
      expect((await db.query("SELECT linked_task_id FROM marketing_insight_actions WHERE id='99000000-0000-4000-8000-0000000000c1'")).rows[0]).toEqual({ linked_task_id: null })
    } finally { await db.exec('RESET ROLE') }
  })
  it('records one observation per insight and source run, so a replayed capture cannot double count', async () => {
    await db.exec('SET ROLE service_role')
    try {
      const sql = `INSERT INTO marketing_insight_observations(insight_id,source_kind,source_run_id,observed_at,strength,change,statement)
        VALUES ('${INSIGHT}','creative_run','${RUN}','2026-10-02','weak_signal','reconfirmed','S')`
      await expect(db.query(sql)).rejects.toThrow('duplicate key')
      await db.query(`${sql} ON CONFLICT (insight_id, source_kind, source_run_id) DO NOTHING`)
      expect((await db.query('SELECT 1 FROM marketing_insight_observations')).rows).toHaveLength(1)
    } finally { await db.exec('RESET ROLE') }
  })
  it('requires a recommendation index exactly for recommendation links, and keeps links idempotent (NULL index counts as one slot)', async () => {
    await db.exec('SET ROLE service_role')
    try {
      const link = (type: string, index: number | null, relation = 'informed') => db.query(
        `INSERT INTO marketing_insight_links(insight_id,target_type,target_run_id,target_index,relation) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (insight_id,target_type,target_run_id,target_slot,relation) DO NOTHING`, [INSIGHT, type, RUN, index, relation])
      await expect(link('paid_strategy_recommendation', null)).rejects.toThrow()
      await expect(link('paid_strategy_run', 2)).rejects.toThrow()
      await link('paid_strategy_run', null); await link('paid_strategy_run', null)
      await link('paid_strategy_recommendation', 1, 'derived_from') // the seeded one again: no-op
      expect((await db.query("SELECT 1 FROM marketing_insight_links WHERE relation='informed'")).rows).toHaveLength(1)
      expect((await db.query('SELECT 1 FROM marketing_insight_links')).rows).toHaveLength(2)
    } finally { await db.exec('RESET ROLE') }
  })
  it('removes an insight’s history and links with it, and ties history to a real insight', async () => {
    await db.exec('SET ROLE service_role')
    try {
      await expect(db.query(`INSERT INTO marketing_insight_observations(insight_id,source_kind,source_run_id,observed_at,strength,change,statement)
        VALUES (gen_random_uuid(),'creative_run','${RUN}','2026-10-02','weak_signal','new','S')`)).rejects.toThrow()
      await db.query(`DELETE FROM marketing_insights WHERE id='${INSIGHT}'`)
      expect((await db.query('SELECT 1 FROM marketing_insight_observations')).rows).toHaveLength(0)
      expect((await db.query('SELECT 1 FROM marketing_insight_links')).rows).toHaveLength(0)
    } finally { await db.exec('RESET ROLE') }
  })
})
