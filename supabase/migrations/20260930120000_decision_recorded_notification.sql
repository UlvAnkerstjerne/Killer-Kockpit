-- 20260930120000_decision_recorded_notification.sql
--
-- Widens notifications.type CHECK to include 'decision.recorded'.
-- entity_type 'decision' is already allowed (added in 056).

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'task.assigned', 'task.submitted_for_review', 'task.sent_back', 'task.approved',
    'audit.result', 'kkc.result', 'diner.result', 'audit.followup.overdue',
    'todo.completed', 'decision.recorded'
  ]));
