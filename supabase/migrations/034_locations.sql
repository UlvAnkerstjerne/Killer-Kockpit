-- Killer Kockpit — M7A: Canonical locations + People RLS
--
-- 1. locations — thin canonical Kockpit location entity.
--    Represents Killer Kebab physical locations (stores) independently
--    of any external platform (GBP, Google, etc.).
--
-- 2. gbp_locations.location_id — FK linking each GBP location record to
--    its canonical Kockpit location. Nullable: GBP rows may exist before
--    the canonical location is set up, and canonical locations may have
--    no GBP presence.
--
-- 3. RLS for locations — SUPER_ADMIN + UM read/write. No MEMBER access.
--
-- 4. Employees UM policies — adds SELECT, INSERT, UPDATE for UM role.
--    The existing "employees: SUPER_ADMIN only" (FOR ALL) continues to
--    cover SUPER_ADMIN. UM is added here for M7A people directory access.
--    No DELETE policy: deactivate via employment_status, do not hard-delete.

-- ── locations ─────────────────────────────────────────────────────────────────

CREATE TABLE locations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,       -- "Killer Kebab Frederiksberg"
  short_name  text        NOT NULL UNIQUE,       -- "Frederiksberg"
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── GBP → canonical location mapping ─────────────────────────────────────────
-- Nullable FK: GBP rows may exist without a canonical location mapped.
-- ON DELETE SET NULL: removing a canonical location uncouples GBP, doesn't cascade.

ALTER TABLE gbp_locations
  ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX gbp_locations_location_idx ON gbp_locations(location_id)
  WHERE location_id IS NOT NULL;

-- ── RLS: locations ────────────────────────────────────────────────────────────

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "locations: management can read"
  ON locations FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "locations: management can insert"
  ON locations FOR INSERT
  TO authenticated
  WITH CHECK (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "locations: management can update"
  ON locations FOR UPDATE
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- ── RLS: employees — add UM access ───────────────────────────────────────────
-- The existing "SUPER_ADMIN only" policy (FOR ALL) remains.
-- These policies add SELECT, INSERT, UPDATE for UM.

CREATE POLICY "employees: UM can read"
  ON employees FOR SELECT
  TO authenticated
  USING (get_my_role() = 'UM');

CREATE POLICY "employees: UM can insert"
  ON employees FOR INSERT
  TO authenticated
  WITH CHECK (get_my_role() = 'UM');

CREATE POLICY "employees: UM can update"
  ON employees FOR UPDATE
  TO authenticated
  USING (get_my_role() = 'UM');
