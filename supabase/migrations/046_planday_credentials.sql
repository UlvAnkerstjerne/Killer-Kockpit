-- 046_planday_credentials.sql
--
-- Planday API credential storage (org-scoped, singleton row).
--
-- Design:
--   • Exactly one row, enforced by singleton_key PRIMARY KEY with CHECK.
--   • client_id and refresh_token are AES-256-GCM encrypted at rest.
--     The key lives in PLANDAY_TOKEN_ENCRYPTION_KEY (env var, never in DB).
--   • portal_id / portal_name are cached after the first successful getPortal
--     call; they are not secret and are stored in plain text.
--   • RLS enabled — no broad client policies; service_role only.
--     The table is invisible to PostgREST (no anon/authenticated policies).

CREATE TABLE planday_credentials (
  singleton_key           text        PRIMARY KEY DEFAULT 'default'
                                      CHECK (singleton_key = 'default'),
  encrypted_client_id     text        NOT NULL,
  encrypted_refresh_token text        NOT NULL,
  portal_id               text,
  portal_name             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE planday_credentials ENABLE ROW LEVEL SECURITY;

-- No broad client SELECT/INSERT/UPDATE/DELETE policies.
-- All access is via service_role (createServiceClient) in server actions.
