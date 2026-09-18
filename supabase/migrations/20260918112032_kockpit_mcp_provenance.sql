-- Extend the existing Kockpit Actions ledger so multiple trusted entrypoints
-- can safely reuse the same request IDs without losing provenance.

ALTER TABLE public.kockpit_action_requests
  ADD COLUMN source text NOT NULL DEFAULT 'external_api'
  CHECK (source IN ('external_api', 'chatgpt_mcp'));

ALTER TABLE public.kockpit_action_requests
  DROP CONSTRAINT kockpit_action_requests_external_request_id_key;

ALTER TABLE public.kockpit_action_requests
  ADD CONSTRAINT kockpit_action_requests_source_request_id_key
  UNIQUE (source, external_request_id);

COMMENT ON COLUMN public.kockpit_action_requests.source IS
  'Trusted server-side entrypoint that created or attempted the action.';
