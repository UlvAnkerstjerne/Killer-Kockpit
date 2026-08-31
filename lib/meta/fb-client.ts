/**
 * lib/meta/fb-client.ts
 *
 * Facebook Pages API client for organic page and post data.
 *
 * v26 metric strategy:
 *   Page insights: views (replaces deprecated impressions), reach, engaged_users
 *   page_fans / page_impressions are deprecated — not requested.
 *   fan_count fetched from the Page object (not insights edge).
 *   Post insights: views, reach, engaged_users, reactions, comments, shares, clicks.
 *   `post_impressions` deprecated; `views` used instead.
 *
 * Metric defensiveness:
 *   Missing metrics in API responses remain null — they do not crash the sync.
 *   Unknown metrics returned by the API go into other_metrics_json.
 */

import { META_GRAPH_BASE_URL } from './api-version'
import { getMetaAuthHeaders } from './auth'
import { MetaApiError, MetaRateLimitError } from './client'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FbPageDailyMetrics {
  views?:         number
  reach?:         number
  engaged_users?: number
  fan_count?:     number
  other_metrics_json?: Record<string, number>
}

export interface FbPost {
  id:           string
  post_type:    string    // link | status | photo | video | reel
  message:      string | null
  permalink:    string | null
  published_at: string    // ISO timestamp
}

export interface FbPostInsights {
  views?:            number
  reach?:            number
  engaged_users?:    number
  reactions_total?:  number
  comments?:         number
  shares?:           number
  clicks?:           number
  other_metrics_json?: Record<string, number>
}

// ── Fetch helper ───────────────────────────────────────────────────────────────

async function fbFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const headers = getMetaAuthHeaders()
  if (!headers) throw new MetaApiError('META_SYSTEM_USER_TOKEN not configured')

  const url = new URL(`${META_GRAPH_BASE_URL}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), { headers })
  const body = await res.json() as Record<string, unknown>

  if (!res.ok || body.error) {
    const err = body.error as { message?: string; code?: number; type?: string } | undefined
    throw new MetaApiError(err?.message ?? `HTTP ${res.status}`, err?.code, err?.type)
  }

  return body
}

/** Fetch using an explicit bearer token instead of the system user token. */
async function fbFetchWithToken(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(`${META_GRAPH_BASE_URL}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json() as Record<string, unknown>
  if (!res.ok || body.error) {
    const err = body.error as { message?: string; code?: number; type?: string } | undefined
    throw new MetaApiError(err?.message ?? `HTTP ${res.status}`, err?.code, err?.type)
  }
  return body
}

async function fbFetchAllPages<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const results: T[] = []
  let after: string | undefined
  const MAX_PAGES = 200
  let pages = 0

  while (pages < MAX_PAGES) {
    const pageParams = after ? { ...params, after } : params
    const body = await fbFetch(path, pageParams) as {
      data?: T[]
      paging?: { cursors?: { after?: string }; next?: string }
    }
    results.push(...(body.data ?? []))
    pages++
    after = body.paging?.cursors?.after
    if (!after || !body.paging?.next) break
  }

  return results
}

async function fbFetchAllPagesWithToken<T>(
  path: string,
  token: string,
  params: Record<string, string>,
): Promise<T[]> {
  const results: T[] = []
  let after: string | undefined
  const MAX_PAGES = 200
  let pages = 0

  while (pages < MAX_PAGES) {
    const pageParams = after ? { ...params, after } : params
    const body = await fbFetchWithToken(path, token, pageParams) as {
      data?: T[]
      paging?: { cursors?: { after?: string }; next?: string }
    }
    results.push(...(body.data ?? []))
    pages++
    after = body.paging?.cursors?.after
    if (!after || !body.paging?.next) break
  }

  return results
}

// ── Page Access Token ───────────────────────────────────────────────────────────
//
// IMPORTANT: Several Facebook Page-scoped edges (/posts, /insights) reject the
// System User token with (#190) "Invalid OAuth 2.0 Access Token". The System
// User token IS accepted for the Page object itself (GET /{page-id}?fields=...),
// which returns a short-lived Page Access Token that works for these edges.
//
// fetchPageToken() is the single place that performs this exchange. Callers
// that need to make multiple page-scoped API calls within one sync run should
// call fetchPageToken() once and pass the token to each downstream function.

