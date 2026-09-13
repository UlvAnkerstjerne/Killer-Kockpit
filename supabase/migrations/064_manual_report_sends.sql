-- Migration 064: support deliberate manual report sends
--
-- Adds two columns to report_deliveries:
--   is_manual      — true for management-triggered sends; false for automated sends
--   sender_user_id — UUID of the app user who triggered the send (null for automated)
--
-- Recreates the terminal-uniqueness index to exclude manual rows so that
-- deliberately re-sending the same report to the same address is always allowed.
-- Automated sends (is_manual = false) remain deduplicated as before.

ALTER TABLE public.report_deliveries
  ADD COLUMN IF NOT EXISTS is_manual      boolean   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sender_user_id uuid;

-- Drop existing unique index and recreate excluding manual rows
DROP INDEX IF EXISTS report_deliveries_terminal_unique;

CREATE UNIQUE INDEX report_deliveries_terminal_unique
  ON public.report_deliveries (report_type, submission_key, recipient)
  WHERE status IN ('sent', 'skipped') AND is_manual = false;
