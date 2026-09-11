-- 061_diner_result_notifications.sql
--
-- Widens notifications.type and notifications.entity_type CHECK constraints
-- to support Mystery Diner result notifications.
--
-- No data migration needed — existing rows satisfy the old constraints.

-- ─── 1. Add 'diner.result' to type CHECK ──────────────────────────────────────

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
    'diner.result'
  ));

-- ─── 2. Add 'diner_submission' to entity_type CHECK ───────────────────────────

ALTER TABLE notifications
  DROP CONSTRAINT notifications_entity_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_entity_type_check
  CHECK (entity_type IN (
    'task',
    'audit_submission',
    'kkc_submission',
    'diner_submission'
  ));
