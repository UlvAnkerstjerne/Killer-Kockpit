-- Killer Kockpit — Marketing M4: Morning Brief
--
-- Table: marketing_morning_briefs
--   One row per calendar date in Europe/Copenhagen.
--   Generated once daily by the 07:30 UTC cron (09:00–09:30 Copenhagen time).
--   Page load reads only this table — zero AI/Meta API calls at render time.
--
-- Status lifecycle:
--   pending    — row created, generation not yet started
--   generating — generation in progress (check generation_started_at for stuck detection)
--   ready      — brief successfully generated and validated
--   failed     — generation failed; error_message set; serve last ready brief to users
--
-- Idempotency:
--   The UNIQUE constraint on brief_date ensures at most one row per day.
--   The cron endpoint checks existing status before proceeding.
--   Two simultaneous cron invocations cannot both call Claude unnecessarily:
--   the status column acts as the claim flag; generation_started_at enables
--   stuck-process detection (> 30 min in 'generating' → can be reclaimed).
--
-- SUPER_ADMIN regeneration safety:
--   A ready brief is never deleted before a replacement is confirmed successful.
--   If forced regeneration fails, the previous ready payload remains in place.
--
-- Security:
--   RLS enabled; no permissive policies for authenticated or anon roles.
--   All reads/writes via service_role through server actions and cron endpoint.
--   Server actions enforce canAccessMarketing() before any DB access.
--   SUPER_ADMIN checks are enforced in the triggering server action.
--
-- JSON columns:
--   sections_json          — structured brief section data (see TypeScript types)
--   source_freshness_json  — per-integration freshness snapshot at generation time
--   deterministic_signals_json — computed severity signals that drove overall_status
--     (stored for admin debugging; not exposed to ordinary Marketing users)

CREATE TABLE marketing_morning_briefs (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Calendar date in Europe/Copenhagen this brief covers
  brief_date                 date        NOT NULL UNIQUE,

  -- Generation state machine
  status                     text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generating', 'ready', 'failed')),

  -- Set when generation begins; enables stuck-process detection
  generation_started_at      timestamptz,

  -- ── AI output ─────────────────────────────────────────────────────────────

  -- Deterministically computed before the AI call; Claude explains it but does
  -- not decide it.
  overall_status             text        CHECK (overall_status IN ('green', 'amber', 'red')),
  -- One-sentence reason for the status (AI-written)
  overall_reason             text,

  -- Combined executive summary (AI-written, decision-oriented)
  ai_summary                 text,

  -- Full structured section data (paid, organic, gbp, content, needs_review)
  sections_json              jsonb,

  -- ── Data coverage ─────────────────────────────────────────────────────────

  data_window_start          date,   -- earliest date included in this brief
  data_window_end            date,   -- latest date (typically yesterday in Copenhagen)

  -- Per-integration freshness at generation time.
  -- Enables the brief to accurately describe data currency.
  -- Format: { integration: { last_success_at, status, age_hours, healthy } }
  source_freshness_json      jsonb,

  -- Computed severity signals that produced overall_status.
  -- Stored for SUPER_ADMIN debugging; not shown to ordinary Marketing users.
  -- Format: { has_stale_critical_source, paid_anomaly_count, ... }
  deterministic_signals_json jsonb,

  -- ── Generation metadata ───────────────────────────────────────────────────

  generated_at               timestamptz,
  generation_duration_ms     integer,

  ai_model                   text,
  ai_prompt_version          text,

  -- ── Error tracking ────────────────────────────────────────────────────────

  -- User-safe error (shown to Marketing users when no fresh brief exists)
  error_message              text,
  -- Detailed error for admin debugging (service_role access only)
  error_detail               text,

  -- ── Timestamps ───────────────────────────────────────────────────────────

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE TRIGGER marketing_morning_briefs_updated_at
  BEFORE UPDATE ON marketing_morning_briefs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Service-role-only access (matches all other Marketing tables)
ALTER TABLE marketing_morning_briefs ENABLE ROW LEVEL SECURITY;
-- No authenticated/anon policies — PostgREST cannot access this table from a browser

-- Fast lookup: most recent ready brief (used on every /marketing page load)
CREATE INDEX marketing_morning_briefs_date_status_idx
  ON marketing_morning_briefs(brief_date DESC, status);
