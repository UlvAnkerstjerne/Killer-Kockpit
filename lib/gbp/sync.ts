/**
 * lib/gbp/sync.ts
 *
 * GBP sync orchestration — NOT a server action. Regular async functions
 * callable from the cron endpoint (app/api/gbp/sync/route.ts) and the
 * SUPER_ADMIN trigger action (lib/actions/marketing/gbp-reviews.ts).
 *
 * All DB access uses the service client. No authentication — auth is enforced
 * at the server action / cron endpoint layer before these are called.
 *
 * Sync strategy:
 *   Reviews:  All historical reviews are imported on backfill.
 *             Activation cutoff (activation_date - 7 days) controls which
 *             unanswered reviews receive AI drafts and Needs Review items.
 *   Metrics:  Backfill = 18 months of daily data.
 *             Incremental = last 7 days (rolling, idempotent).
 *
 * Per-location isolation:
 *   Each location is synced independently. Failure of one does not abort others.
 *   Sync state is tracked per location via integration_sync_state with composite
 *   keys: 'gbp_reviews:{accountId}:{locationId}' and 'gbp_metrics:{accountId}:{locationId}'.
 *
 * Idempotency:
 *   All writes use INSERT ... ON CONFLICT ... DO UPDATE.
 *   Re-running produces the same row states without duplicates.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client } from '@/lib/google/auth'
import {
  fetchAllGbpReviews,
  fetchGbpReviewsPage,
  fetchLocationMetrics,
  normaliseStarRating,
  gbpReviewsSyncKey,
  gbpMetricsSyncKey,
  type GbpReview,
  type GbpDailyMetricTimeSeries,
} from '@/lib/google/gbp-client'
import { draftReviewReply } from '@/lib/ai/draft-review-reply'
import { KILLER_KEBAB_REVIEW_REPLY_CONTEXT } from '@/lib/marketing/gbp/brand-context'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LocationSyncResult {
  locationId:    string
  accountId:     string
  storeName:     string
  ok:            boolean
  reviewsUpserted: number
  draftsGenerated: number
  metricsUpserted: number
  error?:        string
}

export interface SyncRunResult {
  locations: LocationSyncResult[]
  totalOk:   number
  totalFail: number
}

// ── Internal DB types ──────────────────────────────────────────────────────────

interface DbLocation {
  id:                  string
  google_account_id:   string
  google_location_id:  string
  store_name:          string
  store_short_name:    string
  activation_date:     string   // date string "YYYY-MM-DD"
}

// ── Activation cutoff ──────────────────────────────────────────────────────────

const ACTIVATION_GRACE_DAYS = 7

function isWithinActivationWindow(reviewCreatedAt: string, activationDate: string): boolean {
  const reviewTs     = new Date(reviewCreatedAt).getTime()
  const activationTs = new Date(activationDate).getTime()
  const gracePeriod  = ACTIVATION_GRACE_DAYS * 24 * 60 * 60 * 1000
  return reviewTs >= activationTs - gracePeriod
}

// ── Sync state helpers ─────────────────────────────────────────────────────────

async function getSyncState(
  db: ReturnType<typeof createServiceClient>,
  integrationKey: string,
  userId: string,
): Promise<{ status: string; cursor: string | null; last_success_at: string | null }> {
  const { data } = await db
    .from('integration_sync_state')
    .select('status, cursor, last_success_at')
    .eq('integration', integrationKey)
    .eq('user_id', userId)
    .single()
  return data ?? { status: 'not_started', cursor: null, last_success_at: null }
}

async function upsertSyncState(
  db: ReturnType<typeof createServiceClient>,
  integrationKey: string,
  userId: string,
  patch: {
    status: string
    cursor?: string
    last_success_at?: string
    last_attempt_at: string
    last_error?: string | null
  },
): Promise<void> {
  await db.from('integration_sync_state').upsert(
    {
      integration: integrationKey,
      user_id:     userId,
      ...patch,
    },
    { onConflict: 'integration, user_id' },
  )
}

// ── Review upsert ──────────────────────────────────────────────────────────────

async function upsertReview(
  db: ReturnType<typeof createServiceClient>,
  review: GbpReview,
  locationDbId: string,
): Promise<{ isNew: boolean; hasExistingReply: boolean }> {
  const existingReply = review.reviewReply ?? null
  const row = {
    google_review_id:          review.name,
    location_id:               locationDbId,
    reviewer_name:             review.reviewer?.displayName ?? null,
    reviewer_photo_url:        review.reviewer?.profilePhotoUrl ?? null,
    star_rating:               normaliseStarRating(review.starRating),
    review_text:               review.comment ?? null,
    review_created_at:         review.createTime,
    review_updated_at:         review.updateTime,
    existing_reply_text:       existingReply?.comment ?? null,
    existing_reply_updated_at: existingReply?.updateTime ?? null,
    synced_at:                 new Date().toISOString(),
  }

  const { data: existing } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .single()

  const isNew = !existing

  await db.from('gbp_reviews').upsert(row, { onConflict: 'google_review_id' })

  return { isNew, hasExistingReply: !!existingReply }
}

// ── Draft generation ───────────────────────────────────────────────────────────

async function generateAndStoreDraft(
  db: ReturnType<typeof createServiceClient>,
  review: GbpReview,
  storeName: string,
): Promise<{ generated: boolean }> {
  // Find the review DB id
  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .single()

  if (!reviewRow) return { generated: false }

  const result = await draftReviewReply({
    reviewerName: review.reviewer?.displayName ?? null,
    starRating:   normaliseStarRating(review.starRating),
    reviewText:   review.comment ?? null,
    storeName,
    brandContext: KILLER_KEBAB_REVIEW_REPLY_CONTEXT,
  })

  if (result.ok) {
    await db.from('gbp_review_replies').upsert(
      {
        review_id:            reviewRow.id,
        draft_text:           result.draft,
        draft_generated_at:   new Date().toISOString(),
        draft_model:          result.model,
        draft_prompt_version: result.promptVersion,
        status:               'awaiting_review',
      },
      { onConflict: 'review_id' },
    )
    return { generated: true }
  } else {
    // Draft failed — create row at 'new' so next sync retries
    await db.from('gbp_review_replies').upsert(
      {
        review_id: reviewRow.id,
        status:    'new',
      },
      { onConflict: 'review_id' },
    )
    console.error(`[gbp/sync] Draft generation failed for review ${review.name}:`, result.error)
    return { generated: false }
  }
}

// ── Detect externally published replies ────────────────────────────────────────
//
// If a gbp_review_replies row exists in a pending state, but the review now
// has existing_reply_text, a reply was posted outside Kockpit. Mark it.

async function detectExternalReplies(
  db: ReturnType<typeof createServiceClient>,
  review: GbpReview,
): Promise<void> {
  if (!review.reviewReply) return

  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .single()

  if (!reviewRow) return

  const { data: replyRow } = await db
    .from('gbp_review_replies')
    .select('id, status')
    .eq('review_id', reviewRow.id)
    .single()

  if (!replyRow) return

  const pendingStatuses = ['new', 'awaiting_review', 'approved', 'rejected', 'publish_failed']
  if (pendingStatuses.includes(replyRow.status)) {
    await db
      .from('gbp_review_replies')
      .update({ status: 'externally_published', updated_at: new Date().toISOString() })
      .eq('id', replyRow.id)
  }
}

// ── Metrics upsert ─────────────────────────────────────────────────────────────

function dateFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

async function upsertMetrics(
  db: ReturnType<typeof createServiceClient>,
  locationDbId: string,
  series: GbpDailyMetricTimeSeries[],
): Promise<number> {
  // Build a map of date -> metric columns
  const byDate = new Map<string, Record<string, number | null>>()

  const METRIC_COLUMN_MAP: Record<string, string> = {
    BUSINESS_IMPRESSIONS_DESKTOP_MAPS:    'impressions_desktop_maps',
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH:  'impressions_desktop_search',
    BUSINESS_IMPRESSIONS_MOBILE_MAPS:     'impressions_mobile_maps',
    BUSINESS_IMPRESSIONS_MOBILE_SEARCH:   'impressions_mobile_search',
    WEBSITE_CLICKS:                       'website_clicks',
    CALL_CLICKS:                          'call_clicks',
    BUSINESS_DIRECTION_REQUESTS:          'direction_requests',
  }

  for (const s of series) {
    const col = METRIC_COLUMN_MAP[s.dailyMetric]
    if (!col) continue
    for (const dv of s.timeSeries.datedValues) {
      const dateStr = dateFromParts(dv.date.year, dv.date.month, dv.date.day)
      if (!byDate.has(dateStr)) byDate.set(dateStr, {})
      const val = dv.value != null ? parseInt(dv.value, 10) : null
      byDate.get(dateStr)![col] = isNaN(val as number) ? null : val
    }
  }

  if (byDate.size === 0) return 0

  const rows = Array.from(byDate.entries()).map(([date, metrics]) => {
    const imp =
      (metrics.impressions_desktop_maps    ?? 0) +
      (metrics.impressions_desktop_search  ?? 0) +
      (metrics.impressions_mobile_maps     ?? 0) +
      (metrics.impressions_mobile_search   ?? 0)
    return {
      location_id:                 locationDbId,
      date,
      impressions_desktop_maps:    metrics.impressions_desktop_maps    ?? null,
      impressions_desktop_search:  metrics.impressions_desktop_search  ?? null,
      impressions_mobile_maps:     metrics.impressions_mobile_maps     ?? null,
      impressions_mobile_search:   metrics.impressions_mobile_search   ?? null,
      total_impressions:           imp,
      website_clicks:              metrics.website_clicks              ?? null,
      call_clicks:                 metrics.call_clicks                 ?? null,
      direction_requests:          metrics.direction_requests          ?? null,
      synced_at:                   new Date().toISOString(),
    }
  })

  await db.from('gbp_location_metrics').upsert(rows, { onConflict: 'location_id, date' })
  return rows.length
}

// ── Rolling metrics date range ─────────────────────────────────────────────────

function rollingMetricsDateRange(): { startDate: string; endDate: string } {
  const end   = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 7)
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate:   end.toISOString().slice(0, 10),
  }
}

function backfillMetricsDateRange(): { startDate: string; endDate: string } {
  const end   = new Date()
  const start = new Date()
  start.setMonth(start.getMonth() - 18) // 18-month maximum
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate:   end.toISOString().slice(0, 10),
  }
}

// ── Single-location sync ───────────────────────────────────────────────────────

async function syncLocation(
  db: ReturnType<typeof createServiceClient>,
  location: DbLocation,
  oauthClient: Awaited<ReturnType<typeof getGoogleOAuth2Client>>,
  syncUserId: string,
): Promise<LocationSyncResult> {
  const { google_account_id: accountId, google_location_id: locationId } = location
  const reviewsKey = gbpReviewsSyncKey(accountId, locationId)
  const metricsKey = gbpMetricsSyncKey(accountId, locationId)
  const now = new Date().toISOString()

  let reviewsUpserted = 0
  let draftsGenerated = 0
  let metricsUpserted = 0

  // Mark attempt in progress
  await upsertSyncState(db, reviewsKey, syncUserId, { status: 'syncing', last_attempt_at: now })
  await upsertSyncState(db, metricsKey, syncUserId, { status: 'syncing', last_attempt_at: now })

  try {
    if (!oauthClient) throw new Error('No Google OAuth client available')

    // ── Determine if this is a first-run backfill ────────────────────────────
    const reviewsSyncState = await getSyncState(db, reviewsKey, syncUserId)
    const isFirstRun = reviewsSyncState.status === 'not_started' || reviewsSyncState.status === 'syncing'

    // ── Reviews sync ─────────────────────────────────────────────────────────
    const reviews = isFirstRun
      ? await fetchAllGbpReviews(oauthClient, accountId, locationId)
      : await (async () => {
          // Incremental: fetch first page (ordered by updateTime desc)
          // For ongoing daily syncs the first page is sufficient; new reviews
          // surface at the top. Full pagination only on first run.
          const page = await fetchGbpReviewsPage(oauthClient, accountId, locationId)
          return page.reviews
        })()

    for (const review of reviews) {
      const { isNew, hasExistingReply } = await upsertReview(db, review, location.id)
      reviewsUpserted++

      if (hasExistingReply) {
        // Detect if an externally published reply arrived for a pending Kockpit row
        await detectExternalReplies(db, review)
      } else if (isNew) {
        // New review, no existing reply — decide whether to generate a draft
        const inWindow = isWithinActivationWindow(review.createTime, location.activation_date)
        if (inWindow) {
          const { generated } = await generateAndStoreDraft(db, review, location.store_name)
          if (generated) draftsGenerated++
        }
        // Historical unanswered outside activation window: imported only, no reply row
      }
      // Existing review updated (not new): just the upsert above; no draft action
    }

    await upsertSyncState(db, reviewsKey, syncUserId, {
      status:         'synced',
      last_success_at: now,
      last_attempt_at: now,
      cursor:          now,
      last_error:      null,
    })

    // ── Metrics sync ─────────────────────────────────────────────────────────
    const metricsSyncState = await getSyncState(db, metricsKey, syncUserId)
    const isMetricsFirstRun = metricsSyncState.status === 'not_started' || metricsSyncState.status === 'syncing'

    const { startDate, endDate } = isMetricsFirstRun
      ? backfillMetricsDateRange()
      : rollingMetricsDateRange()

    const series = await fetchLocationMetrics(oauthClient, accountId, locationId, startDate, endDate)
    metricsUpserted = await upsertMetrics(db, location.id, series)

    await upsertSyncState(db, metricsKey, syncUserId, {
      status:          'synced',
      last_success_at: now,
      last_attempt_at: now,
      last_error:      null,
    })

    return {
      locationId, accountId, storeName: location.store_name,
      ok: true, reviewsUpserted, draftsGenerated, metricsUpserted,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[gbp/sync] Location ${locationId} failed:`, error)

    await upsertSyncState(db, reviewsKey, syncUserId, {
      status: 'failed', last_attempt_at: now, last_error: error,
    })
    await upsertSyncState(db, metricsKey, syncUserId, {
      status: 'failed', last_attempt_at: now, last_error: error,
    })

    return {
      locationId, accountId, storeName: location.store_name,
      ok: false, reviewsUpserted, draftsGenerated, metricsUpserted, error,
    }
  }
}

// ── Main export: runGbpSync ────────────────────────────────────────────────────

/**
 * Runs the full GBP sync across all active locations.
 *
 * Uses the credential of the sync user (stored in integration_sync_state or
 * derived from the first SUPER_ADMIN with a GBP-scoped token).
 *
 * Returns a SyncRunResult summarising per-location outcomes.
 * Does not throw — all errors are captured in LocationSyncResult.error.
 */
