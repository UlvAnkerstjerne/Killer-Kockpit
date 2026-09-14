/**
 * lib/meta/client.ts
 *
 * Graph API client for Meta paid advertising data.
 * Covers ad accounts, campaign/ad set/ad structure, and Insights.
 *
 * Design:
 *   - Uses raw fetch against META_GRAPH_BASE_URL (no SDK dependency).
 *   - All functions accept the Authorization header directly (from getMetaAuthHeaders()).
 *   - Pagination is handled internally; callers receive complete arrays.
 *   - Rate limiting: checks x-business-use-case-usage header; backs off if ≥ 75.
 *   - Error envelope: Meta errors are parsed and thrown with the error code preserved.
 *   - Money values are returned as-is (decimal strings from Meta) and parsed to
 *     numeric strings for storage; never converted to floats.
 *
 * Insights level choices:
 *   fetchAdInsights   → level=ad     (ad-level reach; do NOT aggregate for campaign reach)
 *   fetchCampaignInsights → level=campaign (correct campaign reach + frequency)
 */

import { META_GRAPH_BASE_URL } from './api-version'
import { getMetaAuthHeaders } from './auth'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MetaAdAccount {
  id:             string
  name:           string
  currency:       string
  account_status: number
}

export interface MetaCampaign {
  id:              string
  ad_account_id:   string
  name:            string
  status:          string
  objective:       string | null
  daily_budget:    string | null  // Meta returns as decimal string
  lifetime_budget: string | null
  created_time:    string | null
}

export interface MetaAdSet {
  id:           string
  campaign_id:  string
  name:         string
  status:       string
  daily_budget: string | null
}

export interface MetaAd {
  id:         string
  adset_id:   string
  name:       string
  status:     string
}

export interface MetaInsightRow {
  ad_id?:              string
  campaign_id?:        string
  date_start:          string   // "YYYY-MM-DD"
  impressions?:        string   // Meta returns as string
  reach?:              string
  clicks?:             string
  inline_link_clicks?: string
  spend?:              string   // exact decimal string — do not convert to float
  cpm?:                string
  cpc?:                string
  ctr?:                string
  frequency?:          string   // campaign-level only
  actions?:            Array<{ action_type: string; value: string }>
  cost_per_action_type?: Array<{ action_type: string; value: string }>
  action_values?:      Array<{ action_type: string; value: string }>
}

// ── Rate limit check ───────────────────────────────────────────────────────────

const RATE_LIMIT_THRESHOLD = 75

function checkRateLimit(headers: Headers): void {
  const usage = headers.get('x-business-use-case-usage')
  if (!usage) return
  try {
    // The header value is a JSON object keyed by account ID
    const parsed = JSON.parse(usage) as Record<string, Array<{ call_count?: number }>>
    const scores = Object.values(parsed).flatMap((arr) =>
      arr.map((item) => item.call_count ?? 0)
    )
    const max = Math.max(0, ...scores)
    if (max >= RATE_LIMIT_THRESHOLD) {
      throw new MetaRateLimitError(`Rate limit score ${max} — backing off`)
    }
  } catch (err) {
    if (err instanceof MetaRateLimitError) throw err
    // Parse failure: ignore — don't crash sync on a header we can't read
  }
}

// ── Error types ────────────────────────────────────────────────────────────────

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly type?: string,
  ) {
    super(message)
    this.name = 'MetaApiError'
  }
}

export class MetaRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetaRateLimitError'
  }
}

// ── Internal fetch helper ──────────────────────────────────────────────────────

