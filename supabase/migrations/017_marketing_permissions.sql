-- Killer Kockpit — Marketing M1: fine-grained Marketing permissions
--
-- user_marketing_permissions
--   Junction table granting individual Marketing capabilities to users.
--   Entirely separate from marketing_access (workspace-entry gate on app_users).
--
--   Both are required for non-SUPER_ADMIN users:
--     marketing_access = true  → user may enter the Marketing workspace
--     permission row           → user may perform that specific action
--   Having a permission row without marketing_access does NOT grant workspace
--   entry. Having marketing_access without a permission row does NOT grant
--   any per-domain action authority.
--
--   SUPER_ADMIN bypasses all permission checks in the application layer
--   (hasMarketingPermission in lib/permissions.ts). No rows are required for
--   SUPER_ADMIN, and their presence does not affect bypass behaviour.
--
-- Allowed permission values (seven):
--   paid_manage     — view paid performance, create recommendations for approval
--   paid_approve    — approve/reject paid-media actions (spend authority)
--   content_manage  — create/edit/manage content workflow
--   content_approve — approve content through relevant publication stages
--   ideas_approve   — approve AI-generated ideas before entry into Ideas backlog
--                     (distinct from content_approve: an approved idea is not
--                     the same as approved published content)
--   reviews_manage  — view reviews, create reply drafts
--   reviews_approve — approve/send review replies
--
-- Security:
--   No direct authenticated writes — all mutations via SECURITY DEFINER RPCs
--   (grant_marketing_permission_and_audit, revoke_marketing_permission_and_audit)
--   accessible only to service_role.
--
--   Audit events are written atomically with the permission change, but ONLY
--   when a real state change occurs (row actually inserted or deleted).
--   Idempotent calls produce no audit noise.
--
-- M2 note:
--   When the first institutional Marketing integration (Meta, GBP) is added,
--   add a partial unique index to integration_sync_state:
--     CREATE UNIQUE INDEX integration_sync_state_institutional_unique
--       ON integration_sync_state(integration)
--       WHERE user_id IS NULL;
--   This prevents duplicate institutional sync rows (PostgreSQL NULLs are
--   distinct in standard UNIQUE constraints).

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE user_marketing_permissions (
  user_id            uuid        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  permission         text        NOT NULL,
  granted_by_user_id uuid        REFERENCES app_users(id) ON DELETE SET NULL,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission),
  CONSTRAINT valid_marketing_permission CHECK (permission IN (
    'paid_manage',
    'paid_approve',
    'content_manage',
    'content_approve',
    'ideas_approve',
    'reviews_manage',
    'reviews_approve'
  ))
);

-- No separate index on user_id is needed.
-- PRIMARY KEY (user_id, permission) creates a compound B-tree index with
-- user_id as the leading column. PostgreSQL can use it for WHERE user_id = $1
-- lookups via a prefix scan, making a single-column index on user_id redundant.

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE user_marketing_permissions ENABLE ROW LEVEL SECURITY;

-- Each user may read their own permission rows (needed by the layout to
-- resolve fine-grained Marketing capability without a full admin query).
CREATE POLICY "ump: user can read own"
  ON user_marketing_permissions FOR SELECT
  TO authenticated
  USING (user_id = get_my_app_user_id());

-- SUPER_ADMIN can read all permission rows.
CREATE POLICY "ump: super_admin can read all"
  ON user_marketing_permissions FOR SELECT
  TO authenticated
  USING (get_my_role() = 'SUPER_ADMIN');

-- No direct authenticated writes.
-- All mutations go through service_role SECURITY DEFINER RPCs.
-- This prevents any user from granting themselves Marketing permissions.
CREATE POLICY "ump: no direct insert"
  ON user_marketing_permissions FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "ump: no direct update"
  ON user_marketing_permissions FOR UPDATE
  TO authenticated
  USING (false);

CREATE POLICY "ump: no direct delete"
  ON user_marketing_permissions FOR DELETE
  TO authenticated
  USING (false);

-- ── grant_marketing_permission_and_audit ──────────────────────────────────────
--
-- Inserts a permission row if it does not already exist.
-- Returns 'granted' if a row was inserted, 'already_present' if it existed.
-- Audit event is written ONLY when a row was actually inserted.
-- Idempotent calls produce no audit noise.

CREATE OR REPLACE FUNCTION grant_marketing_permission_and_audit(
  p_user_id       uuid,
  p_permission    text,
  p_actor_user_id uuid
)
RETURNS text
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO user_marketing_permissions (user_id, permission, granted_by_user_id)
  VALUES (p_user_id, p_permission, p_actor_user_id)
  ON CONFLICT (user_id, permission) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 1 THEN
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
    VALUES (
      p_actor_user_id, 'human', 'marketing.permission.granted', 'user', p_user_id,
      jsonb_build_object('permission', p_permission)
    );
    RETURN 'granted';
  ELSE
    RETURN 'already_present';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION grant_marketing_permission_and_audit(uuid, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION grant_marketing_permission_and_audit(uuid, text, uuid) TO service_role;

-- ── revoke_marketing_permission_and_audit ─────────────────────────────────────
--
-- Deletes a permission row if it exists.
-- Returns 'revoked' if a row was deleted, 'not_present' if it did not exist.
-- Audit event is written ONLY when a row was actually deleted.
-- Idempotent calls produce no audit noise.

CREATE OR REPLACE FUNCTION revoke_marketing_permission_and_audit(
  p_user_id       uuid,
  p_permission    text,
  p_actor_user_id uuid
)
RETURNS text
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM user_marketing_permissions
  WHERE user_id = p_user_id AND permission = p_permission;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 1 THEN
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
    VALUES (
      p_actor_user_id, 'human', 'marketing.permission.revoked', 'user', p_user_id,
      jsonb_build_object('permission', p_permission)
    );
    RETURN 'revoked';
  ELSE
    RETURN 'not_present';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION revoke_marketing_permission_and_audit(uuid, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION revoke_marketing_permission_and_audit(uuid, text, uuid) TO service_role;
