-- 056_system_notifications.sql
--
-- Extends the notification substrate to support system-generated notifications
-- for Audit and KQC results.
--
-- Changes:
--   1. Widen notifications.type CHECK to include 'audit.result', 'kkc.result'
--   2. Widen notifications.entity_type CHECK to include
--      'audit_submission', 'kkc_submission'
--   3. Add nullable metadata JSONB column — stores structured display data
--      (scores, location, etc.) derived at creation time for system events.
--      Task notifications leave this NULL (display copy already derived from
--      actor + task title at read time).
--   4. Add create_system_notification() SECURITY DEFINER RPC callable by
--      service_role — used server-side to insert notifications for audit/KQC
--      results without requiring a user JWT.
--
-- Security model unchanged:
--   SELECT: recipient sees only own rows (RLS policy from 043 unchanged).
--   INSERT: service_role only, via create_system_notification() RPC.
--   UPDATE: mark_notification_read / mark_all_notifications_read (unchanged).
--   DELETE: denied (unchanged).

-- ─── 1. Widen type CHECK constraint ──────────────────────────────────────────

ALTER TABLE notifications
  DROP CONSTRAINT notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'task.assigned',
    'task.submitted_for_review',
    'task.sent_back',
    'task.approved',
    'audit.result',
    'kkc.result'
  ));

-- ─── 2. Widen entity_type CHECK constraint ────────────────────────────────────

ALTER TABLE notifications
  DROP CONSTRAINT notifications_entity_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_entity_type_check
  CHECK (entity_type IN (
    'task',
    'audit_submission',
    'kkc_submission'
  ));

-- ─── 3. Add metadata column ───────────────────────────────────────────────────

ALTER TABLE notifications
  ADD COLUMN metadata jsonb;

COMMENT ON COLUMN notifications.metadata IS
  'Structured display data for system-generated notifications (audit.result, '
  'kkc.result). NULL for task lifecycle notifications whose display copy is '
  'derived from actor + entity at read time.';

-- ─── 4. create_system_notification ───────────────────────────────────────────
--
-- Inserts a system notification for a recipient without requiring a user JWT.
-- Called server-side via createServiceClient() after audit submission or KQC
-- delivery.
--
-- Parameters:
--   p_type              — notification type (must satisfy CHECK constraint)
--   p_entity_type       — entity type (must satisfy CHECK constraint)
--   p_entity_id         — UUID of the referenced entity
--   p_recipient_user_id — user to notify
--   p_metadata          — optional structured data for display copy
--
-- Returns the new notification UUID.
--
-- No actor: system notifications have actor_user_id = NULL.
-- Idempotency is handled at the application layer via report_deliveries.

CREATE OR REPLACE FUNCTION create_system_notification(
  p_type              text,
  p_entity_type       text,
  p_entity_id         uuid,
  p_recipient_user_id uuid,
  p_metadata          jsonb DEFAULT NULL
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO notifications (
    type, entity_type, entity_id, recipient_user_id, actor_user_id, metadata
  ) VALUES (
    p_type, p_entity_type, p_entity_id, p_recipient_user_id, NULL, p_metadata
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- service_role only — no direct user-initiated system notifications.
REVOKE EXECUTE ON FUNCTION create_system_notification(text, text, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_system_notification(text, text, uuid, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION create_system_notification(text, text, uuid, uuid, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_system_notification(text, text, uuid, uuid, jsonb) TO service_role;
