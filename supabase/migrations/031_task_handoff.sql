-- 031_task_handoff.sql (enum only — must commit before use)
-- The new enum value must be committed in its own transaction before it can
-- be referenced in indexes, constraints, or function bodies (PG limitation).
-- Columns, indexes, and RPCs are in migration 032.

ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'pending_review';
