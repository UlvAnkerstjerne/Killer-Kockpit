-- Killer Kockpit — cleanup script for a fresh project after a failed migration.
--
-- Use this ONLY on a brand-new Supabase project with no production data.
-- It drops everything that 001_initial_schema.sql may have partially created,
-- leaving the database clean so 001 can be rerun from scratch.
--
-- Safe to run even if some objects don't exist yet (all statements use IF EXISTS).
-- Run this first, then rerun 001_initial_schema.sql.

-- ─── Drop tables (reverse dependency order, CASCADE handles any remaining refs) ──

drop table if exists proposal_sources         cascade;
drop table if exists proposals                cascade;
drop table if exists entity_sources           cascade;
drop table if exists sources                  cascade;
drop table if exists integration_sync_state   cascade;
drop table if exists audit_events             cascade;
drop table if exists people_entries           cascade;
drop table if exists notes                    cascade;
drop table if exists decisions                cascade;
drop table if exists waiting_ons              cascade;
drop table if exists meeting_minutes          cascade;
drop table if exists agenda_items             cascade;
drop table if exists meeting_attendees        cascade;
drop table if exists meetings                 cascade;
drop table if exists tasks                    cascade;
drop table if exists projects                 cascade;
drop table if exists employees                cascade;
drop table if exists app_users                cascade;

-- ─── Drop functions ────────────────────────────────────────────────────────────

drop function if exists get_my_app_user_id()  cascade;
drop function if exists get_my_role()         cascade;
drop function if exists update_updated_at_column() cascade;

-- ─── Drop enum types ───────────────────────────────────────────────────────────

drop type if exists people_entry_type  cascade;
drop type if exists source_type        cascade;
drop type if exists proposal_type      cascade;
drop type if exists proposal_status    cascade;
drop type if exists decision_status    cascade;
drop type if exists waiting_status     cascade;
drop type if exists task_status        cascade;
drop type if exists project_status     cascade;
drop type if exists kk_role            cascade;

-- pgcrypto extension is left in place — it is harmless and used by Supabase internally.