export async function runGbpSync(syncUserId: string): Promise<SyncRunResult> {
  const db = createServiceClient()

  const { data: locations } = await db
    .from('gbp_locations')
    .select('id, google_account_id, google_location_id, store_name, store_short_name, activation_date')
    .eq('active', true)

  if (!locations || locations.length === 0) {
    return { locations: [], totalOk: 0, totalFail: 0 }
  }

  const oauthClient = await getGoogleOAuth2Client(syncUserId)

  const results: LocationSyncResult[] = []
  for (const location of locations as DbLocation[]) {
    const result = await syncLocation(db, location, oauthClient, syncUserId)
    results.push(result)
  }

  return {
    locations:  results,
    totalOk:    results.filter((r) => r.ok).length,
    totalFail:  results.filter((r) => !r.ok).length,
  }
}

/**
 * Retries draft generation for a single review in status 'new'.
 * Called from the catch-up server action.
 */
export async function retryDraftForReview(reviewDbId: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient()

  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id, google_review_id, reviewer_name, star_rating, review_text, location_id')
    .eq('id', reviewDbId)
    .single()

  if (!reviewRow) return { ok: false, error: 'Review not found.' }

  const { data: locationRow } = await db
    .from('gbp_locations')
    .select('store_name')
    .eq('id', reviewRow.location_id)
    .single()

  if (!locationRow) return { ok: false, error: 'Location not found.' }

  const result = await draftReviewReply({
    reviewerName: reviewRow.reviewer_name ?? null,
    starRating:   reviewRow.star_rating,
    reviewText:   reviewRow.review_text ?? null,
    storeName:    locationRow.store_name,
    brandContext: KILLER_KEBAB_REVIEW_REPLY_CONTEXT,
  })

  if (!result.ok) return { ok: false, error: result.error }

  await db.from('gbp_review_replies').upsert(
    {
      review_id:            reviewDbId,
      draft_text:           result.draft,
      draft_generated_at:   new Date().toISOString(),
      draft_model:          result.model,
      draft_prompt_version: result.promptVersion,
      status:               'awaiting_review',
    },
    { onConflict: 'review_id' },
  )

  return { ok: true }
}
