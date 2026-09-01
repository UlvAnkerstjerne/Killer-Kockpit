/**
 * lib/google/gbp-client.ts
 *
 * Typed REST client for Google Business Profile APIs.
 *
 * GBP uses multiple API versions with different resource name conventions.
 * Path construction is centralised here — callers only supply bare numeric IDs.
 *
 * API version map:
 *   Account Management v1 — list accounts accessible to the credential holder
 *   Business Information v1 — list locations under an account
 *   Google My Business v4 — list reviews, post review replies
 *   Business Profile Performance v1 — daily metrics per location
 *
 * Resource name conventions stored in DB:
 *   gbp_locations.google_account_id  — bare numeric (e.g. "123456789")
 *   gbp_locations.google_location_id — bare numeric (e.g. "987654321")
 *   gbp_reviews.google_review_id     — full v4 resource name
 *     (e.g. "accounts/123456789/locations/987654321/reviews/AbCd...")
 *     Stored exactly as returned by the API; used directly as path prefix for
 *     the reply PUT endpoint without any reconstruction.
 *
 * Security:
 *   All functions accept an Auth.OAuth2Client, obtained from getGoogleOAuth2Client().
 *   Tokens are never logged, never returned to callers, never exposed to the browser.
 *   All calls are server-side only.
 *
 * NOTE: Live API calls will fail until Google approves the Cloud project's
 * Business Profile API access. The client abstraction is correct and will
 * function once approval is granted and the GBP scope is connected.
 */

import type { Auth } from 'googleapis'

// ── Base URLs ──────────────────────────────────────────────────────────────────

const ACCOUNT_MGMT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'
const BIZ_INFO_BASE     = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const REVIEWS_V4_BASE   = 'https://mybusiness.googleapis.com/v4'
const PERF_BASE         = 'https://businessprofileperformance.googleapis.com/v1'

// ── Path builders ──────────────────────────────────────────────────────────────
// Explicit functions — never string-concatenate ambiguous IDs at call sites.

export function accountPath(accountId: string): string {
  return `accounts/${accountId}`
}

export function locationInfoPath(locationId: string): string {
  return `locations/${locationId}`
}

/** Parent path used by the v4 Reviews API. */
export function reviewsParentPath(accountId: string, locationId: string): string {
  return `accounts/${accountId}/locations/${locationId}`
}

/** Integration sync state key for review sync. */
export function gbpReviewsSyncKey(accountId: string, locationId: string): string {
  return `gbp_reviews:${accountId}:${locationId}`
}

/** Integration sync state key for metrics sync. */
export function gbpMetricsSyncKey(accountId: string, locationId: string): string {
  return `gbp_metrics:${accountId}:${locationId}`
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GbpAccount {
  name: string         // "accounts/{accountId}"
  accountName: string
  type: string         // "LOCATION_GROUP" | "PERSONAL" | etc.
}

export interface GbpLocation {
  name: string         // "locations/{locationId}" (Business Info API format)
  title: string
  storefrontAddress?: {
    locality?: string
    administrativeArea?: string
  }
}

export type GbpStarRating = 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE'

export interface GbpReview {
  name: string         // full compound v4 resource name — use as google_review_id
  reviewer: {
    displayName?: string
    profilePhotoUrl?: string
    isAnonymous?: boolean
  }
  starRating: GbpStarRating
  comment?: string     // absent for rating-only reviews
  createTime: string   // ISO timestamp
  updateTime: string   // ISO timestamp
  reviewReply?: {
    comment: string
    updateTime: string
  }
}

export interface GbpReviewsPage {
  reviews: GbpReview[]
  averageRating?: number
  totalReviewCount?: number
  nextPageToken?: string
}

export interface GbpMetricValue {
  metricOption: string
  dimensionalValues?: Array<{
    metricOption: string
    timeDimension: { dayOfWeek?: string; timeOfDay?: Record<string, number> }
    value?: string
  }>
  totalValue?: { metricOption: string; value: string }
}

export interface GbpDailyMetricTimeSeries {
  dailyMetric: string
  dailySubEntityType?: Record<string, unknown>
  timeSeries: {
    datedValues: Array<{
      date: { year: number; month: number; day: number }
      value?: string
    }>
  }
}

export interface GbpMetricsResponse {
  multiDailyMetricTimeSeries: GbpDailyMetricTimeSeries[]
}

// ── Star rating normalisation ──────────────────────────────────────────────────

const STAR_RATING_MAP: Record<GbpStarRating, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
}

export function normaliseStarRating(rating: GbpStarRating): number {
  return STAR_RATING_MAP[rating] ?? 0
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function gbpFetch<T>(
  oauthClient: Auth.OAuth2Client,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const { token } = await oauthClient.getAccessToken()
  if (!token) throw new Error('[gbp-client] No access token available.')

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })

  if (!response.ok) {
    let errorDetail = ''
    try {
      const body = await response.json() as { error?: { message?: string; code?: number } }
      errorDetail = body?.error?.message ?? ''
    } catch {
      // body not JSON
    }
    throw new GbpApiError(response.status, errorDetail || response.statusText, url)
  }

  return response.json() as Promise<T>
}

