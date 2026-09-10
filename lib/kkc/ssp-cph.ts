/**
 * lib/kkc/ssp-cph.ts
 *
 * Data pipeline for Killer Kuality Check — SSP / CPH Airport.
 *
 * CREDENTIAL MODEL — company/system, not per-user
 * ------------------------------------------------
 * Follows the same pattern as lib/gbp/sync.ts:
 *   Find the first stored Google token whose scopes include spreadsheets.readonly.
 *   Use that credential to read the sheet on behalf of the whole system.
 *   No individual viewer (UM, SUPER_ADMIN) needs their own Sheets scope.
 *   Only ONE user (Ulv / the company admin) needs to grant spreadsheets.readonly once.
 *
 * CACHE — Next.js unstable_cache (Data Cache)
 * -------------------------------------------
 *   - 15-minute TTL via revalidate: 900
 *   - Shared across all server requests and instances (not process-local)
 *   - Manual refresh: call invalidateKKCCache() → revalidateTag → next render re-fetches
 *   - No cron, no background polling, no new DB tables
 */

import { unstable_cache } from 'next/cache'
import { revalidateTag } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { hasSheetsScope, getGoogleOAuth2Client } from '@/lib/google/auth'
import { fetchKKCRawData } from '@/lib/google/sheets'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KKCScoreRow {
  timestamp:        string   // raw from sheet — used as unique key
  date:             string
  time:             string
  mysteryDiner:     string
  productsOrdered:  string
  overallScore:     number   // 0–100
  criticalScore:    number   // 0–100
  criticalFailures: number
}

export interface KKCConfigCheckpoint {
  section:        string
  checkpoint:     string
  isCritical:     boolean
  responseHeader: string    // exact column header in Form Responses 1
}

export type KKCResult = 'Acceptable' | 'Unacceptable'

export interface KKCCheckpointResult {
  section:    string
  checkpoint: string
  isCritical: boolean
  result:     KKCResult | null  // null = not assessed (blank cell)
}

export interface KKCSectionComment {
  header: string   // raw column header (e.g., "Comments (Kebab Wrap)")
  text:   string
}

export interface KKCSubmissionDetail {
  timestamp:              string
  date:                   string
  time:                   string
  mysteryDiner:           string
  productsOrdered:        string
  overallScore:           number
  criticalScore:          number
  criticalFailures:       number
  checkpoints:            KKCCheckpointResult[]
  criticalFailureDetails: KKCCheckpointResult[]
  sectionComments:        KKCSectionComment[]
  overallComments:        string | null
}

export interface KKCSspCphData {
  scores:      KKCScoreRow[]
  config:      KKCConfigCheckpoint[]
  formHeaders: string[]
  formRows:    string[][]   // raw form rows — detail view is built on demand client-side
  fetchedAt:   string       // ISO string, embedded in cached payload
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Parses a score value that may be a percentage string ("92%"), a decimal
 * (0.92), or a plain integer (92). Returns a 0–100 integer.
 */
function parseScore(val: string | undefined): number {
  if (!val) return 0
  const s = val.trim()
  if (s.endsWith('%')) return Math.round(parseFloat(s))
  const n = parseFloat(s)
  if (isNaN(n)) return 0
  if (n >= 0 && n <= 1) return Math.round(n * 100)
  return Math.round(n)
}

function parseScoreRows(rows: string[][]): KKCScoreRow[] {
  return rows.map((row) => ({
    timestamp:        row[0] ?? '',
    date:             row[1] ?? '',
    time:             row[2] ?? '',
    mysteryDiner:     row[3] ?? '',
    productsOrdered:  row[4] ?? '',
    overallScore:     parseScore(row[5]),
    criticalScore:    parseScore(row[6]),
    criticalFailures: parseInt(row[7] ?? '0', 10) || 0,
  }))
}

function parseConfigRows(rows: string[][]): KKCConfigCheckpoint[] {
  return rows.map((row) => ({
    section:        row[0] ?? '',
    checkpoint:     row[1] ?? '',
    isCritical:     /^(yes|true|1)$/i.test(row[2] ?? ''),
    responseHeader: row[3] ?? '',
  }))
}

// ─── System credential lookup ─────────────────────────────────────────────────

/**
 * Finds the first stored Google token that has the spreadsheets.readonly scope
 * and returns a ready OAuth2Client.
 *
 * This is the company-credential lookup — identical in pattern to the GBP
 * sync user lookup in app/api/gbp/sync/route.ts.
 *
 * Returns null if no user has granted the Sheets scope yet.
 * In that case, a SUPER_ADMIN must visit Settings → Google Workspace → Sheets → Enable.
 */
async function getSheetsOAuthClient() {
  const db = createServiceClient()
  const { data: tokenRows } = await db
    .from('google_oauth_tokens')
    .select('user_id, scopes')

  const syncUserId = tokenRows?.find(
    (row) => hasSheetsScope((row.scopes as string[]) ?? []),
  )?.user_id as string | undefined

  if (!syncUserId) return null
  return getGoogleOAuth2Client(syncUserId)
}

// ─── Fetch + parse ────────────────────────────────────────────────────────────

/**
 * Fetches and parses live KKC SSP/CPH data directly from Google Sheets,
 * bypassing the Next.js Data Cache.
 *
 * Use this in server-side jobs and scripts that need fresh data without
 * going through unstable_cache (e.g. the automated delivery service).
 *
 * Throws 'no_sheets_credential' if no user has granted spreadsheets.readonly.
 */
export async function fetchSSPCphDataDirect(): Promise<KKCSspCphData> {
  return fetchSSPCphFromSheets()
}

async function fetchSSPCphFromSheets(): Promise<KKCSspCphData> {
  const oauthClient = await getSheetsOAuthClient()
  if (!oauthClient) {
    throw new Error('no_sheets_credential')
  }

  const raw = await fetchKKCRawData(oauthClient)

  return {
    scores:      parseScoreRows(raw.scoresRows),
    config:      parseConfigRows(raw.configRows),
    formHeaders: raw.formHeaders,
    formRows:    raw.formRows,
    fetchedAt:   new Date().toISOString(),
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const KKC_CACHE_TAG = 'kkc-ssp-cph'

/**
 * Fetches and caches KKC SSP/CPH data using Next.js Data Cache.
 *
 * TTL: 15 minutes (revalidate: 900).
 * Shared across all server instances — not process-local like a module Map.
 * Invalidated by calling invalidateKKCCache() (used by the Refresh endpoint).
 */
export const getSSPCphData = unstable_cache(
  fetchSSPCphFromSheets,
  [KKC_CACHE_TAG],
  { tags: [KKC_CACHE_TAG], revalidate: 900 },
)

/**
 * Marks the KKC cache as stale.
 * The next call to getSSPCphData() (triggered by router.refresh()) will
 * re-fetch from Google Sheets and populate the cache with fresh data.
 */
export function invalidateKKCCache(): void {
  // expire: 0 — next request blocks until revalidation completes (no stale serving).
  // This is correct for a manual Refresh action where the user expects fresh data.
  revalidateTag(KKC_CACHE_TAG, { expire: 0 })
}

/**
 * Returns true if at least one user has the Sheets scope configured.
 * Used to distinguish "no credential set up yet" from "data fetch failed".
 */
export async function hasSheetsCredential(): Promise<boolean> {
  const client = await getSheetsOAuthClient()
  return client !== null
}
