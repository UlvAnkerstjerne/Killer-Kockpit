-- Migration 025: drop the obsolete 8-parameter overload of create_waiting_on_and_audit
--
-- Background
-- ----------
-- Migration 004 created create_waiting_on_and_audit with 8 parameters (no priority).
-- Migration 024 added a 9-parameter overload that includes p_priority smallint DEFAULT 2.
-- The application now always passes p_priority, so it always calls the 9-parameter version.
-- The 8-parameter overload is unreachable and should be removed to keep the schema clean.
--
-- Safety
-- ------
-- Uses IF EXISTS — idempotent, safe to re-run.
-- The 9-parameter overload is not touched by this migration.

DROP FUNCTION IF EXISTS create_waiting_on_and_audit(
  text,        -- p_title
  uuid,        -- p_owner_user_id
  uuid,        -- p_waiting_for_user_id
  text,        -- p_waiting_for_name
  uuid,        -- p_project_id
  timestamptz, -- p_due_at
  text,        -- p_notes
  uuid         -- p_actor_user_id
);