export class GbpApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly url: string,
  ) {
    super(`GBP API error ${status}: ${message} (${url})`)
    this.name = 'GbpApiError'
  }
}

// ── API functions ──────────────────────────────────────────────────────────────

/**
 * Lists all GBP accounts accessible to the credential holder.
 * Returns the accounts array (may be empty if the account has no GBP access).
 */
export async function fetchGbpAccounts(
  oauthClient: Auth.OAuth2Client,
): Promise<GbpAccount[]> {
  const data = await gbpFetch<{ accounts?: GbpAccount[] }>(
    oauthClient,
    `${ACCOUNT_MGMT_BASE}/accounts`,
  )
  return data.accounts ?? []
}

/**
 * Lists all locations under a GBP account.
 * Uses the Business Information API (v1) — location resource names are
 * "locations/{locationId}" without the account prefix.
 */
export async function fetchGbpLocations(
  oauthClient: Auth.OAuth2Client,
  accountId: string,
): Promise<GbpLocation[]> {
  const readMask = 'name,title,storefrontAddress'
  const url = `${BIZ_INFO_BASE}/${accountPath(accountId)}/locations?readMask=${encodeURIComponent(readMask)}`
  const data = await gbpFetch<{ locations?: GbpLocation[] }>(oauthClient, url)
  return data.locations ?? []
}

/**
 * Fetches one page of reviews for a location using the v4 Reviews API.
 * Reviews are ordered by updateTime descending (most recently updated first).
 *
 * google_review_id is the full compound resource name returned in review.name:
 *   "accounts/{accountId}/locations/{locationId}/reviews/{reviewId}"
 * This is stored as-is in gbp_reviews.google_review_id.
 */
export async function fetchGbpReviewsPage(
  oauthClient: Auth.OAuth2Client,
  accountId: string,
  locationId: string,
  pageToken?: string,
): Promise<GbpReviewsPage> {
  const parent = reviewsParentPath(accountId, locationId)
  const params = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc' })
  if (pageToken) params.set('pageToken', pageToken)
  const url = `${REVIEWS_V4_BASE}/${parent}/reviews?${params.toString()}`
  return gbpFetch<GbpReviewsPage>(oauthClient, url)
}

/**
 * Fetches ALL reviews for a location by paginating until exhausted.
 * Use for initial backfill. For incremental sync, use fetchGbpReviewsPage directly.
 */
export async function fetchAllGbpReviews(
  oauthClient: Auth.OAuth2Client,
  accountId: string,
  locationId: string,
): Promise<GbpReview[]> {
  const all: GbpReview[] = []
  let pageToken: string | undefined

  do {
    const page = await fetchGbpReviewsPage(oauthClient, accountId, locationId, pageToken)
    all.push(...page.reviews)
    pageToken = page.nextPageToken
  } while (pageToken)

  return all
}

/**
 * Publishes a review reply to Google.
 *
 * reviewName is gbp_reviews.google_review_id — the full compound v4 resource name.
 * It is used directly as the path prefix without reconstruction.
 *
 * Returns { ok: true } on success.
 * Returns { ok: false, error: string } on failure (does not throw).
 */
export async function publishGbpReviewReply(
  oauthClient: Auth.OAuth2Client,
  reviewName: string,
  comment: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await gbpFetch(
      oauthClient,
      `${REVIEWS_V4_BASE}/${reviewName}/reply`,
      { method: 'PUT', body: JSON.stringify({ comment }) },
    )
    return { ok: true }
  } catch (err) {
    const message = err instanceof GbpApiError
      ? err.message
      : (err instanceof Error ? err.message : 'Unknown error')
    console.error('[gbp-client] publishGbpReviewReply failed:', message)
    return { ok: false, error: message }
  }
}

/**
 * Fetches daily performance metrics for a location over a date range.
 *
 * Requested metrics cover all available interaction types.
 * The Business Profile Performance API supports up to 18 months of history.
 *
 * startDate / endDate: ISO date strings "YYYY-MM-DD"
 */
export async function fetchLocationMetrics(
  oauthClient: Auth.OAuth2Client,
  accountId: string,
  locationId: string,
  startDate: string,
  endDate: string,
): Promise<GbpDailyMetricTimeSeries[]> {
  const location = `${accountPath(accountId)}/${locationInfoPath(locationId)}`
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number)
  const [endYear, endMonth, endDay]       = endDate.split('-').map(Number)

  const params = new URLSearchParams({
    'dailyMetrics':               [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'WEBSITE_CLICKS',
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
    ].join(','),
    'dailyRange.start_date.year':  String(startYear),
    'dailyRange.start_date.month': String(startMonth),
    'dailyRange.start_date.day':   String(startDay),
    'dailyRange.end_date.year':    String(endYear),
    'dailyRange.end_date.month':   String(endMonth),
    'dailyRange.end_date.day':     String(endDay),
  })

  const url = `${PERF_BASE}/${location}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`
  const data = await gbpFetch<GbpMetricsResponse>(oauthClient, url)
  return data.multiDailyMetricTimeSeries ?? []
}
