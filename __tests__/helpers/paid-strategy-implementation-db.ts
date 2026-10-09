import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { migrationSql } from './gbp-release-postgres'
import { postgresClient } from './gbp-postgres-client'
import { run } from './paid-strategy'
import { ACCOUNT, adSets, budget, campaigns, creative, evidenceCampaigns, newCampaign, tracking } from './paid-strategy-implementation'

export const uid = (n: number) => `57000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const RUN_OLD = '58000000-0000-4000-8000-000000000001'
export const RUN_NEW = '58000000-0000-4000-8000-000000000002'
export const HASH = 'a'.repeat(64)
export const evidence = (headroom: number | null = 8800, reliable = true) => ({
  campaigns: evidenceCampaigns,
  budget: { monthly_ceiling: 15000, projection: { reliable, projected_incremental_headroom: headroom, projected_month_end_spend: 6200 } },
  data_gaps: [],
})

/** Real PostgreSQL: the two real migrations plus only the platform tables they depend on, synthetic and minimal. */
export async function implementationDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE TABLE public.app_users (id uuid PRIMARY KEY, auth_user_id uuid, email text, display_name text, role text, marketing_access boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.user_marketing_permissions (user_id uuid REFERENCES public.app_users(id), permission text, PRIMARY KEY (user_id, permission));
    CREATE FUNCTION public.get_my_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public.app_users WHERE auth_user_id = auth.uid() $$;
    CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text, owner_user_id uuid, project_id uuid, status text NOT NULL DEFAULT 'open', priority smallint, due_at timestamptz, created_by_user_id uuid);
    CREATE TABLE public.audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid, actor_type text, action text, entity_type text, entity_id uuid, before_json jsonb, after_json jsonb, created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION public.create_task_and_audit(p_title text, p_description text, p_owner_user_id uuid, p_project_id uuid, p_status text, p_priority smallint, p_due_at timestamptz, p_created_by_user_id uuid, p_actor_user_id uuid, p_meeting_id uuid DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE v uuid; BEGIN
      INSERT INTO tasks(title,description,owner_user_id,project_id,status,priority,due_at,created_by_user_id) VALUES (p_title,p_description,p_owner_user_id,p_project_id,p_status,p_priority,p_due_at,p_created_by_user_id) RETURNING id INTO v;
      INSERT INTO audit_events(actor_user_id,actor_type,action,entity_type,entity_id) VALUES (p_actor_user_id,'human','task.created','task',v);
      RETURN v; END $$;
    CREATE TABLE public.meta_ad_accounts (id text PRIMARY KEY, currency text NOT NULL);
    CREATE TABLE public.meta_ad_campaigns (id text PRIMARY KEY, ad_account_id text NOT NULL, name text NOT NULL, status text NOT NULL, daily_budget numeric);
    CREATE TABLE public.meta_ad_sets (id text PRIMARY KEY, campaign_id text NOT NULL, name text NOT NULL, status text NOT NULL, daily_budget numeric);
  `)
  await db.exec(migrationSql('20261008160000_marketing_paid_strategy_runs.sql'))
  await db.exec(migrationSql('20261009120000_marketing_paid_strategy_implementations.sql'))
  for (let n = 1; n <= 6; n++) {
    await db.query('INSERT INTO auth.users(id) VALUES ($1)', [uid(n)])
    await db.query(`INSERT INTO app_users(id,auth_user_id,email,display_name,role,marketing_access,active) VALUES ($1,$1,$2,$3,$4,$5,$6)`,
      [uid(n), `u${n}@example.invalid`, ['Admin', 'Approver', 'Manager', 'Outsider', 'Inactive', 'Owner'][n - 1], n === 1 ? 'SUPER_ADMIN' : 'MEMBER', n === 2 || n === 3, n !== 5])
  }
  await db.query("INSERT INTO user_marketing_permissions(user_id,permission) VALUES ($1,'paid_manage'),($1,'paid_approve'),($2,'paid_manage')", [uid(2), uid(3)])
  await db.query("INSERT INTO meta_ad_accounts VALUES ($1,'DKK')", [ACCOUNT])
  for (const c of campaigns) await db.query('INSERT INTO meta_ad_campaigns VALUES ($1,$2,$3,$4,$5)', [c.id, c.ad_account_id, c.name, c.status, c.daily_budget])
  for (const s of adSets) await db.query('INSERT INTO meta_ad_sets VALUES ($1,$2,$3,$4,$5)', [s.id, s.campaign_id, s.name, s.status, s.daily_budget])
  return db
}

export async function seedRun(db: PGlite, id: string, generatedAt: string, over: { headroom?: number | null; reliable?: boolean; recommendations?: unknown[]; status?: string } = {}) {
  const recs = over.recommendations ?? [tracking, creative, newCampaign]
  await db.query(`INSERT INTO marketing_paid_strategy_runs(id,status,generated_at,started_at,window_start,window_end,prompt_version,skill_ref,skill_hash,evidence,recommendations,lease_expires_at)
    VALUES ($1,$2,$3,$3,'2026-09-10','2026-10-07','v1','mesper@2.1.0',$4,$5,$6,NULL)`,
    [id, over.status ?? 'completed', generatedAt, HASH, JSON.stringify(evidence(over.headroom === undefined ? 8800 : over.headroom, over.reliable ?? true)), JSON.stringify(recs)])
}
export { run, budget }
export const client = (db: PGlite) => postgresClient(db)
