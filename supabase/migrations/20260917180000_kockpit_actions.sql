-- Kockpit Actions V1 idempotency and provenance ledger.
--
-- The endpoint authenticates with a dedicated server-side token and resolves
-- its actor internally. This table is intentionally inaccessible to browser
-- roles; only the service role used by the endpoint may read or write it.

CREATE TABLE public.kockpit_action_requests (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  external_request_id   text        NOT NULL UNIQUE,
  request_hash          text        NOT NULL,
  action_type           text        NOT NULL CHECK (action_type IN ('create_task', 'create_todo')),
  actor_user_id         uuid        NOT NULL REFERENCES public.app_users(id),
  status                text        NOT NULL DEFAULT 'processing'
                                    CHECK (status IN ('processing', 'succeeded', 'failed')),
  result_entity_type    text        CHECK (result_entity_type IN ('task', 'todo')),
  result_entity_id      uuid,
  error_code            text,
  error_message         text,
  error_status          integer     CHECK (error_status BETWEEN 400 AND 599),
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,

  CONSTRAINT kockpit_action_result_complete CHECK (
    status <> 'succeeded'
    OR (result_entity_type IS NOT NULL AND result_entity_id IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT kockpit_action_failure_complete CHECK (
    status <> 'failed'
    OR (error_code IS NOT NULL AND error_message IS NOT NULL AND error_status IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX kockpit_action_requests_actor_created_idx
  ON public.kockpit_action_requests (actor_user_id, created_at DESC);

CREATE INDEX kockpit_action_requests_result_idx
  ON public.kockpit_action_requests (result_entity_type, result_entity_id)
  WHERE result_entity_id IS NOT NULL;

ALTER TABLE public.kockpit_action_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kockpit_action_requests FROM anon, authenticated;
REVOKE DELETE ON TABLE public.kockpit_action_requests FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.kockpit_action_requests TO service_role;

COMMENT ON TABLE public.kockpit_action_requests IS
  'Idempotency and provenance for the trusted Kockpit Actions write API.';
