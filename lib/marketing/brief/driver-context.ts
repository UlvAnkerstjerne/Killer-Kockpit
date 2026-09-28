/**
 * lib/marketing/brief/driver-context.ts
 *
 * Collects additional cross-channel context needed for driver detection.
 *
 * This supplements BriefInputData with longer-window data (28d Google Ads totals,
 * daily activity series, campaign pause state, posting cadence) that the
 * standard 7d collect-data.ts does not provide.
 *
 * All data comes from already-synced DB tables — no live API calls.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllPages } from './collect-data'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GoogleAdsDriverContext {
  /** 28d totals for Google Ads — matches GBP 28d window */
  total_spend_28d:          number
  total_spend_prior_28d:    number | null
  total_impressions_28d:    number
  total_impressions_prior_28d: number | null
  total_clicks_28d:         number
  total_clicks_prior_28d:   number | null
  /** Daily activity series for last 56 days — for pause/activity detection */
  daily_series:             Array<{ date: string; spend: number; impressions: number; clicks: number }>
  /** Last date with any spend > 0 across all campaigns */
  last_active_date:         string | null
  /** Count of campaigns by status */
  enabled_count:            number
  paused_count:             number
  /** Campaign IDs that are currently PAUSED */
  paused_campaign_ids:      string[]
}

export interface MetaPaidDriverContext {
  /** 28d + prior 28d click totals */
  total_clicks_28d:         number
  total_clicks_prior_28d:   number | null
  total_spend_28d:          number
  total_spend_prior_28d:    number | null
}

export interface IgPostingCadenceContext {
  /** Posts published in current 7d window */
  posts_current_7d:         number
  /** Posts published in prior 7d window */
  posts_prior_7d:           number
  /** Exceptional post IDs (with reach > 3× format median) in current window */
  exceptional_post_ids:     string[]
}

