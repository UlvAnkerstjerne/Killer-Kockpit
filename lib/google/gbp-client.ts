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
import { GBP_DAILY_METRICS } from '@/lib/gbp/metrics'

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
  languageCode?: string
  storeCode?: string
  categories?: { primaryCategory?: GbpCategory; additionalCategories?: GbpCategory[] }
  websiteUri?: string
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] }
  storefrontAddress?: { regionCode?: string; postalCode?: string; locality?: string; administrativeArea?: string; addressLines?: string[] }
  regularHours?: Record<string, unknown>
  specialHours?: Record<string, unknown>
  moreHours?: Array<Record<string, unknown>>
  openInfo?: { status?: string; canReopen?: boolean; openingDate?: Record<string, number> }
  metadata?: Record<string, unknown>
  profile?: Record<string, unknown>
  serviceArea?: Record<string, unknown>
  latlng?: { latitude?: number; longitude?: number }
  relationshipData?: Record<string, unknown>
  labels?: string[]
}

export interface GbpCategory { name: string; displayName?: string }

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
    datedValues?: Array<{
      date: { year: number; month: number; day: number }
      value?: string
    }>
  }
}

export interface GbpMetricsResponse {
  multiDailyMetricTimeSeries?: Array<{ dailyMetricTimeSeries?: GbpDailyMetricTimeSeries[] }>
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
  let token: string | null | undefined
  try { token = (await oauthClient.getAccessToken()).token }
  catch { throw new GbpApiError(401, 'OAUTH_REFRESH_FAILED', url) }
  if (!token) throw new GbpApiError(401, 'No access token available', url)
  let response: Response
  try {
    response = await fetch(url, {
      ...options, cache: 'no-store', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    })
  } catch { throw new GbpApiError(0, 'NETWORK_OR_TIMEOUT', url) }
  if (!response.ok) {
    // Only Google's bounded machine-readable reason is safe to return/log.
    let reason = 'API_REQUEST_FAILED'
    try {
      const body = await response.json() as { error?: { status?: string; details?: Array<{ reason?: string }> } }
      const candidate = body.error?.details?.find(d => d.reason)?.reason ?? body.error?.status
      if (candidate && /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate)) reason = candidate
    } catch { /* retain safe fallback */ }
    throw new GbpApiError(response.status, reason, url)
  }
  try { return await response.json() as T }
  catch { throw new GbpApiError(response.status, 'INVALID_JSON_RESPONSE', url) }
}

export class GbpApiError extends Error {
  constructor(public readonly status: number, reason: string, public readonly url: string) {
    super(`GBP API ${status}: ${reason} (${new URL(url).hostname}${new URL(url).pathname})`)
    this.name = 'GbpApiError'
  }
}

export function safeGbpError(error: unknown): string {
  return error instanceof GbpApiError ? error.message : 'GBP sync operation failed. No credentials were logged.'
}

/** All list APIs must exhaust pagination; never accept a repeated token as success. */
async function fetchPages<T>(client: Auth.OAuth2Client, baseUrl: string, key: string): Promise<T[]> {
  const rows: T[] = []
  const seen = new Set<string>()
  let token: string | undefined
  do {
    const url = new URL(baseUrl)
    if (token) url.searchParams.set('pageToken', token)
    const page = await gbpFetch<Record<string, unknown>>(client, url.toString())
    const items = page[key]
    if (items !== undefined && !Array.isArray(items)) throw new GbpApiError(200, 'INVALID_LIST_RESPONSE', baseUrl)
    rows.push(...((items ?? []) as T[]))
    token = page.nextPageToken as string | undefined
    if (token && (seen.has(token) || seen.size >= 1000)) throw new GbpApiError(200, 'PAGINATION_INCOMPLETE', baseUrl)
    if (token) seen.add(token)
  } while (token)
  return rows
}

// ── API functions ──────────────────────────────────────────────────────────────

/**
 * Lists all GBP accounts accessible to the credential holder.
 * Returns the accounts array (may be empty if the account has no GBP access).
 */
export async function fetchGbpAccounts(
  oauthClient: Auth.OAuth2Client,
): Promise<GbpAccount[]> {
  return fetchPages<GbpAccount>(oauthClient, `${ACCOUNT_MGMT_BASE}/accounts?pageSize=20`, 'accounts')
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
  const readMask = 'name,title,languageCode,storeCode,categories,websiteUri,phoneNumbers,storefrontAddress,regularHours,specialHours,moreHours,openInfo,metadata,profile,serviceArea,latlng,relationshipData,labels'
  const url = `${BIZ_INFO_BASE}/${accountPath(accountId)}/locations?pageSize=100&readMask=${encodeURIComponent(readMask)}`
  return fetchPages<GbpLocation>(oauthClient, url, 'locations')
}

