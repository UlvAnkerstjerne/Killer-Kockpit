/**
 * lib/meta/ig-client.ts
 *
 * Instagram Graph API client for organic content and account metrics.
 *
 * Metric defensiveness:
 *   Instagram metrics vary by media type and API version. Missing metrics
 *   in a response are left as null — they do not crash the sync.
 *   Deprecated field names are not requested. Any metric returned by the
 *   API that is not in our structured columns goes into other_metrics_json.
 *
 * Current v26 metric strategy:
 *   Account insights: reach, accounts_engaged, profile_views (period=day)
 *   followers_count:  from the IG User object (not insights edge)
 *   Media insights:   reach, plays (video/reel), saved, likes, comments,
 *                     shares, total_interactions
 *   `impressions` is deprecated for some media types in v26 — not requested.
 */

import { META_GRAPH_BASE_URL } from './api-version'
import { getMetaAuthHeaders } from './auth'
import { MetaApiError, MetaRateLimitError } from './client'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface IgMedia {
  id:           string
  media_type:   string   // IMAGE | VIDEO | CAROUSEL_ALBUM | REEL
  caption:      string | null
  permalink:    string | null
  published_at: string | null  // from `timestamp` field
}

export interface IgMediaInsights {
  reach?:              number
  plays?:              number
  saved?:              number
  likes?:              number
  comments?:           number
  shares?:             number
  total_interactions?: number
  other_metrics_json?: Record<string, number>
}

export interface IgAccountDailyMetrics {
  reach?:            number
  accounts_engaged?: number
  profile_views?:    number
  followers_count?:  number
  other_metrics_json?: Record<string, number>
}

// ── Fetch helper ───────────────────────────────────────────────────────────────

async function igFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
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

async function igFetchAllPages<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const results: T[] = []
  let after: string | undefined
  const MAX_PAGES = 200
  let pages = 0

  while (pages < MAX_PAGES) {
    const pageParams = after ? { ...params, after } : params
    const body = await igFetch(path, pageParams) as {
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

// ── Media list ─────────────────────────────────────────────────────────────────

/**
 * Returns IG media items. Pass `since` (Unix timestamp) to fetch only
 * items published after that time (incremental sync).
 */
export async function fetchIgMedia(
  igAccountId: string,
  since?: number,
): Promise<IgMedia[]> {
  const params: Record<string, string> = {
    fields: 'id,media_type,caption,permalink,timestamp',
    limit:  '100',
  }
  if (since !== undefined) params.since = String(since)

  const raw = await igFetchAllPages<{
    id: string; media_type: string; caption?: string
    permalink?: string; timestamp?: string
  }>(`${igAccountId}/media`, params)

  return raw.map((m) => ({
    id:           m.id,
    media_type:   m.media_type,
    caption:      m.caption ?? null,
    permalink:    m.permalink ?? null,
    published_at: m.timestamp ?? null,
  }))
}

// ── Media insights ─────────────────────────────────────────────────────────────
//
// Metric availability varies by media type and account age (>2 years → reach/plays unavailable).
// We request the full current set and handle missing keys gracefully.
// `impressions` not requested — deprecated in v26 for some media types.

const STRUCTURED_IG_MEDIA_METRICS = new Set([
  'reach', 'plays', 'saved', 'likes', 'comments', 'shares', 'total_interactions',
])

export async function fetchIgMediaInsights(
  mediaId: string,
  mediaType: string,
): Promise<IgMediaInsights | null> {
  // plays only available for video/reel types
  const isVideo = mediaType === 'VIDEO' || mediaType === 'REEL'
  const requestMetrics = isVideo
    ? 'reach,plays,saved,likes,comments,shares,total_interactions'
    : 'reach,saved,likes,comments,shares,total_interactions'

  let body: unknown
  try {
    body = await igFetch(`${mediaId}/insights`, { metric: requestMetrics })
  } catch (err) {
    if (err instanceof MetaRateLimitError) throw err
    // Media may be too old (>2 years) or insights unavailable — return null, not crash
    console.warn(`[ig-client] Media insights unavailable for ${mediaId}:`, (err as Error).message)
    return null
  }

  const data = (body as { data?: Array<{ name: string; values: Array<{ value: number }> }> }).data ?? []
  const structured: IgMediaInsights = {}
  const other: Record<string, number> = {}

  for (const item of data) {
    const val = item.values?.[0]?.value ?? null
    if (val === null) continue
    if (STRUCTURED_IG_MEDIA_METRICS.has(item.name)) {
      (structured as Record<string, unknown>)[item.name] = val
    } else {
      other[item.name] = val
    }
  }

  if (Object.keys(other).length > 0) structured.other_metrics_json = other
  return structured
}

// ── Account daily insights ─────────────────────────────────────────────────────
//
// v26 breaking change: `accounts_engaged` and `profile_views` now require
// metric_type=total_value. `reach` still uses the legacy period=day style.
// Split into two requests and merge results.

const STRUCTURED_IG_ACCOUNT_METRICS = new Set([
  'reach', 'accounts_engaged', 'profile_views',
])

export async function fetchIgAccountDailyInsights(
  igAccountId: string,
  date: string,  // "YYYY-MM-DD"
): Promise<IgAccountDailyMetrics> {
  // IG insights API requires Unix timestamps for since/until — date strings return []
  const ts    = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
  const tsEnd = ts + 86400

  const [reachBody, totalValueBody, accountBody] = await Promise.allSettled([
    // reach: legacy period-based request (requires Unix timestamps, not date strings)
    igFetch(`${igAccountId}/insights`, {
      metric: 'reach',
      period: 'day',
      since:  String(ts),
      until:  String(tsEnd),
    }),
    // accounts_engaged + profile_views: require metric_type=total_value in v26
    igFetch(`${igAccountId}/insights`, {
      metric:      'accounts_engaged,profile_views',
      metric_type: 'total_value',
      period:      'day',
      since:       String(ts),
      until:       String(tsEnd),
    }),
    igFetch(igAccountId, { fields: 'followers_count' }),
  ])

  const result: IgAccountDailyMetrics = {}
  const other: Record<string, number> = {}

  function parseInsightsBody(settled: PromiseSettledResult<unknown>, label: string) {
    if (settled.status === 'fulfilled') {
      const data = (settled.value as {
        data?: Array<{ name: string; values: Array<{ value: number }> }>
      }).data ?? []
      for (const item of data) {
        const val = item.values?.[0]?.value ?? null
        if (val === null) continue
        if (STRUCTURED_IG_ACCOUNT_METRICS.has(item.name)) {
          (result as Record<string, unknown>)[item.name] = val
        } else {
          other[item.name] = val
        }
      }
    } else {
      console.warn(`[ig-client] ${label} unavailable for ${igAccountId}:`, settled.reason)
    }
  }

  parseInsightsBody(reachBody, 'reach insights')
  parseInsightsBody(totalValueBody, 'total_value insights')

  if (accountBody.status === 'fulfilled') {
    const fc = (accountBody.value as { followers_count?: number }).followers_count
    if (fc !== undefined) result.followers_count = fc
  }

  if (Object.keys(other).length > 0) result.other_metrics_json = other
  return result
}
