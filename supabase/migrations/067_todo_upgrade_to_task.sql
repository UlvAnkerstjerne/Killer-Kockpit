-- Killer Kockpit — To-Do → Task upgrade linkage
--
-- Adds bi-directional provenance between a to-do and the task it was
-- upgraded into:
--
--   tasks.source_todo_id  — the to-do that was promoted to this task
--   todos.upgraded_to_task_id — the task this to-do became
--   todos.upgraded_at     — when the upgrade happened
--
-- Both FKs are nullable (most todos/tasks have no upgrade relationship).
-- The circular reference is safe: both columns default NULL and the
-- upgrade action inserts the task first, then updates the todo.

-- 1. tasks: record which to-do was promoted
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source_todo_id uuid REFERENCES todos(id);

-- 2. todos: record which task was created from this to-do
ALTER TABLE todos
  ADD COLUMN IF NOT EXISTS upgraded_to_task_id uuid REFERENCES tasks(id),
  ADD COLUMN IF NOT EXISTS upgraded_at          timestamptz;

-- Index: quickly find the task that came from a given to-do
CREATE INDEX IF NOT EXISTS todos_upgraded_to_task
  ON todos (upgraded_to_task_id)
  WHERE upgraded_to_task_id IS NOT NULL;
