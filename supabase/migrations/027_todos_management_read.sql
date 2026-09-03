-- 027_todos_management_read.sql
--
-- Adds a management-read SELECT policy to the todos table.
--
-- Design rationale
-- ----------------
-- The existing todo RLS is strictly personal: users can only read/write their
-- own rows. This is correct and is preserved — the existing SELECT policy
-- ("todos: owner can read own") is unchanged, and all INSERT/UPDATE policies
-- remain owner-only.
--
-- For Team Visibility on the /todos page, management users (SUPER_ADMIN and UM)
-- need to SELECT todos belonging to other users. This mirrors the established
-- pattern for tasks and projects, where management roles have a complementary
-- SELECT policy alongside the owner-restricted policies:
--
--   tasks:    "tasks: management can read all"   → get_my_role() IN ('SUPER_ADMIN', 'UM')
--   projects: "projects: management can read all" → same
--   todos:    this policy                         → same
--
-- Visibility and control are separate concerns. Seeing another user's todo
-- does not grant authority to complete, cancel, or modify it. The application
-- layer (TeamTodosView) presents the team data read-only; the RLS INSERT/UPDATE
-- policies remain scoped to user_id = get_my_app_user_id().

CREATE POLICY "todos: management can read all"
  ON todos FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));
