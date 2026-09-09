/**
 * lib/planday/client.ts
 *
 * Planday OpenAPI client — read-only, server-only.
 *
 * Design:
 *   • Raw fetch, no SDK dependency.
 *   • All 4 methods accept decrypted credentials directly (no DB access here).
 *   • Pagination handled internally via offset; callers receive complete arrays.
 *   • 429 responses throw PlandayRateLimitError — caller decides retry policy.
 *   • MAX_PAGES safety cap prevents infinite loops on unexpected API behaviour.
 *   • Fail-whole-on-partial-failure: any page error aborts the entire fetch.
 *
 * Auth model:
 *   POST https://id.planday.com/connect/token with client_id + refresh_token
 *   → short-lived access_token
 *   Subsequent calls: X-ClientId header + Authorization: Bearer <access_token>
 */

import type { PlandayEmployee, PlandayShift, PlandayPage } from './types'

const PLANDAY_ID_URL  = 'https://id.planday.com'
const PLANDAY_API_URL = 'https://openapi.planday.com'
const MAX_PAGES = 200  // ~200k employees or 1M shifts at default page sizes

// ─── Error types ──────────────────────────────────────────────────────────────

export class PlandayApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'PlandayApiError'
  }
}

export class PlandayRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlandayRateLimitError'
  }
}

// ─── Token exchange ───────────────────────────────────────────────────────────

/** Exchange a Planday refresh_token for a short-lived access_token. */
export async function getPlandayAccessToken(
  clientId: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
  })

  const res = await fetch(`${PLANDAY_ID_URL}/connect/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })

  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || !json.access_token) {
    throw new PlandayApiError(
      `Failed to refresh Planday access token: ${(json.error as string | undefined) ?? res.status}`,
      res.status,
    )
  }
  return json.access_token as string
}

// ─── Internal fetch helpers ───────────────────────────────────────────────────

function buildHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    'X-ClientId':    clientId,
    'Authorization': `Bearer ${accessToken}`,
    'Accept':        'application/json',
  }
}

async function plandayGet<T>(
  path: string,
  clientId: string,
  accessToken: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${PLANDAY_API_URL}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), {
    headers: buildHeaders(clientId, accessToken),
    cache:   'no-store',
  })

  if (res.status === 429) {
    throw new PlandayRateLimitError('Planday rate limit exceeded — try again later.')
  }

  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    throw new PlandayApiError(
      `Planday API ${res.status}: ${JSON.stringify(json)}`,
      res.status,
    )
  }
  return json as T
}

async function fetchAllPlandayPages<T>(
  path: string,
  clientId: string,
  accessToken: string,
  extraParams: Record<string, string> = {},
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = []
  let offset = 0
  let pages  = 0

  while (pages < MAX_PAGES) {
    const page = await plandayGet<PlandayPage<T>>(path, clientId, accessToken, {
      ...extraParams,
      offset: String(offset),
      limit:  String(pageSize),
    })

    results.push(...(page.data ?? []))
    pages++

    offset += page.data?.length ?? 0
    if (offset >= page.paging.total || !page.data?.length) break
  }

  return results
}

// ─── Exported API methods ─────────────────────────────────────────────────────

export interface PlandayPortalInfo {
  id: number
  name: string
}

/**
 * Returns the first portal accessible to the stored credentials.
 * Most Planday accounts have exactly one portal.
 */
export async function getPortal(
  clientId: string,
  accessToken: string,
): Promise<PlandayPortalInfo> {
  const body = await plandayGet<{ data: { id: number; name: string; companyName?: string } }>(
    '/portal/v1.0/info',
    clientId,
    accessToken,
  )
  const portal = body.data
  if (!portal?.id) {
    throw new PlandayApiError('No Planday portal is accessible with these credentials.')
  }
  return { id: portal.id, name: portal.companyName ?? portal.name }
}

/**
 * Fetches all active employees.
 * Requires employee:read scope + BirthDate enabled in Planday portal API settings
 * to receive the birthDate field.
 */
export async function getActiveEmployeesWithBirthDate(
  clientId: string,
  accessToken: string,
): Promise<PlandayEmployee[]> {
  return fetchAllPlandayPages<PlandayEmployee>(
    '/hr/v1.0/employees',
    clientId,
    accessToken,
    { fields: 'id,firstName,lastName', special: 'BirthDate' },
  )
}

/**
 * Fetches all deactivated (former) employees.
 * Requires employee:read scope + BirthDate enabled in portal API settings
 * to receive the birthDate field.
 */
export async function getDeactivatedEmployeesWithBirthDate(
  clientId: string,
  accessToken: string,
): Promise<PlandayEmployee[]> {
  return fetchAllPlandayPages<PlandayEmployee>(
    '/hr/v1.0/employees/deactivated',
    clientId,
    accessToken,
    { fields: 'id,firstName,lastName', special: 'BirthDate' },
  )
}

/**
 * Fetches all active employees for lightweight sync (no BirthDate, no shifts).
 * Only requests id, firstName, lastName — sufficient for P3 roster sync.
 */
export async function getActiveEmployees(
  clientId: string,
  accessToken: string,
): Promise<Pick<PlandayEmployee, 'id' | 'firstName' | 'lastName'>[]> {
  return fetchAllPlandayPages<Pick<PlandayEmployee, 'id' | 'firstName' | 'lastName'>>(
    '/hr/v1.0/employees',
    clientId,
    accessToken,
    { fields: 'id,firstName,lastName' },
  )
}

/**
 * Fetches all deactivated employees for lightweight sync (no BirthDate, no shifts).
 * Only requests id, firstName, lastName — sufficient for P3 roster sync.
 */
export async function getDeactivatedEmployees(
  clientId: string,
  accessToken: string,
): Promise<Pick<PlandayEmployee, 'id' | 'firstName' | 'lastName'>[]> {
  return fetchAllPlandayPages<Pick<PlandayEmployee, 'id' | 'firstName' | 'lastName'>>(
    '/hr/v1.0/employees/deactivated',
    clientId,
    accessToken,
    { fields: 'id,firstName,lastName' },
  )
}

/**
 * Fetches all shifts from fromDate (default 2020-01-01) to today.
 * Used to derive proposedStartedOn — the earliest shift date per employee.
 * Requires shift:read scope.
 *
 * Note: Shift history may be incomplete for very long-tenured employees if
 * Planday data pre-dates the fromDate.  proposedStartedOn is always flagged
 * as "earliest known Planday shift" and must be reviewed before use.
 */
export async function getHistoricalShifts(
  clientId: string,
  accessToken: string,
  fromDate = '2020-01-01',
): Promise<PlandayShift[]> {
  const today = new Date().toISOString().slice(0, 10)
  return fetchAllPlandayPages<PlandayShift>(
    '/scheduling/v1.0/shifts',
    clientId,
    accessToken,
    { fields: 'id,employeeId,date', from: fromDate, to: today },
    5000,  // Planday supports up to 5000 shifts per page
  )
}
