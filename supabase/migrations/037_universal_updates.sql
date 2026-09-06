-- Killer Kockpit — M8A2: Universal Updates data schema
--
-- Introduces the kk_updates primitive: small, human-authored / human-approved
-- atomic statements of organisational knowledge, attached to entities.
--
-- Design decisions (from M8A1b contract):
--   • author FK → app_users(id), NOT auth.users(id)  (canonical internal identity)
--   • occurred_on DATE NULL  (date-precision knowledge; no invented timestamps)
--   • append-only: no updated_at, no is_superseded flag
--   • supersession via supersedes_update_id UNIQUE (prevents branching)
--   • provenance deferred: entity_sources will use entity_type='update' in M8C
--   • RLS: SELECT only for SUPER_ADMIN / UM; writes default-denied until M8A3
--
-- Tables:
--   kk_updates         — the update record
--   kk_update_entities — links one update to one or more subject entities

-- ─── kk_updates ───────────────────────────────────────────────────────────────

CREATE TABLE kk_updates (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  body                 text        NOT NULL,
  created_by_user_id   uuid        NOT NULL REFERENCES app_users(id),
  occurred_on          date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  supersedes_update_id uuid        UNIQUE REFERENCES kk_updates(id),

  -- Body must not be blank
  CONSTRAINT kk_updates_body_nonempty CHECK (length(trim(body)) > 0),

  -- An update cannot supersede itself
  CONSTRAINT kk_updates_no_self_supersede
    CHECK (supersedes_update_id IS NULL OR supersedes_update_id <> id)
);

-- ─── kk_update_entities ───────────────────────────────────────────────────────

CREATE TABLE kk_update_entities (
  update_id   uuid NOT NULL REFERENCES kk_updates(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,

  PRIMARY KEY (update_id, entity_type, entity_id),

  -- v1 subject allowlist; relax in a future migration when new entity types are added
  CONSTRAINT kk_update_entities_entity_type_check
    CHECK (entity_type IN ('project', 'employee', 'location'))
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX kk_updates_created_by_idx
  ON kk_updates (created_by_user_id);

CREATE INDEX kk_updates_occurred_on_idx
  ON kk_updates (occurred_on DESC NULLS LAST)
  WHERE occurred_on IS NOT NULL;

CREATE INDEX kk_updates_created_at_idx
  ON kk_updates (created_at DESC);

CREATE INDEX kk_update_entities_entity_idx
  ON kk_update_entities (entity_type, entity_id);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE kk_updates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kk_update_entities ENABLE ROW LEVEL SECURITY;

-- SELECT: SUPER_ADMIN and UM only
-- Uses existing get_my_role() helper (security definer, reads app_users via auth.uid())

CREATE POLICY "kk_updates: management can read"
  ON kk_updates
  FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "kk_update_entities: management can read"
  ON kk_update_entities
  FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- INSERT / UPDATE / DELETE: intentionally no policies in M8A2.
-- Default-deny applies — the PostgreSQL default when RLS is enabled and no
-- permissive policy exists for an operation.
-- The controlled write path (M8A3) will use a SECURITY DEFINER RPC or
-- a server action with explicit get_my_app_user_id() enforcement.
