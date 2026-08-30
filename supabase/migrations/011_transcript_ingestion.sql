-- Killer Kockpit — Migration 011: Transcript ingestion (Phase M5A)
--
-- Scope: transcript ingestion and provenance only.
-- No AI generation, no meeting_ai_drafts table (Phase M5B).
--
-- Changes:
--   1. Add sources.content — stores raw transcript text verbatim.
--      RLS is unchanged: sources remains SUPER_ADMIN only for authenticated
--      role.  All TypeScript access goes through createServiceClient()
--      (service role, bypasses RLS) so content is never directly readable
--      by the browser.
--   2. Add sources.file_name — original uploaded filename for display.
--      Stored in metadata jsonb today; promoting to a column makes the
--      transcript listing query simpler without a schema change to metadata.
--      (kept in metadata too for backward-compat queries)

-- ─── 1. sources.content ──────────────────────────────────────────────────────
-- Nullable: only populated for meeting_transcript rows.
-- Other source types (gmail, drive) never set this field.

alter table sources
  add column if not exists content text;

-- ─── 2. sources.file_name ────────────────────────────────────────────────────
-- Stores the original filename the user uploaded (e.g. "standup-2026-08-29.vtt").
-- Complements title (frozen meeting-title-style label) with the raw file name.

alter table sources
  add column if not exists file_name text;

-- ─── Notes ───────────────────────────────────────────────────────────────────
-- meetings.transcript_source_id already exists (001_initial_schema.sql FK to sources).
-- entity_sources already supports relation = 'transcript' (no enum, free-text column).
-- No new tables, no RLS changes, no stored procedure changes in this phase.
