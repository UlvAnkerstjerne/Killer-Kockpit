'use server'

import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import type { ActionResult } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Loose UUID format check — DB will reject malformed ids anyway */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LocationForEmployee {
  location_id: string
  name:        string
  short_name:  string
  active:      boolean
}

export interface EmployeeForLocation {
  employee_id:       string
  name:              string
  role_title:        string | null
  employment_status: string
}

// ─── addEmployeeLocation ──────────────────────────────────────────────────────

/**
 * Assigns an employee to a location via the add_employee_location SECURITY DEFINER RPC.
 *
 * Idempotent: calling again when the assignment is already active is a no-op.
 * Reactivates a previously removed assignment.
 * Author identity and role verified inside the DB — never caller-supplied.
 */
export async function addEmployeeLocation(
  employeeId: string,
  locationId: string,
): Promise<ActionResult> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  // ── 2. Role gate ──────────────────────────────────────────────────────────
  if (!canAccessManagementView(user.role)) {
    return { error: 'Not authorised to manage employee locations.' }
  }

  // ── 3. Validate inputs ────────────────────────────────────────────────────
  if (!employeeId || !UUID_RE.test(employeeId)) {
    return { error: 'Invalid employee id.' }
  }
  if (!locationId || !UUID_RE.test(locationId)) {
    return { error: 'Invalid location id.' }
  }

  // ── 4. RPC via authenticated session client ───────────────────────────────
  const supabase = await createClient()
  const { error } = await supabase.rpc('add_employee_location', {
    p_employee_id: employeeId,
    p_location_id: locationId,
  })

  if (error) {
    console.error('[addEmployeeLocation]', error.message)
    if (error.message.includes('not found')) {
      return { error: 'Employee or location not found.' }
    }
    if (error.message.includes('not active')) {
      return { error: 'Employee or location is not active.' }
    }
    return { error: 'Failed to add location assignment. Please try again.' }
  }

  return { data: undefined }
}

// ─── removeEmployeeLocation ───────────────────────────────────────────────────

/**
 * Soft-deactivates an employee↔location assignment via the
 * remove_employee_location SECURITY DEFINER RPC.
 *
 * The row is never deleted — active is set to false. The assignment can be
 * re-added (reactivated) with addEmployeeLocation.
 * Author identity and role verified inside the DB — never caller-supplied.
 */
export async function removeEmployeeLocation(
  employeeId: string,
  locationId: string,
): Promise<ActionResult> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  // ── 2. Role gate ──────────────────────────────────────────────────────────
  if (!canAccessManagementView(user.role)) {
    return { error: 'Not authorised to manage employee locations.' }
  }

  // ── 3. Validate inputs ────────────────────────────────────────────────────
  if (!employeeId || !UUID_RE.test(employeeId)) {
    return { error: 'Invalid employee id.' }
  }
  if (!locationId || !UUID_RE.test(locationId)) {
    return { error: 'Invalid location id.' }
  }

  // ── 4. RPC via authenticated session client ───────────────────────────────
  const supabase = await createClient()
  const { error } = await supabase.rpc('remove_employee_location', {
    p_employee_id: employeeId,
    p_location_id: locationId,
  })

  if (error) {
    console.error('[removeEmployeeLocation]', error.message)
    if (error.message.includes('already inactive')) {
      return { error: 'This assignment has already been removed.' }
    }
    if (error.message.includes('not found')) {
      return { error: 'Assignment not found.' }
    }
    return { error: 'Failed to remove location assignment. Please try again.' }
  }

  return { data: undefined }
}

// ─── getLocationsForEmployee ──────────────────────────────────────────────────

/**
 * Returns all active location assignments for an employee, enriched with
 * location name and short_name from the canonical locations table.
 *
 * Only active assignments (active=true) against active locations are returned.
 * Two-query approach: first fetch active location IDs from the junction table,
 * then join to the locations table for canonical fields.
 */
export async function getLocationsForEmployee(
  employeeId: string,
): Promise<ActionResult<LocationForEmployee[]>> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  if (!canAccessManagementView(user.role)) {
    return { error: 'Not authorised to view employee locations.' }
  }

  // ── 2. Validate ───────────────────────────────────────────────────────────
  if (!employeeId || !UUID_RE.test(employeeId)) {
    return { error: 'Invalid employee id.' }
  }

  const supabase = await createClient()

  // ── 3. Active location IDs for this employee ──────────────────────────────
  const { data: assignments, error: assignErr } = await supabase
    .from('employee_locations')
    .select('location_id')
    .eq('employee_id', employeeId)
    .eq('active', true)

  if (assignErr) {
    console.error('[getLocationsForEmployee] assignments', assignErr.message)
    return { error: 'Failed to load location assignments. Please try again.' }
  }

  if (!assignments || assignments.length === 0) return { data: [] }

  const locationIds = assignments.map((a) => a.location_id)

  // ── 4. Canonical location rows ────────────────────────────────────────────
  const { data: locationRows, error: locErr } = await supabase
    .from('locations')
    .select('id, name, short_name, active')
    .in('id', locationIds)
    .eq('active', true)
    .order('name')

  if (locErr) {
    console.error('[getLocationsForEmployee] locations', locErr.message)
    return { error: 'Failed to load location assignments. Please try again.' }
  }

  const result: LocationForEmployee[] = (locationRows ?? []).map((l) => ({
    location_id: l.id,
    name:        l.name,
    short_name:  l.short_name,
    active:      l.active,
  }))

  return { data: result }
}

// ─── getEmployeesForLocation ──────────────────────────────────────────────────

/**
 * Returns all active employee assignments for a location, enriched with
 * employee name, role_title, and employment_status from the canonical
 * employees table.
 *
 * Only active assignments against active employees are returned.
 * Two-query approach for the same reason as getLocationsForEmployee.
 */
export async function getEmployeesForLocation(
  locationId: string,
): Promise<ActionResult<EmployeeForLocation[]>> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  if (!canAccessManagementView(user.role)) {
    return { error: 'Not authorised to view location employees.' }
  }

  // ── 2. Validate ───────────────────────────────────────────────────────────
  if (!locationId || !UUID_RE.test(locationId)) {
    return { error: 'Invalid location id.' }
  }

  const supabase = await createClient()

  // ── 3. Active employee IDs for this location ──────────────────────────────
  const { data: assignments, error: assignErr } = await supabase
    .from('employee_locations')
    .select('employee_id')
    .eq('location_id', locationId)
    .eq('active', true)

  if (assignErr) {
    console.error('[getEmployeesForLocation] assignments', assignErr.message)
    return { error: 'Failed to load employee assignments. Please try again.' }
  }

  if (!assignments || assignments.length === 0) return { data: [] }

  const employeeIds = assignments.map((a) => a.employee_id)

  // ── 4. Canonical employee rows ────────────────────────────────────────────
  const { data: employeeRows, error: empErr } = await supabase
    .from('employees')
    .select('id, name, role_title, employment_status')
    .in('id', employeeIds)
    .in('employment_status', ['active', 'probation'])
    .order('name')

  if (empErr) {
    console.error('[getEmployeesForLocation] employees', empErr.message)
    return { error: 'Failed to load employee assignments. Please try again.' }
  }

  const result: EmployeeForLocation[] = (employeeRows ?? []).map((e) => ({
    employee_id:       e.id,
    name:              e.name,
    role_title:        e.role_title,
    employment_status: e.employment_status,
  }))

  return { data: result }
}
