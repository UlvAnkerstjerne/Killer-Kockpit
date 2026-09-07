-- Killer Kockpit — N2: notifications substrate
--
-- PURPOSE:
--   Personal in-app notification storage for task lifecycle events.
--   Notifications are attention state, not institutional record.
--   The underlying Task mutation is the auditable event (audit_events).
--   No notification prose is persisted — display copy is derived at read time.
--
-- SECURITY MODEL:
--   SELECT: own rows only (recipient_user_id = get_my_app_user_id()).
--   INSERT: SECURITY DEFINER RPCs only (via task lifecycle hooks in N3).
--   UPDATE: controlled SECURITY DEFINER RPCs (mark_notification_read,
--           mark_all_notifications_read) — never broad direct UPDATE.
--   DELETE: denied to all clients.
--   SUPER_ADMIN sees only their own notifications — notifications are personal.
--
-- READ-STATE RPCs:
--   mark_notification_read(p_notification_id uuid)
--   mark_all_notifications_read()
--   Both derive the current user from get_my_app_user_id() (JWT-bound).
--   Both are idempotent.
--   service_role (no user JWT) → get_my_app_user_id() = NULL → rejected.
--
-- FK DELETE CONVENTIONS:
--   recipient_user_id: ON DELETE CASCADE — user deleted → their notifications go too.
--   actor_user_id:     ON DELETE SET NULL — actor deleted → notification survives,
--                      actor_name falls back to a safe default at display time.
--
-- CHECK CONSTRAINTS:
--   type and entity_type use narrow IN() checks rather than enums.
--   Both can be widened via ALTER TABLE when N3+ adds more notification types.

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  actor_user_id     uuid                 REFERENCES app_users(id) ON DELETE SET NULL,
  type              text        NOT NULL
    CHECK (type IN (
      'task.assigned',
      'task.submitted_for_review',
      'task.sent_back',
      'task.approved'
    )),
  entity_type       text        NOT NULL
    CHECK (entity_type IN ('task')),
  entity_id         uuid        NOT NULL,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notifications IS
  'Personal in-app attention state. Not institutional audit record. '
  'Display copy is derived at read time from type + entity + actor.';

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Recent notifications list (popover, newest-first, bounded by LIMIT)
CREATE INDEX idx_notifications_recipient_recent
  ON notifications (recipient_user_id, created_at DESC);

-- Unread count (partial — only unread rows are scanned)
CREATE INDEX idx_notifications_recipient_unread
  ON notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Recipients see only their own notifications.
-- This applies equally to MEMBER, UM, and SUPER_ADMIN.
CREATE POLICY "notifications_own_select"
  ON notifications FOR SELECT
  USING (recipient_user_id = get_my_app_user_id());

-- No direct INSERT/UPDATE/DELETE from any client role.
-- All writes (N3+) go through SECURITY DEFINER RPCs (service_role path for N3).
-- Read-state mutations go through mark_notification_read / mark_all_notifications_read.

-- ─── mark_notification_read ───────────────────────────────────────────────────
--
-- Sets read_at = now() for one notification belonging to the current user.
-- Idempotent: COALESCE(read_at, now()) preserves the first-read timestamp.
-- If the notification does not belong to the caller, the UPDATE matches zero
-- rows and returns normally — no information is leaked about other users' rows.
-- "Mark unread" is not supported in v1.

CREATE OR REPLACE FUNCTION mark_notification_read(
  p_notification_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- ── 1. Identity gate ─────────────────────────────────────────────────────
  v_user_id := get_my_app_user_id();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ── 2. Update own row only ────────────────────────────────────────────────
  -- COALESCE preserves the original read_at if already set (idempotent).
  -- Recipient check in WHERE clause: other users' rows are silently unaffected.
  UPDATE notifications
  SET    read_at = COALESCE(read_at, now())
  WHERE  id                = p_notification_id
    AND  recipient_user_id = v_user_id;
END;
$$;

-- ─── mark_all_notifications_read ─────────────────────────────────────────────
--
-- Sets read_at = now() for all unread notifications belonging to the current user.
-- Idempotent and safe: only rows WHERE read_at IS NULL are touched.
-- Already-read rows are not modified.
-- Other users' rows are never touched.

CREATE OR REPLACE FUNCTION mark_all_notifications_read()
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- ── 1. Identity gate ─────────────────────────────────────────────────────
  v_user_id := get_my_app_user_id();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ── 2. Mark all own unread rows ───────────────────────────────────────────
  UPDATE notifications
  SET    read_at = now()
  WHERE  recipient_user_id = v_user_id
    AND  read_at IS NULL;
END;
$$;

-- ─── Execute permissions ──────────────────────────────────────────────────────
--
-- Pattern matches 042_employee_locations:
-- Revoke from PUBLIC (covers the blanket grant) and from anon explicitly.
-- authenticated role retains the Supabase auto-grant — these RPCs are called
-- via the authenticated Supabase client (createClient) with a user JWT.
-- service_role has no user JWT → get_my_app_user_id() = NULL → blocked by guard.

REVOKE EXECUTE ON FUNCTION mark_notification_read(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_notification_read(uuid) FROM anon;
-- authenticated: retains Supabase auto-grant

REVOKE EXECUTE ON FUNCTION mark_all_notifications_read() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_all_notifications_read() FROM anon;
-- authenticated: retains Supabase auto-grant
