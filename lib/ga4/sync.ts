/**
 * lib/ga4/sync.ts
 *
 * GA4 sync orchestration.  NOT a server action.
 * Called from the cron endpoint and the SUPER_ADMIN trigger route.
 * All DB access uses createServiceClient().
 *
 * Institutional model
 * -------------------
 * Data is company-wide — no user_id on stored rows.
 * Credential owner resolved dynamically from google_oauth_tokens (first user
 * with analytics.readonly scope).  Not stored in sync state.
 * integration_sync_state rows all use user_id IS NULL (matches Meta/GSC pattern).
 *
 * Sync state keys (user_id IS NULL):
 *   ga4_daily:{property_id}           — cursor = last endDate synced
 *   ga4_traffic_sources:{property_id} — cursor = last endDate synced
 *   ga4_landing_pages:{property_id}   — cursor = last endDate synced
 *
 * Date strategy
 * -------------
 * Backfill (first run):   start = 91 days ago, end = 1 day ago (90-day window)
 * Incremental (later):    start = 15 days ago, end = 1 day ago (14-day rolling)
 * GA4 data is typically finalised by the following day; 1-day lag is sufficient.
 *
 * API queries (GA4 Data API v1beta — properties.runReport)
 * --------------------------------------------------------
 * ga4_daily:           dimensions=['date'], metrics=sessions/totalUsers/newUsers/screenPageViews
 * ga4_traffic_sources: dimensions=['date','sessionSource','sessionMedium'], metrics=sessions/totalUsers/newUsers
 * ga4_landing_pages:   dimensions=['date','landingPage'], metrics=sessions/totalUsers/newUsers
 *
 * GA4 date format: API accepts YYYY-MM-DD; response returns dates as YYYYMMDD.
 * All dates are converted to YYYY-MM-DD before storage.
 *
 * Idempotency: all writes use INSERT … ON CONFLICT … DO UPDATE.
 */

import { google } from 'googleapis'
import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, hasGA4Scope } from '@/lib/google/auth'

// ── Config ─────────────────────────────────────────────────────────────────────

const GA4_PROPERTY_ID = '333149501'
const BACKFILL_DAYS   = 90   // days of history to fetch on first run
const ROLLING_DAYS    = 14   // days to re-fetch on incremental runs
const GA4_LAG_DAYS    = 1    // GA4 data finalises ~1 day after collection
const UPSERT_CHUNK    = 500  // batch size for Supabase upserts

const DAILY_KEY   = `ga4_daily:${GA4_PROPERTY_ID}`
const SOURCES_KEY = `ga4_traffic_sources:${GA4_PROPERTY_ID}`
const PAGES_KEY   = `ga4_landing_pages:${GA4_PROPERTY_ID}`

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GA4SyncResult {
  ok:           boolean
  propertyId:   string
  isBackfill:   boolean
  dateRange:    { start: string; end: string }
  dailyRows:    number
  sourceRows:   number
  pageRows:     number
  errors:       string[]
}

type Db         = ReturnType<typeof createServiceClient>
type AdClient   = ReturnType<typeof google.analyticsdata>

// ── Date helpers ───────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  return toDateStr(new Date(Date.now() - n * 86_400_000))
}

/** GA4 returns dates as 'YYYYMMDD' — convert to 'YYYY-MM-DD' for storage. */
function ga4DateToIso(ga4Date: string): string {
  if (ga4Date.length === 8) {
    return `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}`
  }
  return ga4Date  // already ISO or unexpected format — pass through
}

function backfillRange() {
  return {
    startDate: daysAgo(BACKFILL_DAYS + GA4_LAG_DAYS),
    endDate:   daysAgo(GA4_LAG_DAYS),
  }
}

function rollingRange() {
  return {
    startDate: daysAgo(ROLLING_DAYS + GA4_LAG_DAYS),
    endDate:   daysAgo(GA4_LAG_DAYS),
  }
}

// ── Institutional sync state ───────────────────────────────────────────────────
//
// Standard .upsert(onConflict:'integration,user_id') does not work when
// user_id IS NULL (PostgreSQL treats NULL != NULL).  Same pattern as meta/sync.ts
// and gsc/sync.ts: manual select → update/insert.

