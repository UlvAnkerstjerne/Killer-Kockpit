-- 026_todos.sql
--
-- Personal to-do items for each app user.
--
-- Design decisions
-- ----------------
-- • todos are strictly personal — a user can only read/write their own rows.
--   RLS enforces this at the DB layer using get_my_app_user_id().
--   Server actions enforce it at the application layer using getCurrentUser().
--   Two independent layers — neither alone is sufficient.
--
-- • No SECURITY DEFINER RPCs are used. todos are simple personal records that
--   don't require cross-table writes or audit events. Direct table access with
--   strict RLS is cleaner and appropriate here.
--
-- • Status is derived from timestamps, not stored as a separate column:
--     open       — completed_at IS NULL AND cancelled_at IS NULL
--     completed  — completed_at IS NOT NULL
--     cancelled  — cancelled_at IS NOT NULL
--   A CHECK constraint prevents both being set simultaneously.
--
-- • No hard deletes. Cancelled items are hidden from Today but visible in the
--   dedicated /todos history page.
--
-- • Priority reuses the existing 1–4 model (1=Critical, 2=Normal, 3=Low, 4=Background).
--   Default is 2 (Normal).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE todos (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES app_users(id),
  title        text        NOT NULL,
  priority     smallint    NOT NULL DEFAULT 2,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,

  CONSTRAINT todos_title_not_empty CHECK (trim(title) <> ''),
  CONSTRAINT todos_priority_range  CHECK (priority BETWEEN 1 AND 4),
  CONSTRAINT todos_one_terminal    CHECK (
    NOT (completed_at IS NOT NULL AND cancelled_at IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Fast load of open todos for a user (Today block, /todos open section).
-- Partial index: only indexes open rows, keeping it lean.
CREATE INDEX todos_user_open
  ON todos (user_id, priority ASC, created_at DESC)
  WHERE completed_at IS NULL AND cancelled_at IS NULL;

-- Fast load of completed todos for a user (week count query, history).
CREATE INDEX todos_user_completed
  ON todos (user_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

-- Users can only read their own todos (all statuses — /todos history needs cancelled).
CREATE POLICY "todos: owner can read own"
  ON todos FOR SELECT
  TO authenticated
  USING (user_id = get_my_app_user_id());

-- Users can only insert todos for themselves.
-- The WITH CHECK ensures the row being inserted belongs to the requesting user.
CREATE POLICY "todos: owner can insert own"
  ON todos FOR INSERT
  TO authenticated
  WITH CHECK (user_id = get_my_app_user_id());

-- Users can only update their own todos (complete, cancel, reopen).
CREATE POLICY "todos: owner can update own"
  ON todos FOR UPDATE
  TO authenticated
  USING (user_id = get_my_app_user_id());

-- No DELETE policy — soft lifecycle via completed_at / cancelled_at only.
