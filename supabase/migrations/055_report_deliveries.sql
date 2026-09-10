-- Generic report delivery history and idempotency.
-- Tracks every automated PDF report email the system sends.
-- report_type     — e.g. 'kkc_ssp_cph'
-- submission_key  — the external submission identifier (Google Sheet timestamp string)
-- recipient       — email address
-- status          — 'sent' | 'failed' | 'skipped'
--   sent:    email delivered; Resend message ID stored in resend_id
--   failed:  send attempt failed; error stored in error column; retryable
--   skipped: baseline record — submission existed before automation was enabled

CREATE TABLE public.report_deliveries (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type    text        NOT NULL,
  submission_key text        NOT NULL,
  recipient      text        NOT NULL,
  status         text        NOT NULL,
  resend_id      text,
  error          text,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_deliveries_status_check
    CHECK (status IN ('sent', 'failed', 'skipped'))
);

-- Prevents duplicate terminal deliveries for the same (type, key, recipient).
-- 'sent' and 'skipped' are terminal — only one allowed per combination.
-- 'failed' rows are not unique-constrained so each retry can be recorded.
CREATE UNIQUE INDEX report_deliveries_terminal_unique
  ON public.report_deliveries (report_type, submission_key, recipient)
  WHERE status IN ('sent', 'skipped');

-- Fast lookup: which submissions have been processed for a given report type?
CREATE INDEX report_deliveries_lookup_idx
  ON public.report_deliveries (report_type, recipient, status);

-- Service-role only — no user rows, no user-facing RLS policies needed.
ALTER TABLE public.report_deliveries ENABLE ROW LEVEL SECURITY;
