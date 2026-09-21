/**
 * lib/gsc/sync.ts
 *
 * Search Console sync orchestration.  NOT a server action.
 * Called from the cron endpoint and from the SUPER_ADMIN trigger route.
 * All DB access uses createServiceClient().
 *
 * Institutional model
 * -------------------
 * Data is company-wide — no user_id on stored rows.
 * Credential owner resolved dynamically from google_oauth_tokens (first user
 * with webmasters.readonly scope).  Not stored in sync state.
 * integration_sync_state rows all use user_id IS NULL (matches Meta pattern).
 *
 * Sync state keys (user_id IS NULL):
 *   gsc_daily:https://killerkebab.com/    — cursor = last endDate synced
 *   gsc_queries:https://killerkebab.com/  — cursor = last endDate synced
 *   gsc_pages:https://killerkebab.com/    — cursor = last endDate synced
 *
 * Date strategy
 * -------------
 * Backfill (first run):   start = 93 days ago, end = 3 days ago (90-day window)
 * Incremental (later):    start = 17 days ago, end = 3 days ago (14-day rolling)
 * The 3-day lag respects GSC's 2–3 day data processing delay.
 *
 * API queries
 * -----------
 * gsc_daily:   dimensions=['date'],        rowLimit=1000 — at most 90 rows per run
 * gsc_queries: dimensions=['date','query'], rowLimit=25000 — all (date,query) pairs
 * gsc_pages:   dimensions=['date','page'],  rowLimit=25000 — all (date,page) pairs
 *
 * Large result sets are upserted in 500-row batches to stay within Supabase limits.
 *
 * Idempotency: all writes use INSERT … ON CONFLICT … DO UPDATE.
 *
 * Institutional sync state helpers
 * ---------------------------------
 * Standard .upsert(onConflict:'integration,user_id') does not work when
 * user_id IS NULL (PostgreSQL treats NULL != NULL in UNIQUE constraints).
 * These helpers use the same manual select→update/insert pattern as meta/sync.ts.
 * The partial unique index from migration 019 prevents concurrent duplicates.
 */

import { google } from 'googleapis'
import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, hasSearchConsoleScope } from '@/lib/google/auth'

// ── Config ─────────────────────────────────────────────────────────────────────

const SC_SITE_URL   = 'https://killerkebab.com/'
const BACKFILL_DAYS = 90   // days of history to fetch on first run
const ROLLING_DAYS  = 14   // days to re-fetch on incremental runs
const GSC_LAG_DAYS  = 3    // GSC data lags 2–3 days; always end this many days ago
const ROW_LIMIT     = 25000 // max rows per GSC request
const UPSERT_CHUNK  = 500   // batch size for Supabase upserts

const DAILY_KEY   = `gsc_daily:${SC_SITE_URL}`
const QUERIES_KEY = `gsc_queries:${SC_SITE_URL}`
const PAGES_KEY   = `gsc_pages:${SC_SITE_URL}`

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GscSyncResult {
  ok:         boolean
  siteUrl:    string
  isBackfill: boolean
  dateRange:  { start: string; end: string }
  dailyRows:  number
  queryRows:  number
  pageRows:   number
  errors:     string[]
}

type Db = ReturnType<typeof createServiceClient>
type WmClient = ReturnType<typeof google.webmasters>

// ── Date helpers ───────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  return toDateStr(new Date(Date.now() - n * 86_400_000))
}

function backfillRange() {
  return {
    startDate: daysAgo(BACKFILL_DAYS + GSC_LAG_DAYS),
    endDate:   daysAgo(GSC_LAG_DAYS),
  }
}

function rollingRange() {
  return {
    startDate: daysAgo(ROLLING_DAYS + GSC_LAG_DAYS),
    endDate:   daysAgo(GSC_LAG_DAYS),
  }
}

// ── Institutional sync state ───────────────────────────────────────────────────

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
  const match = data.find((r) => hasSearchConsoleScope((r.scopes as string[]) ?? []))
  return (match?.user_id as string | undefined) ?? null
}

// ── Individual sync functions ──────────────────────────────────────────────────

