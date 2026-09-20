-- Migration 076: in-person meeting recordings
--
-- Adds the meeting_recordings table, which tracks the lifecycle of an
-- audio recording captured in the Kockpit mobile recorder.
--
-- Lifecycle:
--   recording → uploaded → transcribing → needs_speaker_review → complete
--                                                               ↘ failed
--
-- The audio file lives in the `meeting-recordings` Supabase Storage bucket
-- at storage_path.  Audio is NEVER stored in Postgres.
--
-- Transcript output is stored in the existing sources / entity_sources /
-- meetings.transcript_source_id architecture, not a separate system.
--
-- Consent is mandatory before recording starts.  confirmed_at /
-- confirmed_by_user_id are set the moment the host taps "Start Recording".
--
-- AssemblyAI processing:
--   • assemblyai_transcript_id is the stable external_id used for
--     transcript source idempotency.
--   • processing_error captures the last failure reason for display/retry.
--
-- Speaker review:
--   • speaker_mapping stores the name→label mapping used to build the final
--     transcript content.  Corrections update this field; the raw provider
--     response is preserved in the associated source's metadata.
--
-- Security:
--   • RLS: SUPER_ADMIN only — application authorises the current user
--     before calling createServiceClient().
--   • Storage bucket policies are separate (see below).

-- ─── meeting_recordings ───────────────────────────────────────────────────────

CREATE TABLE meeting_recordings (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id                  uuid        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_by_user_id          uuid        REFERENCES app_users(id),

  -- Lifecycle
  status                      text        NOT NULL DEFAULT 'recording'
                                          CHECK (status IN (
                                            'recording', 'uploaded', 'transcribing',
                                            'needs_speaker_review', 'complete', 'failed'
                                          )),

  -- Session timing
  started_at                  timestamptz NOT NULL DEFAULT now(),
  stopped_at                  timestamptz,
  duration_seconds            integer,    -- rounded, set on upload

  -- Audio storage (Supabase Storage, bucket: meeting-recordings)
  storage_path                text,       -- e.g. recordings/<meeting_id>/<id>.<ext>
  mime_type                   text,       -- e.g. audio/webm;codecs=opus
  byte_size                   bigint,

  -- Consent
  consent_confirmed_at        timestamptz,
  consent_confirmed_by_user_id uuid       REFERENCES app_users(id),

  -- AssemblyAI
  assemblyai_transcript_id    text,       -- stable external_id for idempotency
  processing_error            text,

  -- Speaker mapping
  -- JSON object: { "A": "Ulv Ankerstjerne", "B": "Mikkel Jensen", "C": "Lydia" }
  -- Updated by speaker review.  Raw diarization labels → display names.
  speaker_mapping             jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Expected speaker names supplied to AssemblyAI at submission time
  expected_speakers           text[]      NOT NULL DEFAULT '{}',

  -- Linked transcript source (set when complete, mirrors meetings.transcript_source_id)
  transcript_source_id        uuid        REFERENCES sources(id),

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── Indices ───────────────────────────────────────────────────────────────────

-- Fast lookup by meeting (most common query pattern)
CREATE INDEX meeting_recordings_meeting_idx
  ON meeting_recordings (meeting_id);

-- Webhook resolution: look up a recording by AssemblyAI transcript ID
CREATE UNIQUE INDEX meeting_recordings_assemblyai_idx
  ON meeting_recordings (assemblyai_transcript_id)
  WHERE assemblyai_transcript_id IS NOT NULL;

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_meeting_recordings_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER meeting_recordings_updated_at
  BEFORE UPDATE ON meeting_recordings
  FOR EACH ROW EXECUTE FUNCTION touch_meeting_recordings_updated_at();

-- ── RLS: SUPER_ADMIN only (application authorises before bypassing) ────────────

ALTER TABLE meeting_recordings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "meeting_recordings: SUPER_ADMIN only"
  ON meeting_recordings FOR ALL
  TO authenticated
  USING (get_my_role() = 'SUPER_ADMIN');

-- ── Storage bucket ────────────────────────────────────────────────────────────
--
-- The `meeting-recordings` bucket must be created in the Supabase dashboard
-- or via the management API.  This migration records the intended policy
-- contracts as comments so they can be applied via the dashboard.
--
-- Bucket settings:
--   name:    meeting-recordings
--   public:  false   ← CRITICAL: audio must never be publicly accessible
--
-- RLS policies on storage.objects for bucket `meeting-recordings`:
--
--   INSERT: authenticated users — controlled at application layer; signed URLs
--           are generated server-side only.  No direct client upload.
--           (Application uses service_role; no user-facing INSERT policy needed.)
--
--   SELECT: authenticated users whose role = SUPER_ADMIN only.
--           All download access goes through server-side signed URLs issued
--           to authorised users.  Direct object SELECT is admin-only.
--
-- Note: because all audio upload and download is handled server-side via
-- service_role (never directly from the browser), no permissive RLS on
-- storage.objects is needed for ordinary users.  The bucket being private
-- (public=false) is the primary access control.

-- ── Grant service_role access ─────────────────────────────────────────────────

GRANT ALL ON meeting_recordings TO service_role;