async function getInstitutionalSyncState(db: Db, integration: string) {
  const { data } = await db
    .from('integration_sync_state')
    .select('id, status, cursor, last_success_at')
    .eq('integration', integration)
    .is('user_id', null)
    .maybeSingle()
  return data ?? null
}

async function upsertInstitutionalSyncState(
  db: Db,
  integration: string,
  patch: {
    status:           string
    cursor?:          string
    last_success_at?: string
    last_attempt_at:  string
    last_error?:      string | null
  },
): Promise<void> {
  const existing = await getInstitutionalSyncState(db, integration)
  if (existing) {
    await db.from('integration_sync_state').update(patch).eq('id', existing.id)
  } else {
    await db.from('integration_sync_state').insert({ integration, user_id: null, ...patch })
  }
}

// ── Credential resolution ──────────────────────────────────────────────────────

async function findCredentialUserId(db: Db): Promise<string | null> {
  const { data } = await db.from('google_oauth_tokens').select('user_id, scopes')
  if (!data) return null
  const match = data.find((r) => hasGA4Scope((r.scopes as string[]) ?? []))
  return (match?.user_id as string | undefined) ?? null
}

// ── Metric index helper ────────────────────────────────────────────────────────

/** Returns the index of a named metric in a metricHeaders array, or -1 if absent. */
function metricIndex(
  headers: Array<{ name?: string | null }>,
  name: string,
): number {
  return headers.findIndex((h) => h.name === name)
}

function metricValue(
  row: { metricValues?: Array<{ value?: string | null }> | null },
  idx: number,
): number | null {
  if (idx < 0) return null
  const raw = row.metricValues?.[idx]?.value
  if (raw == null) return null
  const n = Number(raw)
  return isNaN(n) ? null : Math.round(n)
}

// ── Individual sync functions ──────────────────────────────────────────────────

async function syncDaily(
  db: Db,
  ad: AdClient,
  propertyId: string,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const { data } = await ad.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'sessions'        },
        { name: 'totalUsers'      },
        { name: 'newUsers'        },
        { name: 'screenPageViews' },
      ],
    },
  })

  const headers = data.metricHeaders ?? []
  const iSessions  = metricIndex(headers, 'sessions')
  const iUsers     = metricIndex(headers, 'totalUsers')
  const iNewUsers  = metricIndex(headers, 'newUsers')
  const iPageViews = metricIndex(headers, 'screenPageViews')

  const rows = (data.rows ?? [])
    .map((r) => ({
      property_id: propertyId,
      date:        ga4DateToIso(r.dimensionValues?.[0]?.value ?? ''),
      sessions:    metricValue(r, iSessions),
      total_users: metricValue(r, iUsers),
      new_users:   metricValue(r, iNewUsers),
      page_views:  metricValue(r, iPageViews),
      synced_at:   new Date().toISOString(),
    }))
    .filter((r) => r.date)

  if (rows.length === 0) return 0

  const { error } = await db
    .from('ga4_daily')
    .upsert(rows, { onConflict: 'property_id, date' })
  if (error) throw new Error(error.message)

  return rows.length
}

async function syncTrafficSources(
  db: Db,
  ad: AdClient,
  propertyId: string,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const { data } = await ad.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: 'date'          },
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
      ],
      metrics: [
        { name: 'sessions'   },
        { name: 'totalUsers' },
        { name: 'newUsers'   },
      ],
    },
  })

  const headers    = data.metricHeaders ?? []
  const iSessions  = metricIndex(headers, 'sessions')
  const iUsers     = metricIndex(headers, 'totalUsers')
  const iNewUsers  = metricIndex(headers, 'newUsers')

  const rows = (data.rows ?? [])
    .map((r) => {
      const dims = r.dimensionValues ?? []
      return {
        property_id:    propertyId,
        date:           ga4DateToIso(dims[0]?.value ?? ''),
        session_source: dims[1]?.value ?? '',
        session_medium: dims[2]?.value ?? '',
        sessions:       metricValue(r, iSessions),
        total_users:    metricValue(r, iUsers),
        new_users:      metricValue(r, iNewUsers),
        synced_at:      new Date().toISOString(),
      }
    })
    .filter((r) => r.date && r.session_source)

  if (rows.length === 0) return 0

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from('ga4_traffic_sources')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), {
        onConflict: 'property_id, date, session_source, session_medium',
      })
    if (error) throw new Error(error.message)
  }

  return rows.length
}