export interface DriverContextData {
  googleAds:     GoogleAdsDriverContext | null
  metaPaid:      MetaPaidDriverContext | null
  igCadence:     IgPostingCadenceContext
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function subtractDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ─── Google Ads 28d context ─────────────────────────────────────────────────

type Db = ReturnType<typeof createServiceClient>

async function collectGoogleAdsDriverContext(
  db: Db,
  yesterday: string,
): Promise<GoogleAdsDriverContext | null> {
  const { data: accounts } = await db
    .from('google_ads_accounts')
    .select('customer_id')

  if (!accounts || accounts.length === 0) return null

  const customerIds = accounts.map(a => a.customer_id as string)

  const { data: campaigns } = await db
    .from('google_ads_campaigns')
    .select('customer_id, campaign_id, status')
    .in('customer_id', customerIds)

  if (!campaigns || campaigns.length === 0) return null

  const enabled_count = campaigns.filter(c => c.status === 'ENABLED').length
  const paused_count  = campaigns.filter(c => c.status === 'PAUSED').length
  const paused_campaign_ids = campaigns
    .filter(c => c.status === 'PAUSED')
    .map(c => c.campaign_id as string)

  // 56-day window: current 28d + prior 28d
  const windowStart_28d      = subtractDays(yesterday, 27)
  const priorWindowStart_28d = subtractDays(yesterday, 55)
  const priorWindowEnd_28d   = subtractDays(yesterday, 28)

  const dailyRows = await fetchAllPages<{
    date: string; cost_micros: unknown; impressions: unknown; clicks: unknown
  }>(
    (from, to) =>
      db.from('google_ads_campaign_daily')
        .select('date, cost_micros, impressions, clicks')
        .in('customer_id', customerIds)
        .gte('date', priorWindowStart_28d)
        .lte('date', yesterday)
        .range(from, to),
    'google_ads_driver_context',
  )

  // Aggregate current 28d and prior 28d
  let spend28d = 0, imp28d = 0, clicks28d = 0
  let spendPrior28d = 0, impPrior28d = 0, clicksPrior28d = 0
  let hasPrior = false

  // Build daily series
  const dailyMap = new Map<string, { spend: number; impressions: number; clicks: number }>()

  for (const r of dailyRows) {
    const date  = r.date as string
    const spend = Number(r.cost_micros ?? 0) / 1_000_000
    const imp   = Number(r.impressions ?? 0)
    const clk   = Number(r.clicks ?? 0)

    const entry = dailyMap.get(date) ?? { spend: 0, impressions: 0, clicks: 0 }
    entry.spend += spend
    entry.impressions += imp
    entry.clicks += clk
    dailyMap.set(date, entry)

    if (date >= windowStart_28d && date <= yesterday) {
      spend28d += spend; imp28d += imp; clicks28d += clk
    } else if (date >= priorWindowStart_28d && date <= priorWindowEnd_28d) {
      spendPrior28d += spend; impPrior28d += imp; clicksPrior28d += clk
      hasPrior = true
    }
  }

  const daily_series = Array.from(dailyMap.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Find last active date
  let last_active_date: string | null = null
  for (let i = daily_series.length - 1; i >= 0; i--) {
    if (daily_series[i].spend > 0) {
      last_active_date = daily_series[i].date
      break
    }
  }

  return {
    total_spend_28d:             Math.round(spend28d * 100) / 100,
    total_spend_prior_28d:       hasPrior ? Math.round(spendPrior28d * 100) / 100 : null,
    total_impressions_28d:       imp28d,
    total_impressions_prior_28d: hasPrior ? impPrior28d : null,
    total_clicks_28d:            clicks28d,
    total_clicks_prior_28d:      hasPrior ? clicksPrior28d : null,
    daily_series,
    last_active_date,
    enabled_count,
    paused_count,
    paused_campaign_ids,
  }
}

// ─── Meta paid 28d context ──────────────────────────────────────────────────

async function collectMetaPaidDriverContext(
  db: Db,
  yesterday: string,
): Promise<MetaPaidDriverContext | null> {
  const windowStart_28d      = subtractDays(yesterday, 27)
  const priorWindowStart_28d = subtractDays(yesterday, 55)
  const priorWindowEnd_28d   = subtractDays(yesterday, 28)

  const [{ data: currentRows }, { data: priorRows }] = await Promise.all([
    db.from('meta_campaign_insights')
      .select('clicks, spend')
      .gte('date_start', windowStart_28d)
      .lte('date_start', yesterday),
    db.from('meta_campaign_insights')
      .select('clicks, spend')
      .gte('date_start', priorWindowStart_28d)
      .lte('date_start', priorWindowEnd_28d),
  ])

  if (!currentRows || currentRows.length === 0) return null

  const sumField = (rows: typeof currentRows, key: 'clicks' | 'spend') =>
    rows.reduce((s, r) => s + (r[key] != null ? parseFloat(r[key] as string) : 0), 0)

  return {
    total_clicks_28d:       sumField(currentRows, 'clicks'),
    total_clicks_prior_28d: priorRows && priorRows.length > 0
      ? sumField(priorRows, 'clicks') : null,
    total_spend_28d:        Math.round(sumField(currentRows, 'spend') * 100) / 100,
    total_spend_prior_28d:  priorRows && priorRows.length > 0
      ? Math.round(sumField(priorRows, 'spend') * 100) / 100 : null,
  }
}

// ─── IG posting cadence ────────────────────────────────────────────────────

async function collectIgCadenceContext(
  db: Db,
  windowStart: string,
  yesterday: string,
): Promise<IgPostingCadenceContext> {
  const igAccountId = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID
  if (!igAccountId) {
    return { posts_current_7d: 0, posts_prior_7d: 0, exceptional_post_ids: [] }
  }

  const priorStart = subtractDays(windowStart, 7)
  const priorEnd   = subtractDays(windowStart, 1)

  const [{ count: currentCount }, { count: priorCount }] = await Promise.all([
    db.from('meta_ig_media')
      .select('id', { count: 'exact', head: true })
      .eq('ig_account_id', igAccountId)
      .gte('published_at', windowStart)
      .lte('published_at', yesterday + 'T23:59:59Z')
      .not('published_at', 'is', null),
    db.from('meta_ig_media')
      .select('id', { count: 'exact', head: true })
      .eq('ig_account_id', igAccountId)
      .gte('published_at', priorStart)
      .lte('published_at', priorEnd + 'T23:59:59Z')
      .not('published_at', 'is', null),
  ])

  // Exceptional posts: reach > 3× the average reach across all recent posts
  const { data: recentPosts } = await db
    .from('meta_ig_media')
    .select('id, reach')
    .eq('ig_account_id', igAccountId)
    .gte('published_at', windowStart)
    .lte('published_at', yesterday + 'T23:59:59Z')
    .not('published_at', 'is', null)
    .not('reach', 'is', null)

  const reaches = (recentPosts ?? [])
    .map(p => ({ id: p.id as string, reach: p.reach as number }))
    .filter(p => p.reach > 0)

  let exceptional_post_ids: string[] = []
  if (reaches.length >= 3) {
    const avgReach = reaches.reduce((s, p) => s + p.reach, 0) / reaches.length
    exceptional_post_ids = reaches
      .filter(p => p.reach >= avgReach * 3)
      .map(p => p.id)
  }

  return {
    posts_current_7d:    currentCount ?? 0,
    posts_prior_7d:      priorCount ?? 0,
    exceptional_post_ids,
  }
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function collectDriverContext(
  yesterday: string,
  windowStart: string,
): Promise<DriverContextData> {
  const db = createServiceClient()

  const [googleAds, metaPaid, igCadence] = await Promise.all([
    collectGoogleAdsDriverContext(db, yesterday),
    collectMetaPaidDriverContext(db, yesterday),
    collectIgCadenceContext(db, windowStart, yesterday),
  ])

  return { googleAds, metaPaid, igCadence }
}
