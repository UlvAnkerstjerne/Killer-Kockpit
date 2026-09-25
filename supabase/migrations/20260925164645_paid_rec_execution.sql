-- Execution layer for paid recommendations.
-- Allows approved recommendations to create Tasks, start monitoring windows,
-- and track execution outcomes.

ALTER TABLE public.paid_recommendations
  ADD COLUMN execution_type text,
  ADD COLUMN execution_status text NOT NULL DEFAULT 'pending_approval',
  ADD COLUMN execution_started_at timestamptz,
  ADD COLUMN execution_completed_at timestamptz,
  ADD COLUMN execution_result jsonb,
  ADD COLUMN linked_task_id uuid REFERENCES public.tasks(id);

-- Constraint: execution_type must be one of the known types or null
ALTER TABLE public.paid_recommendations
  ADD CONSTRAINT paid_rec_execution_type_check
  CHECK (execution_type IS NULL OR execution_type IN (
    'create_task', 'monitor', 'create_task_and_monitor', 'platform_action'
  ));

-- Constraint: execution_status must be valid
ALTER TABLE public.paid_recommendations
  ADD CONSTRAINT paid_rec_execution_status_check
  CHECK (execution_status IN (
    'pending_approval', 'in_motion', 'completed', 'failed', 'needs_attention'
  ));

-- Index for the monitoring cron to find in-motion recommendations efficiently
CREATE INDEX paid_rec_in_motion_idx ON public.paid_recommendations(execution_status)
  WHERE execution_status = 'in_motion';

-- Index for duplicate suppression: find active recommendations per campaign
CREATE INDEX paid_rec_active_campaign_idx ON public.paid_recommendations(platform, campaign_id, execution_status)
  WHERE execution_status IN ('pending_approval', 'in_motion');

-- Backfill: existing approved/dismissed recommendations get null execution_type
-- (they predate the execution layer). The default pending_approval is fine for
-- needs_review rows — they'll get execution_type set by the next generation run.