async function syncLandingPages(
  db: Db,
  ad: AdClient,
  propertyId: string,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const { data } = await ad.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: 'date'        },
        { name: 'landingPage' },
      ],
      metrics: [
        { name: 'sessions'   },
        { name: 'totalUsers' },
        { name: 'newUsers'   },
      ],
    },
  })

  const headers   = data.metricHeaders ?? []
  const iSessions = metricIndex(headers, 'sessions')
  const iUsers    = metricIndex(headers, 'totalUsers')
  const iNewUsers = metricIndex(headers, 'newUsers')

  const rows = (data.rows ?? [])
    .map((r) => {
      const dims = r.dimensionValues ?? []
      return {
        property_id:  propertyId,
        date:         ga4DateToIso(dims[0]?.value ?? ''),
        landing_page: dims[1]?.value ?? '',
        sessions:     metricValue(r, iSessions),
        total_users:  metricValue(r, iUsers),
        new_users:    metricValue(r, iNewUsers),
        synced_at:    new Date().toISOString(),
      }
    })
    .filter((r) => r.date && r.landing_page)

  if (rows.length === 0) return 0

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from('ga4_landing_pages')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), {
        onConflict: 'property_id, date, landing_page',
      })
    if (error) throw new Error(error.message)
  }

  return rows.length
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Runs the full GA4 sync for the configured property.
 *
 * First run: fetches a 90-day backfill.
 * Subsequent runs: refreshes the last 14 days to capture finalised data.
 *
 * Does not throw — all errors are captured in GA4SyncResult.errors.
 */
