import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { readdirSync } from 'node:fs'
import { mainSchemaDatabase, migrationSql, REVIEW_DESK_RELEASE } from '../../../helpers/gbp-release-postgres'

const MIGRATION = '20260924150815_marketing_creative_intelligence.sql'
const uid = (n: number) => `55000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let db: PGlite
beforeAll(async () => {
  db = await mainSchemaDatabase()
  for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f >= REVIEW_DESK_RELEASE[0] && f <= MIGRATION).sort()) await db.exec(migrationSql(file))
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$`)
  for (let n = 1; n <= 5; n++) {
    await db.query('INSERT INTO auth.users(id) VALUES ($1)', [uid(n)])
    await db.query(`INSERT INTO app_users(id,auth_user_id,email,display_name,role,marketing_access,active)
      VALUES ($1,$1,$2,'Synthetic reader',$3,$4,$5)`, [uid(n), `brain-${n}@example.invalid`, n === 1 ? 'SUPER_ADMIN' : 'MEMBER', n === 2 || n === 4, n !== 5])
  }
  await db.query(`INSERT INTO user_marketing_permissions(user_id,permission) VALUES ($1,'paid_manage'),($2,'paid_manage'),($3,'paid_manage')`, [uid(2), uid(3), uid(5)])
  await db.exec(`INSERT INTO meta_ig_media(id,ig_account_id,media_type) VALUES ('synthetic','synthetic','VIDEO');
    INSERT INTO marketing_content_fingerprints(platform,media_id,classification_version,source_hash,ai_model,prompt_version,
      hook_type,hook_source,primary_theme,product_focus,creative_format,presentation_style,human_presence,language,cta_type,confidence)
    VALUES ('instagram','synthetic','creative-v1',repeat('a',64),'synthetic','v1','unknown','unknown','other','unknown','reel_video','unknown','unknown','unknown','unknown','low');
    INSERT INTO marketing_creative_intelligence_runs(analysis_start,analysis_end,prompt_version,classification_version,status,analytics)
      VALUES ('2026-06-26','2026-09-24','v1','creative-v1','completed','{}');`)
}, 60_000)
afterAll(async () => { await db?.close() })

async function asUser(n: number, check: () => Promise<void>) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(n)])
  await db.exec('SET ROLE authenticated')
  try { await check() } finally { await db.exec('RESET ROLE') }
}
describe('Creative Brain real PostgreSQL migration', () => {
  it('replays after current main and grants reads to active Organic readers only', async () => {
    for (let n = 1; n <= 5; n++) await asUser(n, async () => {
      for (const table of ['marketing_content_fingerprints', 'marketing_creative_intelligence_runs']) {
        expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(n <= 2 ? 1 : 0)
      }
    })
  })
  it('denies anon reads and all direct authenticated mutations, including SUPER_ADMIN', async () => {
    await db.exec('SET ROLE anon')
    try { await expect(db.query('SELECT * FROM marketing_content_fingerprints')).rejects.toThrow('permission denied') } finally { await db.exec('RESET ROLE') }
    await asUser(1, async () => {
      for (const table of ['marketing_content_fingerprints', 'marketing_creative_intelligence_runs']) {
        await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow('permission denied')
        await expect(db.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toThrow('permission denied')
        await expect(db.query(`UPDATE ${table} SET classification_version='tampered'`)).rejects.toThrow('permission denied')
      }
    })
  })
  it('enforces taxonomy, provenance, hook honesty, foreign keys and one current item', async () => {
    await expect(db.query("UPDATE marketing_content_fingerprints SET primary_theme='invented'" )).rejects.toThrow()
    await expect(db.query("UPDATE marketing_content_fingerprints SET source_hash='invalid'" )).rejects.toThrow()
    await expect(db.query("UPDATE marketing_content_fingerprints SET hook_type='question'" )).rejects.toThrow()
    await expect(db.query("UPDATE marketing_content_fingerprints SET media_id='missing'" )).rejects.toThrow()
    await expect(db.query("UPDATE marketing_content_fingerprints SET secondary_themes=ARRAY['other']" )).rejects.toThrow()
    await expect(db.query(`INSERT INTO marketing_content_fingerprints
      SELECT (jsonb_populate_record(NULL::marketing_content_fingerprints,to_jsonb(f)||jsonb_build_object('id',gen_random_uuid()))).*
      FROM marketing_content_fingerprints f`)).rejects.toThrow('platform_media_id_key')
  })
  it('bounds JSON observations and admits only one running refresh', async () => {
    await expect(db.query("UPDATE marketing_creative_intelligence_runs SET observations='[{},{},{},{},{},{}]'" )).rejects.toThrow()
    const insert = `INSERT INTO marketing_creative_intelligence_runs(analysis_start,analysis_end,prompt_version,classification_version,status,lease_expires_at)
      VALUES ('2026-06-26','2026-09-24','v1','creative-v1','running',now()+interval '5 minutes')`
    await db.exec('SET ROLE service_role')
    try {
      await db.query(insert)
      await expect(db.query(insert)).rejects.toThrow('duplicate key')
      await db.query("UPDATE marketing_creative_intelligence_runs SET status='failed',lease_expires_at=NULL WHERE status='running'")
      await db.query(insert)
    } finally { await db.exec('RESET ROLE') }
  })
})
