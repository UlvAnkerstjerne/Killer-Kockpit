-- 022_secure_mutation_rpcs.sql
--
-- Security fix: revoke EXECUTE on all SECURITY DEFINER mutation RPCs from
-- the anon and authenticated Postgres roles.
--
-- ROOT CAUSE
-- ----------
-- Supabase automatically grants EXECUTE to the `anon` and `authenticated`
-- roles on every function created in the public schema.  Previous migrations
-- contained:
--
--     REVOKE EXECUTE ON FUNCTION foo(...) FROM PUBLIC;
--     GRANT  EXECUTE ON FUNCTION foo(...) TO service_role;
--
-- REVOKE FROM PUBLIC removes the blanket public grant but does NOT remove
-- the individual grants Supabase previously issued to `anon` and
-- `authenticated`.  Those roles therefore retained EXECUTE permission and
-- could invoke any mutation RPC directly via the PostgREST /rest/v1/rpc/*
-- endpoint, bypassing the application authorization layer entirely.
--
-- FIX
-- ---
-- Explicitly REVOKE EXECUTE from both roles on every function that was
-- already restricted to service_role in prior migrations.  REVOKE is
-- idempotent — it is a no-op when the target grantee does not hold the
-- privilege — so this migration is safe to re-run.
--
-- SCOPE
-- -----
-- All SECURITY DEFINER mutation RPCs confirmed to be called exclusively via
-- createServiceClient() (service_role key) in the application layer.
-- Functions used by the PostgREST row-level security policy helpers
-- (e.g. get_my_role, get_my_app_user_id) are NOT touched here; they must
-- remain callable by the authenticated role.

-- ---------------------------------------------------------------------------
-- 003_atomic_mutations — project, task core mutations
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION create_project_and_audit(text, text, uuid, text, date, date, numeric, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_project_and_audit(text, text, uuid, text, date, date, numeric, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_project_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_project_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION archive_project_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION archive_project_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION complete_task_and_audit(uuid, uuid, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION complete_task_and_audit(uuid, uuid, text, timestamptz) FROM authenticated;

REVOKE EXECUTE ON FUNCTION cancel_task_and_audit(uuid, uuid, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_task_and_audit(uuid, uuid, text, timestamptz) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 004_milestone2 — waiting-on, decision mutations
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) FROM anon;
REVOKE EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) FROM authenticated;

REVOKE EXECUTE ON FUNCTION cancel_waiting_on_and_audit(uuid, uuid, waiting_status) FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_waiting_on_and_audit(uuid, uuid, waiting_status) FROM authenticated;

REVOKE EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_decision_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_decision_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION approve_decision_and_audit(uuid, uuid, uuid, decision_status) FROM anon;
REVOKE EXECUTE ON FUNCTION approve_decision_and_audit(uuid, uuid, uuid, decision_status) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 005_accountability — admin override variants, app-user management,
--                      change requests
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION update_project_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION update_project_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_task_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION update_task_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_decision_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION update_decision_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION create_app_user_and_audit(text, text, kk_role, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_app_user_and_audit(text, text, kk_role, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION set_app_user_active_and_audit(uuid, boolean, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION set_app_user_active_and_audit(uuid, boolean, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_app_user_role_and_audit(uuid, kk_role, kk_role, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION update_app_user_role_and_audit(uuid, kk_role, kk_role, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION create_change_request_and_audit(text, uuid, uuid, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION create_change_request_and_audit(text, uuid, uuid, jsonb, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION approve_change_request_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION approve_change_request_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION reject_change_request_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION reject_change_request_and_audit(uuid, uuid, text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 006_meetings — meeting lifecycle + attendees + outcomes + agenda
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_meeting_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_meeting_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION open_meeting_and_audit(uuid, uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION open_meeting_and_audit(uuid, uuid, timestamptz) FROM authenticated;

REVOKE EXECUTE ON FUNCTION close_meeting_and_audit(uuid, uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION close_meeting_and_audit(uuid, uuid, timestamptz) FROM authenticated;

REVOKE EXECUTE ON FUNCTION publish_meeting_and_audit(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION publish_meeting_and_audit(uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION cancel_meeting_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_meeting_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION add_meeting_attendee(uuid, uuid, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION add_meeting_attendee(uuid, uuid, text, text, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION remove_meeting_attendee(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION remove_meeting_attendee(uuid, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION create_meeting_outcome_and_audit(uuid, text, text, jsonb, integer, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_meeting_outcome_and_audit(uuid, text, text, jsonb, integer, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_meeting_outcome_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_meeting_outcome_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION remove_meeting_outcome_and_audit(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION remove_meeting_outcome_and_audit(uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION create_agenda_item_and_audit(uuid, text, text, integer, text, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_agenda_item_and_audit(uuid, text, text, integer, text, uuid, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION update_agenda_item_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_agenda_item_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;

REVOKE EXECUTE ON FUNCTION reorder_agenda_items(uuid, jsonb, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION reorder_agenda_items(uuid, jsonb, uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 007_fix_attendee_conflict — duplicate add_meeting_attendee redefinition
--   (same signature as above; REVOKE is idempotent)
-- ---------------------------------------------------------------------------
-- (already covered above)

-- ---------------------------------------------------------------------------
-- 008_meeting_corrections
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION add_meeting_correction_and_audit(uuid, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION add_meeting_correction_and_audit(uuid, text, text, uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 004_milestone2 continued — bind_user_identity_and_audit (auth callback)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION bind_user_identity_and_audit(uuid, text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION bind_user_identity_and_audit(uuid, text, uuid, text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 013_apply_ai_draft
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION apply_meeting_ai_draft_and_audit(uuid, uuid, uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION apply_meeting_ai_draft_and_audit(uuid, uuid, uuid, text, jsonb) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 017_marketing_permissions
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION grant_marketing_permission_and_audit(uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION grant_marketing_permission_and_audit(uuid, text, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION revoke_marketing_permission_and_audit(uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION revoke_marketing_permission_and_audit(uuid, text, uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 021_lifecycle — new lifecycle mutations (primary target of this fix)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION close_project_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION close_project_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION cancel_project_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_project_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION reopen_project_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION reopen_project_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION reopen_task_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION reopen_task_and_audit(uuid, uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION reopen_waiting_on_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION reopen_waiting_on_and_audit(uuid, uuid, text) FROM authenticated;
