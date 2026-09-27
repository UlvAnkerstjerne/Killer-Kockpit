-- Add idempotency key and status to gbp_posts.
-- request_id: client-generated UUID, unique constraint prevents duplicate execution.
-- status: tracks publish lifecycle (publishing → completed | failed).

ALTER TABLE gbp_posts
  ADD COLUMN request_id uuid UNIQUE,
  ADD COLUMN status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('publishing', 'completed', 'failed'));