async function syncDaily(
  db: Db,
  wm: WmClient,
  siteUrl: string,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const { data } = await wm.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate:  range.startDate,
      endDate:    range.endDate,
      dimensions: ['date'],
      rowLimit:   1000,   // 90-day window = max 90 rows
    },
  })

  const rows = (data.rows ?? [])
    .map((r) => ({
      site_url:    siteUrl,
      date:        (r.keys ?? [])[0] ?? '',
      clicks:      r.clicks      != null ? Math.round(r.clicks)      : null,
      impressions: r.impressions != null ? Math.round(r.impressions) : null,
      ctr:         r.ctr      ?? null,
      position:    r.position ?? null,
      synced_at:   new Date().toISOString(),
    }))
    .filter((r) => r.date)

  if (rows.length === 0) return 0

  const { error } = await db
    .from('gsc_daily')
    .upsert(rows, { onConflict: 'site_url, date' })
  if (error) throw new Error(error.message)

  return rows.length
}

async function syncQueries(
  db: Db,
  wm: WmClient,
  siteUrl: string,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const { data } = await wm.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate:  range.startDate,
      endDate:    range.endDate,
      dimensions: ['date', 'query'],
      rowLimit:   ROW_LIMIT,
    },
  })

  const rows = (data.rows ?? [])
    .map((r) => ({
      site_url:    siteUrl,
      date:        (r.keys ?? [])[0] ?? '',
      query:       (r.keys ?? [])[1] ?? '',
      clicks:      r.clicks      != null ? Math.round(r.clicks)      : null,
      impressions: r.impressions != null ? Math.round(r.impressions) : null,
      ctr:         r.ctr      ?? null,
      position:    r.position ?? null,
      synced_at:   new Date().toISOString(),
    }))
    .filter((r) => r.date && r.query)

  if (rows.length === 0) return 0

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from('gsc_queries')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'site_url, date, query' })
    if (error) throw new Error(error.message)
  }

  return rows.length
}

async function syncPages(
  db: Db,
  wm: WmClient,
  siteUrl: string,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const { data } = await wm.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate:  range.startDate,
      endDate:    range.endDate,
      dimensions: ['date', 'page'],
      rowLimit:   ROW_LIMIT,
    },
  })

  const rows = (data.rows ?? [])
    .map((r) => ({
      site_url:    siteUrl,
      date:        (r.keys ?? [])[0] ?? '',
      page:        (r.keys ?? [])[1] ?? '',
      clicks:      r.clicks      != null ? Math.round(r.clicks)      : null,
      impressions: r.impressions != null ? Math.round(r.impressions) : null,
      ctr:         r.ctr      ?? null,
      position:    r.position ?? null,
      synced_at:   new Date().toISOString(),
    }))
    .filter((r) => r.date && r.page)

  if (rows.length === 0) return 0

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from('gsc_pages')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'site_url, date, page' })
    if (error) throw new Error(error.message)
  }

  return rows.length
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Runs the full Search Console sync for the configured site.
 *
 * First run (no prior sync state): fetches a 90-day backfill.
 * Subsequent runs: refreshes the last 14 days to pick up finalised data.
 *
 * Does not throw — all errors are captured in GscSyncResult.errors.
 * Returns row counts and the date range processed.
 */
