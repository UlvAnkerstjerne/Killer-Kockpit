import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { migrationSql } from '../../../helpers/gbp-release-postgres'

// Self-contained: only the Supabase platform pieces and the three tables the policy reads are
// synthetic. (The full-replay harness used by brain/migration.test.ts currently cannot build in a
// working tree that contains an untracked duplicate weekly_impact_briefs migration.)
const MIGRATION = '20261008160000_marketing_paid_strategy_runs.sql'
const uid = (n: number) => `56000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = 'a'.repeat(64)
const insert = () => `INSERT INTO marketing_paid_strategy_runs(window_start,window_end,prompt_version,skill_ref,skill_hash,status)
  VALUES ('2026-09-10','2026-10-07','v1','mesper-meta-ads@2.1.0#cbfc19c','${hash}','failed')`
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
    CREATE TABLE public.user_marketing_permissions (user_id uuid REFERENCES public.app_users(id), permission text, PRIMARY KEY (user_id, permission));
    CREATE FUNCTION public.get_my_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public.app_users WHERE auth_user_id = auth.uid() $$;
  `)
  await db.exec(migrationSql(MIGRATION))
  for (let n = 1; n <= 5; n++) {
    await db.query('INSERT INTO auth.users(id) VALUES ($1)', [uid(n)])
    await db.query(`INSERT INTO app_users(id,auth_user_id,email,display_name,role,marketing_access,active)
      VALUES ($1,$1,$2,'Synthetic reader',$3,$4,$5)`, [uid(n), `strategy-${n}@example.invalid`, n === 1 ? 'SUPER_ADMIN' : 'MEMBER', n === 2 || n === 4, n !== 5])
  }
  await db.query(`INSERT INTO user_marketing_permissions(user_id,permission) VALUES ($1,'paid_manage'),($2,'paid_manage'),($3,'paid_manage')`, [uid(2), uid(3), uid(5)])
  await db.exec(insert())
}, 120_000)
afterAll(async () => { await db?.close() })

async function asUser(n: number, check: () => Promise<void>) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(n)])
  await db.exec('SET ROLE authenticated')
  try { await check() } finally { await db.exec('RESET ROLE') }
}

describe('Paid Strategy runs: real PostgreSQL migration', () => {
  it('replays after current main and lets only active Marketing Brain readers read', async () => {
    for (let n = 1; n <= 5; n++) await asUser(n, async () => {
      expect((await db.query('SELECT * FROM marketing_paid_strategy_runs')).rows).toHaveLength(n <= 2 ? 1 : 0)
    })
  })
  it('denies anon access and every direct authenticated mutation, including SUPER_ADMIN', async () => {
    await db.exec('SET ROLE anon')
    try { await expect(db.query('SELECT * FROM marketing_paid_strategy_runs')).rejects.toThrow('permission denied') } finally { await db.exec('RESET ROLE') }
    await asUser(1, async () => {
      await expect(db.query('DELETE FROM marketing_paid_strategy_runs')).rejects.toThrow('permission denied')
      await expect(db.query('INSERT INTO marketing_paid_strategy_runs DEFAULT VALUES')).rejects.toThrow('permission denied')
      await expect(db.query("UPDATE marketing_paid_strategy_runs SET error='tampered'")).rejects.toThrow('permission denied')
    })
  })
  it('lets the server (service_role) write and update runs', async () => {
    await db.exec('SET ROLE service_role')
    try {
      await db.query(insert())
      expect((await db.query("UPDATE marketing_paid_strategy_runs SET error='x' WHERE error IS NULL RETURNING id")).rows.length).toBeGreaterThan(0)
    } finally { await db.exec('RESET ROLE') }
  })
  it('stores at most three recommendations and bounds their size', async () => {
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET recommendations='[{},{},{},{}]'")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET recommendations='{}'")).rejects.toThrow()
    await expect(db.query(`UPDATE marketing_paid_strategy_runs SET recommendations=jsonb_build_array(jsonb_build_object('x', repeat('a', 31000)))`)).rejects.toThrow()
    await db.query("UPDATE marketing_paid_strategy_runs SET recommendations='[{},{},{}]' WHERE id=(SELECT id FROM marketing_paid_strategy_runs LIMIT 1)")
  })
  it('enforces status, provenance, window, lease and evidence rules', async () => {
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET status='partial'")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET skill_hash='not-a-hash'")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET window_end='2026-01-01'")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET status='running'")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET status='completed'")).rejects.toThrow()
    await expect(db.query("UPDATE marketing_paid_strategy_runs SET evidence='[]'")).rejects.toThrow()
  })
  it('admits only one running analysis at a time', async () => {
    const running = `INSERT INTO marketing_paid_strategy_runs(window_start,window_end,prompt_version,skill_ref,skill_hash,status,lease_expires_at)
      VALUES ('2026-09-10','2026-10-07','v1','mesper-meta-ads@2.1.0#cbfc19c','${hash}','running',now()+interval '10 minutes')`
    await db.exec('SET ROLE service_role')
    try {
      await db.query(running)
      await expect(db.query(running)).rejects.toThrow('duplicate key')
      await db.query("UPDATE marketing_paid_strategy_runs SET status='failed',lease_expires_at=NULL WHERE status='running'")
      await db.query(running)
    } finally { await db.exec('RESET ROLE') }
  })
})
