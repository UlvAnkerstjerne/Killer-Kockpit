'use server'

/**
 * lib/actions/planday-bootstrap.ts
 *
 * Planday Bootstrap P1 — read-only roster preview.
 *
 * previewPlandayBootstrap()
 *   SUPER_ADMIN-only. Fetches Planday data, reconciles it against the
 *   canonical employees table, and returns a preview — no DB writes.
 *   The import step is intentionally absent in P1.
 *
 * savePlandayCredentials()
 *   SUPER_ADMIN-only. Encrypts and stores org-level Planday credentials.
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import {
  storePlandayCredentials,
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
import { createServiceClient } from '@/lib/supabase/server'
import type {
  WorkforceRosterRecord,
  ReconciliationResult,
  ReconciliationState,
} from '@/lib/planday/types'
import type { ActionResult } from '@/lib/types'

// ─── Name normalisation ───────────────────────────────────────────────────────

/** Trim, lowercase, collapse internal whitespace for name comparison. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

// ─── Preview action ───────────────────────────────────────────────────────────

export interface PlandayPreviewResult {
  portalName: string
  totalFetched: number
  results: ReconciliationResult[]
  fetchedAt: string
}

export async function previewPlandayBootstrap(): Promise<ActionResult<PlandayPreviewResult>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessAdminSettings(user.role)) return { error: 'Not authorised' }

  // ── 1. Load stored credentials ────────────────────────────────────────────
  let credentials: Awaited<ReturnType<typeof getPlandayCredentials>>
  try {
    credentials = await getPlandayCredentials()
  } catch {
    return { error: 'Planday credentials not configured. Enter them below and try again.' }
  }

  // ── 2. Acquire access token ───────────────────────────────────────────────
  let accessToken: string
  try {
    accessToken = await getPlandayAccessToken(credentials.clientId, credentials.refreshToken)
  } catch (err) {
    return { error: `Could not connect to Planday: ${(err as Error).message}` }
  }

  // ── 3. Resolve portal ─────────────────────────────────────────────────────
  let portalId: string
  let portalName: string
  try {
    const portal = await getPortal(credentials.clientId, accessToken)
    portalId   = String(portal.id)
    portalName = portal.name
    // Cache portal metadata if it changed (first run or credential update)
    if (portalId !== credentials.portalId) {
      await updatePlandayPortal(portalId, portalName)
    }
  } catch (err) {
    return { error: `Could not fetch Planday portal: ${(err as Error).message}` }
  }

  // ── 4. Fetch all data in parallel ─────────────────────────────────────────
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
    return { error: `Failed to fetch Planday data: ${(err as Error).message}` }
  }

  // ── 5. Build earliest-shift map: Planday employee ID → ISO date ───────────
  const earliestShift = new Map<number, string>()
  for (const shift of shifts) {
    if (!shift.employeeId || !shift.date) continue
    const existing = earliestShift.get(shift.employeeId)
    if (!existing || shift.date < existing) {
      earliestShift.set(shift.employeeId, shift.date)
    }
  }

  // ── 6. Build provider-neutral WorkforceRosterRecord[] ────────────────────
  function toRecord(
    emp: (typeof activeEmps)[number],
    sourceStatus: 'active' | 'left',
  ): WorkforceRosterRecord | null {
    const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim()
    if (!name) return null

    let birthdayMonth: number | null = null
    let birthdayDay: number | null   = null
    if (emp.birthDate) {
      const parts = emp.birthDate.split('-').map(Number)
      birthdayMonth = parts[1] ?? null
      birthdayDay   = parts[2] ?? null
    }

    return {
      provider:        'planday',
      externalScope:   portalId,
      externalId:      String(emp.id),
      name,
      sourceStatus,
      birthdayMonth,
      birthdayDay,
      proposedStartedOn: earliestShift.get(emp.id) ?? null,
    }
  }

  const rosterRecords: WorkforceRosterRecord[] = [
    ...activeEmps.flatMap((e) => { const r = toRecord(e, 'active'); return r ? [r] : [] }),
    ...deactivatedEmps.flatMap((e) => { const r = toRecord(e, 'left'); return r ? [r] : [] }),
  ]

  // ── 7. Reconcile against canonical employees table ────────────────────────
  const serviceClient = createServiceClient()

  const [empResult, extIdResult] = await Promise.all([
    serviceClient.from('employees').select('id, name'),
    serviceClient
      .from('employee_external_identities')
      .select('employee_id, external_id')
      .eq('provider', 'planday')
      .eq('external_scope', portalId),
  ])

  // externalId (Planday employee ID string) → linked employee_id
  const existingLinks = new Map<string, string>()
  for (const row of (extIdResult.data ?? [])) {
    existingLinks.set(row.external_id as string, row.employee_id as string)
  }

  // normalised name → [{id, name}] — multi-value for ambiguity detection
  const nameIndex = new Map<string, Array<{ id: string; name: string }>>()
  for (const emp of (empResult.data ?? [])) {
    const norm = normalizeName(emp.name as string)
    if (!nameIndex.has(norm)) nameIndex.set(norm, [])
    nameIndex.get(norm)!.push({ id: emp.id as string, name: emp.name as string })
  }

  const results: ReconciliationResult[] = rosterRecords.map((record): ReconciliationResult => {
    const linkedId = existingLinks.get(record.externalId)
    if (linkedId) {
      const emp = (empResult.data ?? []).find((e) => e.id === linkedId)
      return {
        record,
        state: 'ALREADY_LINKED' as ReconciliationState,
        matchedEmployeeId:   linkedId,
        matchedEmployeeName: emp?.name as string | undefined,
      }
    }

    const norm    = normalizeName(record.name)
    const matches = nameIndex.get(norm) ?? []

    if (matches.length === 1) {
      return {
        record,
        state: 'EXACT_NAME_CANDIDATE' as ReconciliationState,
        matchedEmployeeId:   matches[0].id,
        matchedEmployeeName: matches[0].name,
      }
    }
    if (matches.length > 1) {
      return { record, state: 'AMBIGUOUS' as ReconciliationState }
    }
    return { record, state: 'NEW_PERSON' as ReconciliationState }
  })

  return {
    data: {
      portalName,
      totalFetched: rosterRecords.length,
      results,
      fetchedAt: new Date().toISOString(),
    },
  }
}

// ─── Credential management ────────────────────────────────────────────────────

export async function savePlandayCredentials(
  clientId: string,
  refreshToken: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessAdminSettings(user.role)) return { error: 'Not authorised' }

  if (!clientId.trim() || !refreshToken.trim()) {
    return { error: 'Both Client ID and Refresh Token are required.' }
  }

  try {
    await storePlandayCredentials(clientId.trim(), refreshToken.trim())
  } catch (err) {
    return { error: `Failed to save credentials: ${(err as Error).message}` }
  }

  revalidatePath('/settings')
  return {}
}
