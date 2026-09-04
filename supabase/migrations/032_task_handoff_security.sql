-- 032_task_handoff_security.sql
--
-- Belt-and-suspenders security for the handoff RPCs introduced in 031.
--
-- Migration 031 already revoked EXECUTE from PUBLIC and granted to service_role.
-- This migration additionally revokes from the named Supabase roles (anon and
-- authenticated) — the same pattern used for compute_next_todo_occurrence in
-- migration 028.

REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM authenticated;

REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM authenticated;