/**
 * Lists all GBP locations using the wildcard account path (accounts/-/locations).
 * Required for listings managed indirectly through location groups, which are
 * not returned by the per-account endpoint.
 *
 * NOTE: The wildcard response does not carry a parent account ID.
 * Callers are responsible for safe account association.
 */
export async function fetchGbpLocationsWildcard(
  oauthClient: Auth.OAuth2Client,
): Promise<GbpLocation[]> {
  const readMask = 'name,title,languageCode,storeCode,categories,websiteUri,phoneNumbers,storefrontAddress,regularHours,specialHours,moreHours,openInfo,metadata,profile,serviceArea,latlng,relationshipData,labels'
  const url = `${BIZ_INFO_BASE}/accounts/-/locations?pageSize=100&readMask=${encodeURIComponent(readMask)}`
  return fetchPages<GbpLocation>(oauthClient, url, 'locations')
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
  const page = await gbpFetch<GbpReviewsPage>(oauthClient, url)
  if (page.reviews !== undefined && !Array.isArray(page.reviews)) throw new GbpApiError(200, 'INVALID_REVIEWS_RESPONSE', url)
  return { ...page, reviews: page.reviews ?? [] }
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
  const seen = new Set<string>()

  do {
    const page = await fetchGbpReviewsPage(oauthClient, accountId, locationId, pageToken)
    all.push(...page.reviews)
    pageToken = page.nextPageToken
    if (pageToken && (seen.has(pageToken) || seen.size >= 1000)) throw new GbpApiError(200, 'PAGINATION_INCOMPLETE', `${REVIEWS_V4_BASE}/${reviewsParentPath(accountId, locationId)}/reviews`)
    if (pageToken) seen.add(pageToken)
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
    const message = safeGbpError(err)
    console.error('[gbp-client] publishGbpReviewReply failed:', message)
    return { ok: false, error: message }
  }
}

/**
 * Fetches daily performance metrics for a location over a date range.
 *
 * Requested metrics cover all available interaction types.
 * Kockpit requests an 18-month backfill; actual available history is reported separately.
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
  const location = locationInfoPath(locationId)
  void accountId // Preserve the existing client signature; Performance is location-scoped.
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number)
  const [endYear, endMonth, endDay]       = endDate.split('-').map(Number)

  const params = new URLSearchParams({
    'dailyRange.start_date.year':  String(startYear),
    'dailyRange.start_date.month': String(startMonth),
    'dailyRange.start_date.day':   String(startDay),
    'dailyRange.end_date.year':    String(endYear),
    'dailyRange.end_date.month':   String(endMonth),
    'dailyRange.end_date.day':     String(endDay),
  })

  for (const metric of GBP_DAILY_METRICS) params.append('dailyMetrics', metric)
  const url = `${PERF_BASE}/${location}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`
  const data = await gbpFetch<GbpMetricsResponse>(oauthClient, url)
  if (!Array.isArray(data.multiDailyMetricTimeSeries)) throw new GbpApiError(200, 'MISSING_METRIC_SERIES', url)
  return data.multiDailyMetricTimeSeries.flatMap(group => {
    if (!Array.isArray(group.dailyMetricTimeSeries)) throw new GbpApiError(200, 'INVALID_METRIC_SERIES', url)
    return group.dailyMetricTimeSeries
  })
}

export interface GbpSearchKeyword {
  searchKeyword: string
  insightsValue?: { value?: string; threshold?: string }
}

/** One calendar month per call: Google aggregates the entire requested range. */
export async function fetchGbpSearchKeywords(client: Auth.OAuth2Client, locationId: string, month: string): Promise<GbpSearchKeyword[]> {
  const [year, monthNumber] = month.split('-')
  const params = new URLSearchParams({ pageSize: '100',
    'monthlyRange.start_month.year': year, 'monthlyRange.start_month.month': String(Number(monthNumber)),
    'monthlyRange.end_month.year': year, 'monthlyRange.end_month.month': String(Number(monthNumber)),
  })
  return fetchPages<GbpSearchKeyword>(client, `${PERF_BASE}/${locationInfoPath(locationId)}/searchkeywords/impressions/monthly?${params}`, 'searchKeywordsCounts')
}
