-- Killer Kockpit — Marketing M0: workspace access gate
--
-- Adds a coarse-grained marketing_access flag to app_users.
--
-- Semantics:
--   marketing_access = true  → this user may enter the Marketing workspace
--   marketing_access = false → no Marketing access (default for all existing users)
--
-- SUPER_ADMIN always bypasses this flag in the application permission layer
-- (canAccessMarketing in lib/permissions.ts), so the existing admin account
-- automatically retains full Marketing access without any manual update.
--
-- This column is intentionally coarse — it controls workspace entry only.
-- Fine-grained Marketing role permissions (approve content, approve paid-media
-- recommendations, manage reviews, etc.) will be introduced alongside the first
-- Marketing feature that requires them, via a separate user_marketing_roles table.
-- Do not encode approval authority into this column.

ALTER TABLE app_users
  ADD COLUMN marketing_access boolean NOT NULL DEFAULT false;
