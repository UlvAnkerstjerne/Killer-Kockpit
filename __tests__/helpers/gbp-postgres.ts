import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

/** Real PostgreSQL in memory, with synthetic users/reviews. No network or secrets.
 * Load the original GBP schema plus the feature migrations under test. */
export async function reviewDatabase(migrations: string[]) {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE app_users (id uuid PRIMARY KEY, role text, active boolean DEFAULT true, marketing_access boolean DEFAULT true);
    CREATE TABLE user_marketing_permissions (user_id uuid REFERENCES app_users(id), permission text);
    CREATE TABLE audit_events (id uuid DEFAULT gen_random_uuid(), actor_user_id uuid, actor_type text, action text, entity_type text, entity_id uuid, after_json jsonb);
    CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
  `)
  await db.exec(readFileSync('supabase/migrations/018_gbp.sql', 'utf8'))
  await db.exec('ALTER TABLE gbp_locations ADD COLUMN location_id uuid; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;')
  for (const file of migrations) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  return db
}
export const HEALTH_MIGRATION = '20260923194341_gbp_review_health_daily.sql'
export const DESK_MIGRATION = '20260923194557_gbp_review_desk.sql'
export const LOCATION = '10000000-0000-4000-8000-000000000001'
export const ACTOR = '20000000-0000-4000-8000-000000000001'
export const reviewId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const replyId = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export async function seedReview(db: PGlite, n: number, created: string, status?: string, external?: string) {
  await db.query(`INSERT INTO gbp_reviews (id,google_review_id,location_id,star_rating,review_text,review_created_at,review_updated_at,existing_reply_text)
    VALUES ($1,$2,$3,5,'Synthetic falafel review',$4,$4,$5)`, [reviewId(n), `accounts/1/locations/2/reviews/synthetic-${n}`, LOCATION, created, external ?? null])
  if (status) await db.query(`INSERT INTO gbp_review_replies (id,review_id,status,draft_text) VALUES ($1,$2,$3,'Synthetic draft')`, [replyId(n), reviewId(n), status])
}
export async function seedLocation(db: PGlite) {
  await db.query(`INSERT INTO app_users (id,role) VALUES ($1,'SUPER_ADMIN');`, [ACTOR])
  await db.query(`INSERT INTO gbp_locations (id,google_account_id,google_location_id,store_name,store_short_name,location_id)
    VALUES ($1,'1','2','Synthetic store','Test',$1)`, [LOCATION])
}
