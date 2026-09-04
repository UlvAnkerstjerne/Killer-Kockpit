-- Killer Kockpit — Initial directory data
--
-- Populates the canonical Locations and People (employees) foundations
-- with the authoritative initial data set.
--
-- Idempotency:
--   locations: ON CONFLICT (name) DO NOTHING  — name is UNIQUE
--   employees: ON CONFLICT (linked_user_id) DO NOTHING — linked_user_id is UNIQUE
--   Safe to reason about as re-runnable; Supabase migrations run once.
--
-- No GBP rows are created here — GBP linking requires real Google identifiers.

-- ── Canonical locations ────────────────────────────────────────────────────────
--
-- Eight Killer Kebab physical store locations.
-- short_name is the compact display form used in lists, dropdowns, entity linking.

INSERT INTO locations (name, short_name, active) VALUES
  ('Killer Kebab Borgergade',        'Borgergade',     true),
  ('Killer Kebab Vesterbro',         'Vesterbro',       true),
  ('Killer Kebab Christianshavn',    'Christianshavn',  true),
  ('Killer Kebab Fisketorvet',       'Fisketorvet',     true),
  ('Killer Kebab Frederiksberg',     'Frederiksberg',   true),
  ('Killer Kebab Nørrebro',          'Nørrebro',        true),
  ('Killer Kebab Parken',            'Parken',          true),
  ('Killer Kebab Copenhagen Airport','Airport',         true)
ON CONFLICT (name) DO NOTHING;

-- ── Initial management directory ───────────────────────────────────────────────
--
-- One employee record per active management app_user.
-- name:          from app_users.display_name (authoritative)
-- linked_user_id: app_users.id (authoritative)
-- role_title:    NULL — not stored authoritatively in Kockpit
-- store_or_team: 'Upper Management' — reflects their org position
-- employment_status: 'active'
--
-- App user IDs verified against production app_users table 2026-09-04.

INSERT INTO employees (name, role_title, store_or_team, employment_status, linked_user_id) VALUES
  ('Ulv Ankerstjerne',  NULL, 'Upper Management', 'active', '5363b471-b4cb-4156-9e8e-3260d3ecb05e'),
  ('Adam Vearey',       NULL, 'Upper Management', 'active', 'f82bcbfa-9069-4e2a-a6d5-fceff86ecbe8'),
  ('Kasper Kristiansen',NULL, 'Upper Management', 'active', '1adf215b-6c2f-4669-899e-af544d49cd6e'),
  ('Lydia Mertiri',     NULL, 'Upper Management', 'active', '0b5b5b08-1d0b-4d13-9d93-e1b7fc2c0dc1'),
  ('Sara Jørgensen',    NULL, 'Upper Management', 'active', '1d1c6260-f084-464c-920d-5ff099d618a1')
ON CONFLICT (linked_user_id) DO NOTHING;
