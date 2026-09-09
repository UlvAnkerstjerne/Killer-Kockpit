'use server'

/**
 * lib/actions/planday-import.ts
 *
 * Planday Bootstrap P2 — human-reviewed controlled import.
 *
 * getKKEmployeesForLinking()
 *   Returns all KK employees as {id, name} for the employee picker UI.
 *   SUPER_ADMIN-only.
 *
 * executeBootstrapImport(decisions)
 *   SUPER_ADMIN-only.  On confirm the server re-fetches all Planday data so
 *   the import is never based on stale preview state.  The client only
 *   supplies {externalId, action, existingEmployeeId?}.  All authoritative
 *   fields (name, birthday, started_on) are filled server-side from fresh
 *   Planday data — the browser cannot inject arbitrary employee data.
 *
 *   Calls the planday_bootstrap_import SECURITY DEFINER RPC via the user-JWT
 *   client so the function can derive actor identity and enforce SUPER_ADMIN
 *   from inside the DB.
 */

import { getCurrentUser } from '@/lib/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import {
  getPlandayCredentials,
  updatePlandayPortal,
} from '@/lib/planday/auth'
import {
  getPlandayAccessToken,
  getPortal,
  getActiveEmployeesWithBirthDate,
  getDeactivatedEmployeesWithBirthDate,
  getHistoricalShifts,
} from '@/lib/planday/client'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import type { ImportDecision, ImportResult } from '@/lib/planday/types'
import type { ActionResult } from '@/lib/types'

// ─── Employee list for the picker ─────────────────────────────────────────────

export async function getKKEmployeesForLinking(): Promise<
  ActionResult<{ id: string; name: string }[]>
> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessAdminSettings(user.role)) return { error: 'Not authorised' }

  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient
    .from('employees')
    .select('id, name')
    .order('name')

  if (error) return { error: `Failed to load employees: ${error.message}` }
  return { data: (data ?? []) as { id: string; name: string }[] }
}

// ─── Import execution ─────────────────────────────────────────────────────────