export async function runGA4Sync(): Promise<GA4SyncResult> {
  const db         = createServiceClient()
  const errors:    string[] = []
  const now        = new Date().toISOString()
  const propertyId = GA4_PROPERTY_ID

  // ── Resolve credential ───────────────────────────────────────────────────────
  const credentialUserId = await findCredentialUserId(db)
  if (!credentialUserId) {
    return {
      ok: false, propertyId, isBackfill: false,
      dateRange: { start: '', end: '' },
      dailyRows: 0, sourceRows: 0, pageRows: 0,
      errors: ['No user with analytics.readonly scope found. Connect GA4 OAuth first.'],
    }
  }

  const oauthClient = await getGoogleOAuth2Client(credentialUserId)
  if (!oauthClient) {
    return {
      ok: false, propertyId, isBackfill: false,
      dateRange: { start: '', end: '' },
      dailyRows: 0, sourceRows: 0, pageRows: 0,
      errors: ['Failed to retrieve OAuth client for the credential user.'],
    }
  }

  const ad = google.analyticsdata({ version: 'v1beta', auth: oauthClient })

  // ── Determine backfill vs rolling ────────────────────────────────────────────
  const dailySyncState = await getInstitutionalSyncState(db, DAILY_KEY)
  const isBackfill     = !dailySyncState || dailySyncState.status === 'not_started'
  const range          = isBackfill ? backfillRange() : rollingRange()

  console.log(
    `[ga4/sync] ${isBackfill ? 'Backfill' : 'Incremental'} sync — ` +
    `${range.startDate} → ${range.endDate} — credential user: ${credentialUserId}`,
  )

  // Mark all three as syncing
  await Promise.all([
    upsertInstitutionalSyncState(db, DAILY_KEY,   { status: 'syncing', last_attempt_at: now }),
    upsertInstitutionalSyncState(db, SOURCES_KEY, { status: 'syncing', last_attempt_at: now }),
    upsertInstitutionalSyncState(db, PAGES_KEY,   { status: 'syncing', last_attempt_at: now }),
  ])

  let dailyRows  = 0
  let sourceRows = 0
  let pageRows   = 0

  // ── Daily totals ─────────────────────────────────────────────────────────────
  try {
    dailyRows = await syncDaily(db, ad, propertyId, range)
    if (dailyRows === 0) {
      const msg = `Zero rows returned for ${range.startDate}–${range.endDate}. Verify GA4_PROPERTY_ID and that the property has data in this window (currently '${propertyId}').`
      console.warn('[ga4/sync] ga4_daily:', msg)
      errors.push(`ga4_daily: ${msg}`)
      await upsertInstitutionalSyncState(db, DAILY_KEY, {
        status: 'failed', last_attempt_at: now, last_error: msg,
      })
    } else {
      await upsertInstitutionalSyncState(db, DAILY_KEY, {
        status:          'synced',
        cursor:          range.endDate,
        last_success_at: now,
        last_attempt_at: now,
        last_error:      null,
      })
      console.log(`[ga4/sync] ga4_daily: ${dailyRows} rows upserted`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ga4/sync] ga4_daily failed:', msg)
    errors.push(`ga4_daily: ${msg}`)
    await upsertInstitutionalSyncState(db, DAILY_KEY, {
      status: 'failed', last_attempt_at: now, last_error: msg,
    })
  }

  // ── Traffic sources ──────────────────────────────────────────────────────────
  try {
    sourceRows = await syncTrafficSources(db, ad, propertyId, range)
    if (sourceRows === 0) {
      const msg = `Zero rows returned for ${range.startDate}–${range.endDate}. Verify GA4_PROPERTY_ID and that the property has data in this window (currently '${propertyId}').`
      console.warn('[ga4/sync] ga4_traffic_sources:', msg)
      errors.push(`ga4_traffic_sources: ${msg}`)
      await upsertInstitutionalSyncState(db, SOURCES_KEY, {
        status: 'failed', last_attempt_at: now, last_error: msg,
      })
    } else {
      await upsertInstitutionalSyncState(db, SOURCES_KEY, {
        status:          'synced',
        cursor:          range.endDate,
        last_success_at: now,
        last_attempt_at: now,
        last_error:      null,
      })
      console.log(`[ga4/sync] ga4_traffic_sources: ${sourceRows} rows upserted`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ga4/sync] ga4_traffic_sources failed:', msg)
    errors.push(`ga4_traffic_sources: ${msg}`)
    await upsertInstitutionalSyncState(db, SOURCES_KEY, {
      status: 'failed', last_attempt_at: now, last_error: msg,
    })
  }

  // ── Landing pages ────────────────────────────────────────────────────────────
  try {
    pageRows = await syncLandingPages(db, ad, propertyId, range)
    if (pageRows === 0) {
      const msg = `Zero rows returned for ${range.startDate}–${range.endDate}. Verify GA4_PROPERTY_ID and that the property has data in this window (currently '${propertyId}').`
      console.warn('[ga4/sync] ga4_landing_pages:', msg)
      errors.push(`ga4_landing_pages: ${msg}`)
      await upsertInstitutionalSyncState(db, PAGES_KEY, {
        status: 'failed', last_attempt_at: now, last_error: msg,
      })
    } else {
      await upsertInstitutionalSyncState(db, PAGES_KEY, {
        status:          'synced',
        cursor:          range.endDate,
        last_success_at: now,
        last_attempt_at: now,
        last_error:      null,
      })
      console.log(`[ga4/sync] ga4_landing_pages: ${pageRows} rows upserted`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ga4/sync] ga4_landing_pages failed:', msg)
    errors.push(`ga4_landing_pages: ${msg}`)
    await upsertInstitutionalSyncState(db, PAGES_KEY, {
      status: 'failed', last_attempt_at: now, last_error: msg,
    })
  }

  return {
    ok:        errors.length === 0,
    propertyId,
    isBackfill,
    dateRange: { start: range.startDate, end: range.endDate },
    dailyRows,
    sourceRows,
    pageRows,
    errors,
  }
}