/**
 * Returns the Page Access Token for a Facebook Page using the System User token.
 * Returns null if the exchange fails (caller should abort gracefully).
 */
export async function fetchPageToken(pageId: string): Promise<string | null> {
  try {
    const body = await fbFetch(pageId, { fields: 'access_token' }) as { access_token?: string }
    return body.access_token ?? null
  } catch {
    return null
  }
}

// ── Page discovery ─────────────────────────────────────────────────────────────

/**
 * Returns the Instagram Business Account ID linked to a Facebook Page.
 * Used by discoverMetaAssets() so the IG account ID does not have to be
 * guessed or set manually.
 */
export async function fetchLinkedIgAccountId(pageId: string): Promise<string | null> {
  try {
    const body = await fbFetch(pageId, {
      fields: 'instagram_business_account',
    }) as { instagram_business_account?: { id: string } }
    return body.instagram_business_account?.id ?? null
  } catch {
    return null
  }
}

// ── Page daily metrics ─────────────────────────────────────────────────────────
//
// v26 field names only. `page_impressions` / `page_fans` are deprecated.
// fan_count comes from the Page object, not the insights edge.
//
// IMPORTANT: /{pageId}/insights requires a Page Access Token — the System
// User token is rejected with (#190). We fetch the page token via
// GET /{pageId}?fields=access_token,fan_count (system user token is fine
// for Page object fields) and use it for the insights call.
//
// Metric name corrections (v26):
//   `page_views_total`      replaces deprecated `views`
//   `page_post_engagements` is valid (maps to engaged_users column)
//   `page_daily_follows`    is valid (stored in other_metrics_json)

const STRUCTURED_PAGE_METRICS = new Set(['views', 'reach', 'engaged_users'])

const PAGE_METRIC_MAP: Record<string, keyof FbPageDailyMetrics> = {
  page_views_total:      'views',
  page_post_engagements: 'engaged_users',
}

export async function fetchPageDailyInsights(
  pageId: string,
  date: string,  // "YYYY-MM-DD"
): Promise<FbPageDailyMetrics> {
  const result: FbPageDailyMetrics = {}
  const other: Record<string, number> = {}

  // Step 1: fetch page access token + fan_count from the Page object
  // (system user token is accepted here)
  let pageToken: string | null = null
  try {
    const pageBody = await fbFetch(pageId, { fields: 'access_token,fan_count' }) as {
      access_token?: string
      fan_count?:    number
    }
    pageToken = pageBody.access_token ?? null
    if (pageBody.fan_count !== undefined) result.fan_count = pageBody.fan_count
  } catch (err) {
    console.warn(`[fb-client] Page object fetch failed for ${pageId}:`, (err as Error).message)
  }

  if (!pageToken) {
    console.warn(`[fb-client] No page access token for ${pageId} — insights skipped`)
    return result
  }

  // Step 2: use page token for insights (system user token rejected by this endpoint)
  try {
    const insightsBody = await fbFetchWithToken(`${pageId}/insights`, pageToken, {
      metric: 'page_views_total,page_post_engagements,page_daily_follows',
      period: 'day',
      since:  date,
      until:  date,
    })

    const data = (insightsBody as {
      data?: Array<{ name: string; values: Array<{ value: number; end_time: string }> }>
    }).data ?? []

    for (const item of data) {
      const val = item.values?.[0]?.value ?? null
      if (val === null) continue
      const col = PAGE_METRIC_MAP[item.name]
      if (col) {
        (result as Record<string, unknown>)[col] = val
      } else if (!STRUCTURED_PAGE_METRICS.has(item.name)) {
        other[item.name] = val
      }
    }
  } catch (err) {
    console.warn(`[fb-client] Page insights unavailable for ${pageId}:`, (err as Error).message)
  }

  if (Object.keys(other).length > 0) result.other_metrics_json = other
  return result
}

// ── Post list ──────────────────────────────────────────────────────────────────