export async function runGscSync(): Promise<GscSyncResult> {
  const db     = createServiceClient()
  const errors: string[] = []
  const now    = new Date().toISOString()
  const siteUrl = SC_SITE_URL

  // ── Resolve credential ───────────────────────────────────────────────────────
  const credentialUserId = await findCredentialUserId(db)
  if (!credentialUserId) {
    return {
      ok: false, siteUrl, isBackfill: false,
      dateRange: { start: '', end: '' },
      dailyRows: 0, queryRows: 0, pageRows: 0,
      errors: ['No user with webmasters.readonly scope found. Connect Search Console OAuth first.'],
    }
  }

  const oauthClient = await getGoogleOAuth2Client(credentialUserId)
  if (!oauthClient) {
    return {
      ok: false, siteUrl, isBackfill: false,
      dateRange: { start: '', end: '' },
      dailyRows: 0, queryRows: 0, pageRows: 0,
      errors: ['Failed to retrieve OAuth client for the credential user.'],
    }
  }

  const wm = google.webmasters({ version: 'v3', auth: oauthClient })

  // ── Determine backfill vs rolling ────────────────────────────────────────────
  const dailySyncState = await getInstitutionalSyncState(db, DAILY_KEY)
  const isBackfill = !dailySyncState || dailySyncState.status === 'not_started'
  const range = isBackfill ? backfillRange() : rollingRange()

  console.log(
    `[gsc/sync] ${isBackfill ? 'Backfill' : 'Incremental'} sync — ` +
    `${range.startDate} → ${range.endDate} — credential user: ${credentialUserId}`,
  )

  // Mark all three integration keys as syncing
  await Promise.all([
    upsertInstitutionalSyncState(db, DAILY_KEY,   { status: 'syncing', last_attempt_at: now }),
    upsertInstitutionalSyncState(db, QUERIES_KEY, { status: 'syncing', last_attempt_at: now }),
    upsertInstitutionalSyncState(db, PAGES_KEY,   { status: 'syncing', last_attempt_at: now }),
  ])

  let dailyRows = 0
  let queryRows = 0
  let pageRows  = 0

  // ── Daily totals ─────────────────────────────────────────────────────────────
  try {
    dailyRows = await syncDaily(db, wm, siteUrl, range)
    if (dailyRows === 0) {
      // Zero rows from the API is not a successful sync — the cursor must not
      // advance and last_success_at must not be updated.  The most common cause
      // is a property-type mismatch: SC_SITE_URL is the URL-prefix property
      // 'https://killerkebab.com/' but the primary GSC property may be the
      // domain property 'sc-domain:killerkebab.com'.  Verify in Search Console.
      const msg = `Zero rows returned for ${range.startDate}–${range.endDate}. Verify SC_SITE_URL matches the verified Search Console property (currently '${siteUrl}').`
      console.warn('[gsc/sync] gsc_daily:', msg)
      errors.push(`gsc_daily: ${msg}`)
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
      console.log(`[gsc/sync] gsc_daily: ${dailyRows} rows upserted`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[gsc/sync] gsc_daily failed:', msg)
    errors.push(`gsc_daily: ${msg}`)
    await upsertInstitutionalSyncState(db, DAILY_KEY, {
      status: 'failed', last_attempt_at: now, last_error: msg,
    })
  }

  // ── Top queries ──────────────────────────────────────────────────────────────
  try {
    queryRows = await syncQueries(db, wm, siteUrl, range)
    if (queryRows === 0) {
      const msg = `Zero rows returned for ${range.startDate}–${range.endDate}. Verify SC_SITE_URL matches the verified Search Console property (currently '${siteUrl}').`
      console.warn('[gsc/sync] gsc_queries:', msg)
      errors.push(`gsc_queries: ${msg}`)
      await upsertInstitutionalSyncState(db, QUERIES_KEY, {
        status: 'failed', last_attempt_at: now, last_error: msg,
      })
    } else {
      await upsertInstitutionalSyncState(db, QUERIES_KEY, {
        status:          'synced',
        cursor:          range.endDate,
        last_success_at: now,
        last_attempt_at: now,
        last_error:      null,
      })
      console.log(`[gsc/sync] gsc_queries: ${queryRows} rows upserted`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[gsc/sync] gsc_queries failed:', msg)
    errors.push(`gsc_queries: ${msg}`)
    await upsertInstitutionalSyncState(db, QUERIES_KEY, {
      status: 'failed', last_attempt_at: now, last_error: msg,
    })
  }

  // ── Top pages ────────────────────────────────────────────────────────────────
  try {
    pageRows = await syncPages(db, wm, siteUrl, range)
    if (pageRows === 0) {
      const msg = `Zero rows returned for ${range.startDate}–${range.endDate}. Verify SC_SITE_URL matches the verified Search Console property (currently '${siteUrl}').`
      console.warn('[gsc/sync] gsc_pages:', msg)
      errors.push(`gsc_pages: ${msg}`)
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
      console.log(`[gsc/sync] gsc_pages: ${pageRows} rows upserted`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[gsc/sync] gsc_pages failed:', msg)
    errors.push(`gsc_pages: ${msg}`)
    await upsertInstitutionalSyncState(db, PAGES_KEY, {
      status: 'failed', last_attempt_at: now, last_error: msg,
    })
  }

  return {
    ok:        errors.length === 0,
    siteUrl,
    isBackfill,
    dateRange: { start: range.startDate, end: range.endDate },
    dailyRows,
    queryRows,
    pageRows,
    errors,
  }
}
