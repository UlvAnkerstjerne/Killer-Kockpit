-- 062_audit_followup_escalation_notifications.sql
--
-- Widens notifications.type CHECK to include 'audit.followup.overdue'.
-- Used by the overdue Red Flag follow-up escalation job which sends
-- Kockpit notifications to Kasper, the Regional Manager, and Ulv when
-- a Red Flag follow-up has passed its due date without being resolved.
--
-- Entity routing is unchanged: escalation notifications use entity_type
-- 'audit_submission' (already in the constraint) so the bell routes to
-- the existing audit detail page via /kkc/audit/{submissionId}.
-- No new entity_type column value is needed.

ALTER TABLE notifications
  DROP CONSTRAINT notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'task.assigned',
    'task.submitted_for_review',
    'task.sent_back',
    'task.approved',
    'audit.result',
    'kkc.result',
    'diner.result',
    'audit.followup.overdue'
  ));
