-- Killer Kockpit — M8C3b: employee_locations junction table + RPCs
--
-- PURPOSE:
--   Canonical many-to-many relationship between employees and locations.
--   Replaces the free-form store_or_team text field for operational assignments.
--   Multiple locations per employee and multiple employees per location are
--   both supported; the table is the single source of truth for assignments.
--
-- DESIGN:
--   Soft deactivation (active = false) rather than DELETE — preserves history
--   and allows re-assignment without losing the original created_at timestamp.
--   ON CONFLICT DO UPDATE SET active = true reactivates a removed assignment.
--   Primary key is (employee_id, location_id) — uniqueness enforced by the PK;
--   no separate UNIQUE constraint needed.
--
-- SECURITY MODEL (identical to correct_update):
--   Two SECURITY DEFINER RPCs — one for add, one for remove.
--   Actor identity and role derived inside the function via get_my_app_user_id()
--   and get_my_role() — never accepted as caller arguments.
--   REVOKE EXECUTE FROM PUBLIC and anon; authenticated retains Supabase auto-grant.
--   service_role has no JWT → get_my_app_user_id() = NULL → blocked.
--
-- RLS:
--   SELECT for SUPER_ADMIN and UM only.
--   No direct client write policies — all writes go through RPCs.

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE employee_locations (
  employee_id  uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id  uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, location_id)
);

COMMENT ON TABLE employee_locations IS
  'Canonical many-to-many: which employees are assigned to which locations. '
  'Soft-deactivated rather than deleted to preserve history.';

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Fast lookup of active locations for a given employee
CREATE INDEX idx_employee_locations_employee_active
  ON employee_locations (employee_id)
  WHERE active = true;

-- Fast lookup of active employees for a given location
CREATE INDEX idx_employee_locations_location_active
  ON employee_locations (location_id)
  WHERE active = true;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE employee_locations ENABLE ROW LEVEL SECURITY;

-- SUPER_ADMIN and UM can read all active assignments
CREATE POLICY "management_read_employee_locations"
  ON employee_locations FOR SELECT
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- No direct-write policies — all writes go through SECURITY DEFINER RPCs

-- ─── add_employee_location RPC ────────────────────────────────────────────────
--
-- Adds (or reactivates) the assignment of an employee to a location.
-- Guards:
--   - Caller must be SUPER_ADMIN or UM
--   - Employee must have employment_status IN ('active', 'probation')
--   - Location must be active
-- Idempotent: calling again when already active is a no-op (returns void).
-- Reactivation: calling when active=false sets active=true.

CREATE OR REPLACE FUNCTION add_employee_location(
  p_employee_id  uuid,
  p_location_id  uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id         uuid;
  v_role            kk_role;
  v_emp_status      text;
  v_loc_active      boolean;
BEGIN
  -- ── 1. Identity + role gate ──────────────────────────────────────────────
  v_user_id := get_my_app_user_id();
  v_role    := get_my_role();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_role NOT IN ('SUPER_ADMIN', 'UM') THEN
    RAISE EXCEPTION 'Not authorised: role % cannot manage employee locations', v_role;
  END IF;

  -- ── 2. Validate employee exists and is active ─────────────────────────────
  SELECT employment_status
  INTO   v_emp_status
  FROM   employees
  WHERE  id = p_employee_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found: %', p_employee_id;
  END IF;

  IF v_emp_status NOT IN ('active', 'probation') THEN
    RAISE EXCEPTION 'Employee % is not active (status: %)', p_employee_id, v_emp_status;
  END IF;

  -- ── 3. Validate location exists and is active ─────────────────────────────
  SELECT active
  INTO   v_loc_active
  FROM   locations
  WHERE  id = p_location_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Location not found: %', p_location_id;
  END IF;

  IF NOT v_loc_active THEN
    RAISE EXCEPTION 'Location % is not active', p_location_id;
  END IF;

  -- ── 4. Upsert — insert or reactivate ─────────────────────────────────────
  INSERT INTO employee_locations (employee_id, location_id, active)
  VALUES (p_employee_id, p_location_id, true)
  ON CONFLICT (employee_id, location_id)
  DO UPDATE SET active = true
  WHERE employee_locations.active = false;
  -- WHERE clause: if already active, DO UPDATE still matches but sets active=true
  -- (no-op in practice). This avoids a redundant UPDATE when already active.

  -- ── 5. Audit ──────────────────────────────────────────────────────────────
  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    v_user_id,
    'human',
    'employee_location.added',
    'employee',
    p_employee_id,
    jsonb_build_object(
      'employee_id', p_employee_id,
      'location_id', p_location_id
    )
  );
END;
$$;

-- ─── remove_employee_location RPC ─────────────────────────────────────────────
--
-- Soft-deactivates the assignment of an employee from a location.
-- Guards:
--   - Caller must be SUPER_ADMIN or UM
--   - Assignment must exist and be active (otherwise a descriptive error is raised)

CREATE OR REPLACE FUNCTION remove_employee_location(
  p_employee_id  uuid,
  p_location_id  uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id    uuid;
  v_role       kk_role;
  v_rows       integer;
BEGIN
  -- ── 1. Identity + role gate ──────────────────────────────────────────────
  v_user_id := get_my_app_user_id();
  v_role    := get_my_role();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_role NOT IN ('SUPER_ADMIN', 'UM') THEN
    RAISE EXCEPTION 'Not authorised: role % cannot manage employee locations', v_role;
  END IF;

  -- ── 2. Soft-deactivate — only if currently active ─────────────────────────
  UPDATE employee_locations
  SET    active = false
  WHERE  employee_id = p_employee_id
    AND  location_id = p_location_id
    AND  active = true;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    -- Distinguish "never existed" from "already removed"
    IF EXISTS (
      SELECT 1 FROM employee_locations
      WHERE employee_id = p_employee_id AND location_id = p_location_id
    ) THEN
      RAISE EXCEPTION 'Assignment is already inactive';
    ELSE
      RAISE EXCEPTION 'Assignment not found';
    END IF;
  END IF;

  -- ── 3. Audit ──────────────────────────────────────────────────────────────
  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    v_user_id,
    'human',
    'employee_location.removed',
    'employee',
    p_employee_id,
    jsonb_build_object(
      'employee_id', p_employee_id,
      'location_id', p_location_id
    )
  );
END;
$$;

-- ─── Execute permissions ──────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION add_employee_location(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_employee_location(uuid, uuid) FROM anon;
-- authenticated: retains Supabase auto-grant

REVOKE EXECUTE ON FUNCTION remove_employee_location(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION remove_employee_location(uuid, uuid) FROM anon;
-- authenticated: retains Supabase auto-grant
