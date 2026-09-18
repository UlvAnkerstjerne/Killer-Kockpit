-- 074_todo_sort_order.sql
--
-- Adds manual sort ordering to personal to-dos.
--
-- Design decisions
-- ----------------
-- • sort_order (float8, nullable) stores the user's manual priority ordering.
--   NULL = never manually ordered — display falls back to priority ASC + created_at DESC.
--   Float8 allows fractional insertion between existing values if needed in future,
--   though the application currently assigns integer multiples of 1000.
--
-- • Ordering convention: lower sort_order = higher in list (appears first).
--   NULL FIRST ensures new todos (sort_order IS NULL) always float to the top
--   of a user's list, giving the "new todos appear at the top" behaviour without
--   requiring the create action to assign a sort_order value.
--
-- • One canonical order per user — not per page or device. All surfaces that
--   show a user's active to-dos must ORDER BY sort_order ASC NULLS FIRST.
--
-- • RLS: sort_order is updated via the existing owner UPDATE policy
--   ("todos: owner can update own"). No new policies are required.
--
-- • Completing or cancelling a to-do does not affect the sort_order of the
--   remaining open todos — their values are untouched by those mutations.
--
-- • Recurring to-dos: newly spawned occurrences inherit sort_order = NULL (default)
--   and therefore appear at the top. The user can then drag them into their
--   preferred position.

ALTER TABLE todos
  ADD COLUMN IF NOT EXISTS sort_order float8;

-- Partial index covering only open, active todos — the set sorted at query time.
-- Upgraded todos are excluded for consistency with the existing todos_user_open index.
CREATE INDEX IF NOT EXISTS todos_user_sort_order
  ON todos (user_id, sort_order ASC NULLS FIRST)
  WHERE completed_at IS NULL
    AND cancelled_at IS NULL
    AND upgraded_to_task_id IS NULL;