async function graphFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const headers = getMetaAuthHeaders()
  if (!headers) throw new MetaApiError('META_SYSTEM_USER_TOKEN not configured')

  const url = new URL(`${META_GRAPH_BASE_URL}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), { headers })

  checkRateLimit(res.headers)

  const body = await res.json() as Record<string, unknown>

  if (!res.ok || body.error) {
    const err = body.error as { message?: string; code?: number; type?: string } | undefined
    throw new MetaApiError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code,
      err?.type,
    )
  }

  return body
}

// ── Pagination helper ──────────────────────────────────────────────────────────

async function fetchAllPages<T>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const results: T[] = []
  let after: string | undefined

  // Safety limit to prevent infinite loops on unexpected API behaviour
  const MAX_PAGES = 200
  let pages = 0

  while (pages < MAX_PAGES) {
    const pageParams = after ? { ...params, after } : params
    const body = await graphFetch(path, pageParams) as {
      data?: T[]
      paging?: { cursors?: { after?: string }; next?: string }
    }

    const items = body.data ?? []
    results.push(...items)
    pages++

    after = body.paging?.cursors?.after
    if (!after || !body.paging?.next) break
  }

  return results
}

// ── Ad account discovery ───────────────────────────────────────────────────────

/**
 * Returns all ad accounts accessible to the system user.
 * Used by discoverMetaAssets() for initial setup; callers confirm which
 * account is the Killer Kebab account before storing the ID in env.
 */
export async function fetchAdAccounts(): Promise<MetaAdAccount[]> {
  return fetchAllPages<MetaAdAccount>('me/adaccounts', {
    fields: 'id,name,currency,account_status',
    limit:  '50',
  })
}

// ── Campaign structure ─────────────────────────────────────────────────────────

export async function fetchCampaigns(adAccountId: string): Promise<MetaCampaign[]> {
  const raw = await fetchAllPages<{
    id: string; name: string; status: string; objective?: string
    daily_budget?: string; lifetime_budget?: string; created_time?: string
  }>(`${adAccountId}/campaigns`, {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget,created_time',
    limit:  '100',
  })
  return raw.map((c) => ({
    id:              c.id,
    ad_account_id:   adAccountId,
    name:            c.name,
    status:          c.status,
    objective:       c.objective ?? null,
    daily_budget:    c.daily_budget ?? null,
    lifetime_budget: c.lifetime_budget ?? null,
    created_time:    c.created_time ?? null,
  }))
}

export async function fetchAdSets(campaignId: string): Promise<MetaAdSet[]> {
  const raw = await fetchAllPages<{
    id: string; name: string; status: string; daily_budget?: string
  }>(`${campaignId}/adsets`, {
    fields: 'id,name,status,daily_budget',
    limit:  '100',
  })
  return raw.map((s) => ({
    id:           s.id,
    campaign_id:  campaignId,
    name:         s.name,
    status:       s.status,
    daily_budget: s.daily_budget ?? null,
  }))
}

export async function fetchAds(adSetId: string): Promise<MetaAd[]> {
  const raw = await fetchAllPages<{ id: string; name: string; status: string }>(
    `${adSetId}/ads`,
    { fields: 'id,name,status', limit: '100' },
  )
  return raw.map((a) => ({
    id:       a.id,
    adset_id: adSetId,
    name:     a.name,
    status:   a.status,
  }))
}

// ── Ad-level insights ──────────────────────────────────────────────────────────
//
// reach at ad level = unique people who saw THIS specific ad.
// Do NOT sum ad-level reach to derive campaign reach (non-additive).
// Use fetchCampaignInsights() for correct campaign-level reach and frequency.

const AD_INSIGHT_FIELDS = [
  'ad_id',
  'date_start',
  'impressions',
  'reach',
  'clicks',
  'inline_link_clicks',
  'spend',
  'cpm',
  'cpc',
  'ctr',
  'actions',
  'cost_per_action_type',
  'action_values',
].join(',')

export async function fetchAdInsights(
  adAccountId: string,
  startDate: string,  // "YYYY-MM-DD"
  endDate: string,
): Promise<MetaInsightRow[]> {
  return fetchAllPages<MetaInsightRow>(`${adAccountId}/insights`, {
    fields:         AD_INSIGHT_FIELDS,
    level:          'ad',
    time_increment: '1',
    time_range:     JSON.stringify({ since: startDate, until: endDate }),
    limit:          '500',
  })
}

// ── Campaign-level insights ────────────────────────────────────────────────────
//
// Fetched directly at campaign level — reach and frequency are correct here.
// Never derive these by summing ad-level rows.

const CAMPAIGN_INSIGHT_FIELDS = [
  'campaign_id',
  'date_start',
  'impressions',
  'reach',
  'clicks',
  'inline_link_clicks',
  'spend',
  'cpm',
  'cpc',
  'ctr',
  'frequency',
  'actions',
  'cost_per_action_type',
  'action_values',
].join(',')

export async function fetchCampaignInsights(
  adAccountId: string,
  startDate: string,
  endDate: string,
): Promise<MetaInsightRow[]> {
  return fetchAllPages<MetaInsightRow>(`${adAccountId}/insights`, {
    fields:         CAMPAIGN_INSIGHT_FIELDS,
    level:          'campaign',
    time_increment: '1',
    time_range:     JSON.stringify({ since: startDate, until: endDate }),
    limit:          '500',
  })
}
