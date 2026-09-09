/**
 * lib/planday/types.ts
 *
 * Provider-neutral workforce roster DTO and Planday API response shapes.
 *
 * WorkforceRosterRecord is the provider-neutral intermediate type.
 * Planday is adapter #1. Future adapters (Dully, etc.) must produce
 * the same shape, enabling the reconciliation logic to be provider-agnostic.
 */

// ─── Provider-neutral roster ──────────────────────────────────────────────────

export interface WorkforceRosterRecord {
  provider: string        // e.g. 'planday'
  externalScope: string   // scopes the ID within the provider (portal ID, company ID, etc.)
  externalId: string      // employee's ID within that scope
  name: string
  sourceStatus: 'active' | 'left'
  birthdayMonth: number | null
  birthdayDay: number | null
  /**
   * ISO date ("YYYY-MM-DD") of the earliest recorded shift.
   * Used as a proxy for employment start date where Planday has no explicit
   * hire date. May be null if no shifts exist.
   * Flagged as "earliest known Planday shift" — not guaranteed to be complete.
   */
  proposedStartedOn: string | null
}

export type ReconciliationState =
  | 'ALREADY_LINKED'        // employee_external_identities row exists
  | 'EXACT_NAME_CANDIDATE'  // unique normalised name match in employees — awaiting review
  | 'NEW_PERSON'            // no name match — would create a new employee
  | 'AMBIGUOUS'             // multiple name matches — cannot auto-resolve

export interface ReconciliationResult {
  record: WorkforceRosterRecord
  state: ReconciliationState
  matchedEmployeeId?: string
  matchedEmployeeName?: string
}

// ─── Planday API shapes ───────────────────────────────────────────────────────

export interface PlandayTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

export interface PlandayPortal {
  id: number
  name: string
  subdomain: string
}

export interface PlandayEmployee {
  id: number
  firstName: string | null
  lastName: string | null
  /** Present only when BirthDate is enabled in the Planday portal API settings. */
  birthDate: string | null  // "YYYY-MM-DD"
}

export interface PlandayShift {
  id: number
  employeeId: number | null
  date: string  // "YYYY-MM-DD"
}

export interface PlandayPage<T> {
  paging: {
    offset: number
    limit: number
    total: number
  }
  data: T[]
}

// ─── Bootstrap import decisions ───────────────────────────────────────────────

export type ImportDecisionAction = 'CREATE_NEW' | 'LINK_EXISTING' | 'SKIP'

/**
 * Client-supplied decision for one Planday employee.
 * Only externalId, action, and optionally existingEmployeeId come from the browser.
 * All name/birthday/started_on values are server-filled from fresh Planday data.
 */
export interface ImportDecision {
  externalId: string
  action: ImportDecisionAction
  existingEmployeeId?: string  // required when action === 'LINK_EXISTING'
}

export interface ImportResult {
  created: number
  linked: number
  skipped: number
  active_new: number
  former_new: number
}
