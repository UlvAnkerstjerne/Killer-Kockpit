-- Killer Kockpit — Migration 012: AI-generated staged meeting drafts (Phase M5B)
--
-- Scope: schema for staged AI drafts only.
-- No "apply draft" RPC, no meeting_outcomes.ai_draft_id, no publish changes.
-- Those belong to later phases.
--
-- meeting_ai_drafts:
--   Stores each AI-generated draft for a meeting.  Multiple drafts may exist
--   per meeting (regeneration creates a new row, never overwrites).
--   applied_at and discarded_at are mutually exclusive at the DB level.
--
-- Security:
--   No direct authenticated writes — all mutations via service_role server actions.
--   READ follows meeting visibility:
--     • SUPER_ADMIN / UM — see all drafts
--     • MEMBER — sees drafts only for meetings they own or attend

-- ─── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE meeting_ai_drafts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id           uuid        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript_source_id uuid        NOT NULL REFERENCES sources(id),
  model                text        NOT NULL,
  prompt_version       text        NOT NULL,
  input_char_count     integer     NOT NULL,
  output_json          jsonb       NOT NULL,
  generated_by_user_id uuid        NOT NULL REFERENCES app_users(id),
  generated_at         timestamptz NOT NULL DEFAULT now(),
  applied_at           timestamptz,
  applied_by_user_id   uuid        REFERENCES app_users(id),
  discarded_at         timestamptz,
  discarded_by_user_id uuid        REFERENCES app_users(id),

  -- A draft cannot be simultaneously applied and discarded.
  -- Application-level code must honour this, but the DB enforces the invariant.
  CONSTRAINT draft_not_both_applied_and_discarded
    CHECK (applied_at IS NULL OR discarded_at IS NULL)
);

-- Efficient retrieval of recent drafts per meeting (newest first)
CREATE INDEX meeting_ai_drafts_meeting_idx
  ON meeting_ai_drafts(meeting_id, generated_at DESC);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE meeting_ai_drafts ENABLE ROW LEVEL SECURITY;

-- Management sees all drafts across all meetings
CREATE POLICY "meeting_ai_drafts: management can read"
  ON meeting_ai_drafts FOR SELECT TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- MEMBER can read drafts for meetings they own or attend
CREATE POLICY "meeting_ai_drafts: member can read attended"
  ON meeting_ai_drafts FOR SELECT TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND meeting_id IN (
      SELECT id FROM meetings
      WHERE owner_user_id = get_my_app_user_id()
         OR id IN (
              SELECT meeting_id FROM meeting_attendees
              WHERE user_id = get_my_app_user_id()
            )
    )
  );

-- No direct authenticated writes — all writes go through service_role server actions
CREATE POLICY "meeting_ai_drafts: no direct insert"
  ON meeting_ai_drafts FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "meeting_ai_drafts: no direct update"
  ON meeting_ai_drafts FOR UPDATE TO authenticated USING (false);

CREATE POLICY "meeting_ai_drafts: no direct delete"
  ON meeting_ai_drafts FOR DELETE TO authenticated USING (false);
