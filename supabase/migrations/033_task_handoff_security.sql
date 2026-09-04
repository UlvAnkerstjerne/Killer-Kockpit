-- 033_task_handoff_security.sql
--
-- Belt-and-suspenders REVOKE for the three handoff RPCs from migration 032.
-- Migration 032 already revokes from PUBLIC and grants to service_role.
-- This additionally revokes from the named Supabase roles — same pattern
-- as migration 028 for compute_next_todo_occurrence.

REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM authenticated;

REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM authenticated;
