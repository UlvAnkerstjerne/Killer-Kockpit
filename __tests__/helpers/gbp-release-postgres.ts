import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync, readdirSync } from 'node:fs'

export const REVIEW_DESK_RELEASE = [
  '20260923194341_gbp_review_health_daily.sql',
  '20260923194557_gbp_review_desk.sql',
  '20260923200449_gbp_reply_voice_examples.sql',
]
export const migrationSql = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8')

/** Replay every migration preceding this release, unchanged. Only the Supabase
 * auth platform and data prerequisites for two historical seed migrations are
 * synthetic. No connection, environment variables or production data are used. */
export async function mainSchemaDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } })
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      -- Model broad Supabase defaults: the release must explicitly revoke access.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `)
    const files = readdirSync('supabase/migrations')
      .filter(file => file.endsWith('.sql') && file < REVIEW_DESK_RELEASE[0]).sort()
    for (const file of files) {
      if (file === '035_initial_directory.sql') {
        // This seed references five pre-existing app users by ID. Supply only
        // those keys, with synthetic names/emails, to exercise its real FKs.
        const ids = migrationSql(file).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g) ?? []
        for (const id of ids) await db.query(
          "INSERT INTO app_users (id,email,display_name) VALUES ($1,$2,'Synthetic prerequisite')",
          [id, `${id}@example.invalid`],
        )
      }
      if (file === '20260923000000_audit_add_egenkontrol_and_top_heater.sql') {
        await db.exec(`INSERT INTO audit_templates (audit_key,title,status)
          VALUES ('operational_audit','Synthetic prerequisite','published')`)
      }
      await db.exec(migrationSql(file))
    }
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}
