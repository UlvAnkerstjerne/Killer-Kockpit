-- Killer Kockpit — To-Do completion context
--
-- Captures what happened when a to-do was completed:
--
--   todos.completion_context    — the outcome / what happened (required at completion)
--   todos.completed_by_user_id  — the app_user who completed the to-do
--
-- Both columns are nullable so existing completed rows are not invalidated.
-- Newly completed rows must supply a non-blank context (enforced in the
-- application layer; no DB constraint since old rows are legitimately NULL).

ALTER TABLE todos
  ADD COLUMN IF NOT EXISTS completion_context    text,
  ADD COLUMN IF NOT EXISTS completed_by_user_id  uuid REFERENCES app_users(id);