export async function executeBootstrapImport(
  decisions: ImportDecision[],
): Promise<ActionResult<ImportResult>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessAdminSettings(user.role)) return { error: 'Not authorised' }

  if (!decisions.length) return { error: 'No decisions provided.' }

  // ── 1. Load stored credentials ─────────────────────────────────────────────
  let credentials: Awaited<ReturnType<typeof getPlandayCredentials>>
  try {
    credentials = await getPlandayCredentials()
  } catch {
    return { error: 'Planday credentials not configured.' }
  }

  // ── 2. Acquire fresh access token ─────────────────────────────────────────
  let accessToken: string
  try {
    accessToken = await getPlandayAccessToken(credentials.clientId, credentials.refreshToken)
  } catch (err) {
    return { error: `Could not connect to Planday: ${(err as Error).message}` }
  }

  // ── 3. Resolve portal ──────────────────────────────────────────────────────
  let portalId: string
  try {
    const portal = await getPortal(credentials.clientId, accessToken)
    portalId = String(portal.id)
    if (portalId !== credentials.portalId) {
      await updatePlandayPortal(portalId, portal.name)
    }
  } catch (err) {
    return { error: `Could not fetch Planday portal: ${(err as Error).message}` }
  }

  // ── 4. Re-fetch all Planday data fresh (stale-preview safety) ─────────────
  let activeEmps: Awaited<ReturnType<typeof getActiveEmployeesWithBirthDate>>
  let deactivatedEmps: Awaited<ReturnType<typeof getDeactivatedEmployeesWithBirthDate>>
  let shifts: Awaited<ReturnType<typeof getHistoricalShifts>>

  try {
    ;[activeEmps, deactivatedEmps, shifts] = await Promise.all([
      getActiveEmployeesWithBirthDate(credentials.clientId, accessToken),
      getDeactivatedEmployeesWithBirthDate(credentials.clientId, accessToken),
      getHistoricalShifts(credentials.clientId, accessToken),
    ])
  } catch (err) {
    return { error: `Failed to fetch fresh Planday data: ${(err as Error).message}` }
  }

  // ── 5. Build lookup maps from fresh Planday data ───────────────────────────
  // externalId → Planday employee object
  const plandayById = new Map<string, { name: string; status: 'active' | 'left'; birthdayMonth: number | null; birthdayDay: number | null }>()

  function parsePlandayEmployee(
    emp: (typeof activeEmps)[number],
    status: 'active' | 'left',
  ) {
    const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim()
    if (!name) return

    let birthdayMonth: number | null = null
    let birthdayDay: number | null = null
    if (emp.birthDate) {
      const parts = emp.birthDate.split('-').map(Number)
      birthdayMonth = parts[1] ?? null
      birthdayDay   = parts[2] ?? null
    }

    plandayById.set(String(emp.id), { name, status, birthdayMonth, birthdayDay })
  }

  for (const e of activeEmps) parsePlandayEmployee(e, 'active')
  for (const e of deactivatedEmps) parsePlandayEmployee(e, 'left')

  // externalId → earliest shift date
  const earliestShift = new Map<string, string>()
  for (const shift of shifts) {
    if (!shift.employeeId || !shift.date) continue
    const key = String(shift.employeeId)
    const existing = earliestShift.get(key)
    if (!existing || shift.date < existing) {
      earliestShift.set(key, shift.date)
    }
  }

  // ── 6. Validate decisions and build server-verified RPC payload ────────────
  const rpcDecisions: Record<string, unknown>[] = []

  for (const decision of decisions) {
    const { externalId, action, existingEmployeeId } = decision

    if (!externalId?.trim()) {
      return { error: `Decision has empty externalId.` }
    }
    if (!['CREATE_NEW', 'LINK_EXISTING', 'SKIP'].includes(action)) {
      return { error: `Invalid action "${action}" for externalId ${externalId}.` }
    }

    if (action === 'SKIP') {
      rpcDecisions.push({ external_id: externalId, action: 'SKIP' })
      continue
    }

    // For CREATE_NEW and LINK_EXISTING, server must verify the Planday employee exists
    const plandayEmp = plandayById.get(externalId)
    if (!plandayEmp) {
      // Employee not found in fresh Planday data — treat as SKIP with a note
      // (may have been removed from Planday between preview and confirm)
      rpcDecisions.push({ external_id: externalId, action: 'SKIP' })
      continue
    }

    if (action === 'CREATE_NEW') {
      rpcDecisions.push({
        external_id:        externalId,
        action:             'CREATE_NEW',
        name:               plandayEmp.name,
        employment_status:  plandayEmp.status,
        birthday_month:     plandayEmp.birthdayMonth,
        birthday_day:       plandayEmp.birthdayDay,
        started_on:         earliestShift.get(externalId) ?? null,
      })
      continue
    }

    if (action === 'LINK_EXISTING') {
      if (!existingEmployeeId?.trim()) {
        return { error: `LINK_EXISTING requires existingEmployeeId for externalId ${externalId}.` }
      }
      rpcDecisions.push({
        external_id:           externalId,
        action:                'LINK_EXISTING',
        employee_id:           existingEmployeeId,
        offer_birthday_month:  plandayEmp.birthdayMonth,
        offer_birthday_day:    plandayEmp.birthdayDay,
        offer_started_on:      earliestShift.get(externalId) ?? null,
      })
      continue
    }
  }

  // ── 7. Call SECURITY DEFINER RPC via user-JWT client ─────────────────────
  // The RPC derives actor identity and enforces SUPER_ADMIN inside the DB.
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('planday_bootstrap_import', {
    p_portal_id: portalId,
    p_decisions: rpcDecisions,
  })

  if (error) {
    return { error: `Import failed: ${error.message}` }
  }

  return { data: data as ImportResult }
}
