-- 20260925160000_todo_notify.sql
--
-- Adds notify_user_id to todos — when set, a notification is sent to that
-- user when the todo is completed.

ALTER TABLE todos
  ADD COLUMN notify_user_id uuid REFERENCES app_users(id);

-- Widen notification type constraint to include todo.completed
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'task.assigned', 'task.submitted_for_review', 'task.sent_back', 'task.approved',
    'audit.result', 'kkc.result', 'diner.result', 'audit.followup.overdue',
    'todo.completed'
  ]));

-- Widen entity_type to include 'todo'
ALTER TABLE notifications DROP CONSTRAINT notifications_entity_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'task', 'project', 'waiting_on', 'decision', 'meeting',
    'audit_submission', 'kkc_submission', 'diner_submission',
    'audit_followup', 'todo'
  ]));