function classifyPostType(attachments?: { data?: Array<{ media_type?: string }> }): string {
  const type = attachments?.data?.[0]?.media_type?.toLowerCase()
  switch (type) {
    case 'photo':  return 'photo'
    case 'video':  return 'video'
    case 'link':   return 'link'
    default:       return 'status'
  }
}

export async function fetchFbPosts(
  pageId: string,
  since: string | undefined,
  pageToken: string,
): Promise<FbPost[]> {
  const params: Record<string, string> = {
    fields: 'id,message,permalink_url,created_time,attachments{media_type}',
    limit:  '100',
  }
  if (since) params.since = since

  const raw = await fbFetchAllPagesWithToken<{
    id: string
    message?: string
    permalink_url?: string
    created_time: string
    attachments?: { data?: Array<{ media_type?: string }> }
  }>(`${pageId}/posts`, pageToken, params)

  return raw.map((p) => ({
    id:           p.id,
    post_type:    classifyPostType(p.attachments),
    message:      p.message ?? null,
    permalink:    p.permalink_url ?? null,
    published_at: p.created_time,
  }))
}

// ── Post insights ──────────────────────────────────────────────────────────────
//
// v26 metric names. `post_impressions` deprecated; use `views`.
// Missing metrics → null, not a crash.

// v26 post insights: many "impressions" metric names were deprecated.
// We split into two groups to prevent one invalid name from blocking the entire request.
// Group A — engagement metrics (stable in v26):
const POST_METRICS_A = 'post_impressions_unique,post_engaged_users'
// Group B — reaction/click breakdown metrics:
const POST_METRICS_B = 'post_reactions_by_type_total,post_clicks_by_type'

const STRUCTURED_POST_METRICS: Record<string, keyof FbPostInsights> = {
  post_impressions_unique: 'reach',
  post_engaged_users:      'engaged_users',
}

function parsePostInsightsBody(
  body: unknown,
  result: FbPostInsights,
  other: Record<string, unknown>,
): void {
  const data = (body as {
    data?: Array<{ name: string; values: Array<{ value: number | Record<string, number> }> }>
  }).data ?? []

  for (const item of data) {
    const rawVal = item.values?.[0]?.value
    const col = STRUCTURED_POST_METRICS[item.name]

    if (col && typeof rawVal === 'number') {
      (result as Record<string, unknown>)[col] = rawVal
    } else if (item.name === 'post_reactions_by_type_total' && rawVal && typeof rawVal === 'object') {
      result.reactions_total = Object.values(rawVal as Record<string, number>)
        .reduce((sum, v) => sum + v, 0)
    } else if (item.name === 'post_clicks_by_type' && rawVal && typeof rawVal === 'object') {
      result.clicks = Object.values(rawVal as Record<string, number>)
        .reduce((sum, v) => sum + v, 0)
    } else if (rawVal !== undefined) {
      other[item.name] = rawVal
    }
  }
}

export async function fetchFbPostInsights(
  postId: string,
  pageToken: string,
): Promise<FbPostInsights | null> {
  const result: FbPostInsights = {}
  const other: Record<string, unknown> = {}
  let anyData = false

  // Each group is requested independently — one invalid metric does not block the other.
  const [bodyA, bodyB] = await Promise.allSettled([
    fbFetchWithToken(`${postId}/insights`, pageToken, { metric: POST_METRICS_A }),
    fbFetchWithToken(`${postId}/insights`, pageToken, { metric: POST_METRICS_B }),
  ])

  if (bodyA.status === 'fulfilled') {
    parsePostInsightsBody(bodyA.value, result, other)
    anyData = true
  } else {
    if (bodyA.reason instanceof MetaRateLimitError) throw bodyA.reason
    console.warn(`[fb-client] Post insights (group A) unavailable for ${postId}:`, (bodyA.reason as Error).message)
  }

  if (bodyB.status === 'fulfilled') {
    parsePostInsightsBody(bodyB.value, result, other)
    anyData = true
  } else {
    if (bodyB.reason instanceof MetaRateLimitError) throw bodyB.reason
    console.warn(`[fb-client] Post insights (group B) unavailable for ${postId}:`, (bodyB.reason as Error).message)
  }

  if (!anyData) return null

  if (Object.keys(other).length > 0) result.other_metrics_json = other as Record<string, number>
  return result
}
