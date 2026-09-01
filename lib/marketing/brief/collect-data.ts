/**
 * lib/marketing/brief/collect-data.ts
 *
 * Deterministic data collection for the Marketing Morning Brief.
 *
 * NOT a server action. Called only from generate-brief.ts (the orchestrator)
 * which is itself called from the CRON endpoint and the SUPER_ADMIN action.
 * Auth is enforced at the calling layer.
 *
 * All DB access uses createServiceClient() — no getCurrentUser() here.
 * This is intentional: brief generation is institutional/background work,
 * not user-session work. The public Needs Review server action and this
 * internal aggregation are kept strictly separate (correction 5).
 *
 * What this module does:
 *   - Queries all Meta tables (paid + organic) for the data window
 *   - Computes 7d totals and deltas deterministically
 *   - Detects paid anomalies with volume guards (no generic CPA assumption)
 *   - Reads GBP integration status via the canonical OAuth-scope check
 *   - Reads internal Needs Review counts without calling any server action
 *   - Checks source freshness per integration with appropriate thresholds
 *   - Returns a compact BriefInputData struct ready for build-prompt.ts
 *
 * What this module does NOT do:
 *   - Call any AI API
 *   - Call any Meta/Google API (reads only from synced DB tables)
 *   - Accept any caller-supplied auth context
 *   - Fabricate metrics that are not actually present in the data
 */

import { createServiceClient } from '@/lib/supabase/server'
import { hasGbpScope } from '@/lib/google/auth'
import type {
  BriefInputData,
  CampaignMetrics,
  DeterministicSignals,
  FbPageMetrics,
  FbPostSummary,
  GbpBriefData,
  GbpIntegrationStatus,
  GbpIntegrationStatusKind,
  IgAccountMetrics,
  IgPostSummary,
  IntegrationFreshness,
  NeedsReviewCount,
  OverallStatus,
  PaidAnomalySignal,
  SourceFreshnessSummary,
  TrendPoint,
} from './types'

// ── Thresholds (explicit and testable) ────────────────────────────────────────
//
// All anomaly thresholds are here, not buried in logic. Easy to adjust and test.

/** Minimum daily spend (in account currency) required before flagging a metric anomaly.
 *  Prevents noisy alerts on tiny-budget days. */
export const ANOMALY_MIN_DAILY_SPEND = 50

/** Percentage change threshold to declare a paid metric anomaly (e.g. 0.30 = 30%). */
export const ANOMALY_PCT_THRESHOLD = 0.30

/** Hours since last success before a daily-sync integration is considered critically stale. */
export const CRITICAL_STALENESS_HOURS = 36

/** Hours since last success before a weekly deep-sync is considered stale. */
export const DEEP_SYNC_STALENESS_HOURS = 192  // 8 days (slightly above 7-day interval)

/** Percentage drop in IG week-over-week reach to flag as an organic anomaly (0.40 = 40%). */
export const ORGANIC_DROP_THRESHOLD = 0.40

/** Maximum number of IG posts to include in the brief. */
const MAX_IG_POSTS = 5

/** Maximum number of FB posts to include in the brief. */
const MAX_FB_POSTS = 5

/** Maximum caption/message length sent to AI (UNTRUSTED text — truncated for safety). */
const MAX_CAPTION_LENGTH = 80

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns today's date string in Europe/Copenhagen (YYYY-MM-DD). */
export function copenhagenToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' })
    .format(new Date())
}

/** Returns yesterday's date string in Europe/Copenhagen. */
export function copenhagenYesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(d)
}

/** Returns a date N days before a given YYYY-MM-DD string. */
function subtractDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

/** Hours between two ISO timestamps (or between a timestamp and now). */
function hoursAgo(isoTimestamp: string | null): number | null {
  if (!isoTimestamp) return null
  return (Date.now() - new Date(isoTimestamp).getTime()) / 3_600_000
}

// ── Text helpers ──────────────────────────────────────────────────────────────

/** Truncates external text to a safe display length. All Meta text is UNTRUSTED. */
function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null
  const trimmed = s.trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
}

// ── Freshness helpers ─────────────────────────────────────────────────────────

function makeFreshness(
  lastSuccessAt: string | null,
  status: string,
  maxAgeHours: number,
): IntegrationFreshness {
  const age = hoursAgo(lastSuccessAt)
  // 'synced' with recent success = healthy
  // 'syncing' with recent success = also OK (backfill in progress)
  // 'failed' OR too old = unhealthy
  const healthy =
    status !== 'failed' &&
    (age === null ? false : age < maxAgeHours)
  return { last_success_at: lastSuccessAt, status, age_hours: age, healthy }
}

// ── Source freshness ──────────────────────────────────────────────────────────

type Db = ReturnType<typeof createServiceClient>

async function collectSourceFreshness(db: Db): Promise<Omit<SourceFreshnessSummary, 'gbp'>> {
  const { data: rows } = await db
    .from('integration_sync_state')
    .select('integration, status, last_success_at')
    .in('integration', [
      'meta_ads_daily',
      'meta_ig_account_daily',
      'meta_ig_organic_deep',
      'meta_fb_page_daily',
      'meta_fb_organic_deep',
    ])
    .is('user_id', null)  // institutional rows only

  const byKey = Object.fromEntries(
    (rows ?? []).map((r) => [r.integration, r]),
  ) as Record<string, { status: string; last_success_at: string | null }>

  const get = (key: string) => byKey[key] ?? { status: 'never', last_success_at: null }

  return {
    meta_ads_daily:        makeFreshness(get('meta_ads_daily').last_success_at,        get('meta_ads_daily').status,        CRITICAL_STALENESS_HOURS),
    meta_ig_account_daily: makeFreshness(get('meta_ig_account_daily').last_success_at, get('meta_ig_account_daily').status, CRITICAL_STALENESS_HOURS),
    meta_ig_organic_deep:  makeFreshness(get('meta_ig_organic_deep').last_success_at,  get('meta_ig_organic_deep').status,  DEEP_SYNC_STALENESS_HOURS),
    meta_fb_page_daily:    makeFreshness(get('meta_fb_page_daily').last_success_at,    get('meta_fb_page_daily').status,    CRITICAL_STALENESS_HOURS),
    meta_fb_organic_deep:  makeFreshness(get('meta_fb_organic_deep').last_success_at,  get('meta_fb_organic_deep').status,  DEEP_SYNC_STALENESS_HOURS),
  }
}

// ── GBP integration status ────────────────────────────────────────────────────
//
// Canonical detection: check google_oauth_tokens for any user with GBP scope.
// This matches the existing pattern in lib/actions/marketing/gbp-reviews.ts
// (publishGbpReply also checks google_oauth_tokens for a GBP-scoped user).
// No live GBP API calls.

async function detectGbpIntegrationStatus(db: Db): Promise<GbpIntegrationStatus> {
  // Check if any user has a GBP-scoped OAuth token
  const { data: tokenRows } = await db
    .from('google_oauth_tokens')
    .select('user_id, scopes')

  const gbpUserId = tokenRows?.find(
    (row) => hasGbpScope((row.scopes as string[]) ?? [])
  )?.user_id as string | undefined

  if (!gbpUserId) {
    // No GBP-scoped OAuth credentials — API approval pending
    return { kind: 'pending_approval', last_sync_at: null, healthy: true }
  }

  // GBP OAuth credentials exist. Check if sync has ever succeeded.
  const { data: syncRows } = await db
    .from('integration_sync_state')
    .select('integration, last_success_at, status')
    .like('integration', 'gbp_%')
    .eq('user_id', gbpUserId)
    .order('last_success_at', { ascending: false })
    .limit(1)

  const lastSync = syncRows?.[0] ?? null

  const kind: GbpIntegrationStatusKind = lastSync?.last_success_at
    ? 'connected'
    : 'connected_no_sync'

  return {
    kind,
    last_sync_at: lastSync?.last_success_at ?? null,
    // connected_no_sync is only "unhealthy" if it's been a long time since OAuth was connected
    // For v1, treat connected_no_sync as healthy (sync may be in first run)
    healthy: true,
  }
}

// ── GBP review data ───────────────────────────────────────────────────────────

async function collectGbpData(db: Db, yesterday: string, gbpStatus: GbpIntegrationStatus): Promise<GbpBriefData> {
  if (gbpStatus.kind === 'pending_approval') {
    return {
      integration_status: gbpStatus,
      pending_reply_count: 0,
      new_reviews_yesterday: null,
      avg_star_rating_7d: null,
    }
  }

  // Count replies awaiting review
  const { count: pendingCount } = await db
    .from('gbp_review_replies')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'awaiting_review')

  // New reviews yesterday
  const { count: newYesterday } = await db
    .from('gbp_reviews')
    .select('id', { count: 'exact', head: true })
    .gte('review_created_at', yesterday + 'T00:00:00Z')
    .lt('review_created_at', yesterday + 'T23:59:59Z')

  // Average rating over last 7 days
  const sevenDaysAgo = subtractDays(yesterday, 6)
  const { data: recentReviews } = await db
    .from('gbp_reviews')
    .select('star_rating')
    .gte('review_created_at', sevenDaysAgo + 'T00:00:00Z')

  let avgRating: number | null = null
  if (recentReviews && recentReviews.length > 0) {
    const sum = recentReviews.reduce((acc, r) => acc + (r.star_rating as number), 0)
    avgRating = Math.round((sum / recentReviews.length) * 10) / 10
  }

  return {
    integration_status: gbpStatus,
    pending_reply_count: pendingCount ?? 0,
    new_reviews_yesterday: newYesterday ?? 0,
    avg_star_rating_7d: avgRating,
  }
}

// ── Internal Needs Review aggregation ─────────────────────────────────────────
//
// NOT a server action. Uses service client directly.
// This is the internal helper that both the Brief generator and (if needed)
// the public server action can use for aggregating review counts.
// The public server action in review-items.ts has its own auth and projection
// logic — this helper is count-only for Brief snapshot purposes.

export async function collectNeedsReviewCounts(db: Db): Promise<NeedsReviewCount> {
  const [{ count: reviewReplyCount }, { count: paidRecoCount }, { count: contentCount }] =
    await Promise.all([
      db.from('gbp_review_replies')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'awaiting_review'),
      // paid_recommendations table does not exist in v1 — returns 0
      // When M4 paid recommendation feature is added, replace this placeholder
      Promise.resolve({ count: 0 }),
      // content_approvals table does not exist until M5 — returns 0
      Promise.resolve({ count: 0 }),
    ])

  const review_reply       = reviewReplyCount ?? 0
  const paid_recommendation = paidRecoCount ?? 0
  const content_approval   = contentCount ?? 0

  return {
    total: review_reply + paid_recommendation + content_approval,
    review_reply,
    paid_recommendation,
    content_approval,
  }
}

// ── Paid data collection ───────────────────────────────────────────────────────

async function collectPaidData(
  db: Db,
  windowStart: string,
  yesterday: string,
): Promise<BriefInputData['paid']> {
  // Load campaigns
  const { data: campaigns } = await db
    .from('meta_ad_campaigns')
    .select('id, name, status, objective, daily_budget, lifetime_budget')
    .order('name')

  if (!campaigns || campaigns.length === 0) return null

  // Load 7d campaign insights (windowStart to yesterday)
  const { data: insights } = await db
    .from('meta_campaign_insights')
    .select(`
      campaign_id, date_start,
      impressions, reach, clicks, inline_link_clicks,
      spend, cpm, cpc, ctr, frequency,
      actions_json, cost_per_action_json
    `)
    .gte('date_start', windowStart)
    .lte('date_start', yesterday)
    .order('date_start')

  // Load prior 7d for comparison
  const priorWindowStart = subtractDays(windowStart, 7)
  const priorWindowEnd   = subtractDays(windowStart, 1)
  const { data: priorInsights } = await db
    .from('meta_campaign_insights')
    .select('campaign_id, date_start, spend, impressions, cpc, cpm, ctr')
    .gte('date_start', priorWindowStart)
    .lte('date_start', priorWindowEnd)
    .order('date_start')

  // Group insights by campaign
  const insightsByCampaign = new Map<string, typeof insights>()
  for (const row of insights ?? []) {
    const arr = insightsByCampaign.get(row.campaign_id as string) ?? []
    arr.push(row)
    insightsByCampaign.set(row.campaign_id as string, arr)
  }

  const priorByCampaign = new Map<string, typeof priorInsights>()
  for (const row of priorInsights ?? []) {
    const arr = priorByCampaign.get(row.campaign_id as string) ?? []
    arr.push(row)
    priorByCampaign.set(row.campaign_id as string, arr)
  }

  const active: CampaignMetrics[] = []
  const paused: CampaignMetrics[] = []

  for (const c of campaigns) {
    const rows = insightsByCampaign.get(c.id as string) ?? []
    const priorRows = priorByCampaign.get(c.id as string) ?? []

    // Aggregate 7d totals
    const spend_7d       = sumDecimalRows(rows, 'spend')
    const impressions_7d = sumIntRows(rows, 'impressions')
    const reach_7d       = sumIntRows(rows, 'reach')
    const clicks_7d      = sumIntRows(rows, 'clicks')

    // Averaged rate metrics (weighted would be ideal but simple avg is fine for v1)
    const ctr_7d = avgDecimalRows(rows, 'ctr')
    const cpm_7d = avgDecimalRows(rows, 'cpm')
    const cpc_7d = avgDecimalRows(rows, 'cpc')
    const freq_7d = avgDecimalRows(rows, 'frequency')

    // Yesterday's row
    const yesterdayRow = rows.find((r) => r.date_start === yesterday)
    const spend_yesterday = yesterdayRow?.spend != null ? parseFloat(yesterdayRow.spend as string) : null

    // Primary actions: aggregate from actions_json
    // Preserve actual action type names — never manufacture a single generic CPA
    const primaryActions = aggregatePrimaryActions(rows)

    // Anomaly detection with volume guard
    const anomaly = detectPaidAnomaly(
      c.name as string,
      rows,
      priorRows,
      yesterday,
    )

    const metrics: CampaignMetrics = {
      id:          c.id as string,
      name:        truncate(c.name as string, 60) ?? '',
      status:      c.status as string,
      objective:   c.objective as string | null,
      spend_7d,
      spend_yesterday,
      impressions_7d,
      reach_7d,
      clicks_7d,
      ctr_7d,
      cpm_7d,
      cpc_7d,
      frequency_7d: freq_7d,
      primary_actions: primaryActions,
      anomaly,
    }

    if (c.status === 'ACTIVE') active.push(metrics)
    else if (c.status === 'PAUSED') paused.push(metrics)
  }

  const total_active_spend_7d       = active.reduce((s, c) => s + (c.spend_7d ?? 0), 0) || null
  const total_active_impressions_7d = active.reduce((s, c) => s + (c.impressions_7d ?? 0), 0) || null

  // Build daily sparkline series for active campaigns only
  const activeIds = new Set(active.map((c) => c.id))
  const activeInsightRows = (insights ?? []).filter((r) => activeIds.has(r.campaign_id as string))

  const daily_spend_series = buildDailySeries(
    activeInsightRows.map((r) => ({
      date:  r.date_start as string,
      value: r.spend != null ? parseFloat(r.spend as string) : null,
    })),
  )
  const daily_impressions_series = buildDailySeries(
    activeInsightRows.map((r) => ({
      date:  r.date_start as string,
      value: r.impressions != null ? Number(r.impressions) : null,
    })),
  )

  return {
    active_campaigns:            active,
    paused_campaigns:            paused,
    total_active_spend_7d,
    total_active_impressions_7d,
    daily_spend_series,
    daily_impressions_series,
  }
}

// ── Paid anomaly detection ─────────────────────────────────────────────────────
//
// Compares yesterday's metrics to a baseline (prior 6 days, excluding yesterday).
// Only flags anomalies where:
//   1. Yesterday's daily spend exceeds ANOMALY_MIN_DAILY_SPEND (volume guard)
//   2. The percentage change exceeds ANOMALY_PCT_THRESHOLD
//
// Uses spend and CPC/CPM as the primary anomaly signals because these are
// universally available regardless of campaign objective.
// Never computes a generic CPA across incompatible objectives.

function detectPaidAnomaly(
  rawName: string,
  rows: Array<Record<string, unknown>>,
  _priorRows: Array<Record<string, unknown>>,
  yesterday: string,
): PaidAnomalySignal | null {
  const yesterdayRow = rows.find((r) => r.date_start === yesterday)
  if (!yesterdayRow) return null

  const ySpend = yesterdayRow.spend != null ? parseFloat(yesterdayRow.spend as string) : 0

  // Volume guard: don't flag anomalies on tiny spend days
  if (ySpend < ANOMALY_MIN_DAILY_SPEND) return null

  // Baseline: last 6 days excluding yesterday
  const baselineRows = rows.filter((r) => r.date_start !== yesterday)
  if (baselineRows.length < 3) return null  // insufficient baseline data

  // Check CPC anomaly (most universally meaningful across objectives)
  const yCpc = yesterdayRow.cpc != null ? parseFloat(yesterdayRow.cpc as string) : null
  const baselineCpc = avgDecimalRows(baselineRows, 'cpc')

  if (yCpc != null && baselineCpc != null && baselineCpc > 0) {
    const changePct = (yCpc - baselineCpc) / baselineCpc
    if (Math.abs(changePct) >= ANOMALY_PCT_THRESHOLD) {
      return {
        campaign_name:   truncate(rawName, 50) ?? rawName.slice(0, 50),
        metric_label:    'cpc',
        change_pct:      Math.round(changePct * 1000) / 10,  // e.g. 28.5
        direction:       changePct > 0 ? 'increase' : 'decrease',
        yesterday_value: Math.round(yCpc * 100) / 100,
        baseline_value:  Math.round(baselineCpc * 100) / 100,
      }
    }
  }

  // Check CPM anomaly as secondary signal
  const yCpm = yesterdayRow.cpm != null ? parseFloat(yesterdayRow.cpm as string) : null
  const baselineCpm = avgDecimalRows(baselineRows, 'cpm')

  if (yCpm != null && baselineCpm != null && baselineCpm > 0) {
    const changePct = (yCpm - baselineCpm) / baselineCpm
    if (Math.abs(changePct) >= ANOMALY_PCT_THRESHOLD) {
      return {
        campaign_name:   truncate(rawName, 50) ?? rawName.slice(0, 50),
        metric_label:    'cpm',
        change_pct:      Math.round(changePct * 1000) / 10,
        direction:       changePct > 0 ? 'increase' : 'decrease',
        yesterday_value: Math.round(yCpm * 100) / 100,
        baseline_value:  Math.round(baselineCpm * 100) / 100,
      }
    }
  }

  return null
}

// ── Action aggregation ────────────────────────────────────────────────────────
//
// Preserves actual Meta action type names from actions_json.
// Each campaign may have different primary action types depending on objective.
// We aggregate totals per type across the 7d window and pair with cost-per-action.
// We do NOT manufacture a single CPA across different action types.

interface MetaActionItem { action_type: string; value: string }

function aggregatePrimaryActions(
  rows: Array<Record<string, unknown>>,
): CampaignMetrics['primary_actions'] {
  // Accumulate action totals per type
  const valueTotals = new Map<string, number>()
  const costTotals  = new Map<string, number>()

  for (const row of rows) {
    const actions   = row.actions_json         as MetaActionItem[] | null
    const costs     = row.cost_per_action_json as MetaActionItem[] | null

    for (const a of actions ?? []) {
      valueTotals.set(a.action_type, (valueTotals.get(a.action_type) ?? 0) + parseFloat(a.value))
    }
    for (const c of costs ?? []) {
      // cost_per_action is per-day so we take a simple sum and will re-average later
      costTotals.set(c.action_type, (costTotals.get(c.action_type) ?? 0) + parseFloat(c.value))
    }
  }

  const nDays = rows.length || 1

  // Return up to 3 most significant action types (by total value)
  return Array.from(valueTotals.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([type, total]) => ({
      type,
      value_7d: Math.round(total),
      cost_7d:  costTotals.has(type)
        ? Math.round((costTotals.get(type)! / nDays) * 100) / 100  // average cost per action over window
        : null,
    }))
}

// ── Instagram data ────────────────────────────────────────────────────────────

async function collectIgData(
  db: Db,
  windowStart: string,
  yesterday: string,
): Promise<{ account: IgAccountMetrics; topPosts: IgPostSummary[]; avgReach7d: number | null; dailyReachSeries: TrendPoint[] }> {
  const igAccountId = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID

  // Account daily metrics — 7d window
  const { data: dailyRows } = igAccountId
    ? await db.from('meta_ig_account_daily')
        .select('date, reach, accounts_engaged, profile_views, followers_count')
        .eq('ig_account_id', igAccountId)
        .gte('date', windowStart)
        .lte('date', yesterday)
        .order('date')
    : { data: [] }

  // Prior 7d for comparison
  const priorStart = subtractDays(windowStart, 7)
  const priorEnd   = subtractDays(windowStart, 1)
  const { data: priorDailyRows } = igAccountId
    ? await db.from('meta_ig_account_daily')
        .select('date, reach')
        .eq('ig_account_id', igAccountId)
        .gte('date', priorStart)
        .lte('date', priorEnd)
    : { data: [] }

  const reach_7d       = sumIntRows(dailyRows ?? [], 'reach')
  const reach_prior_7d = sumIntRows(priorDailyRows ?? [], 'reach')
  const engaged_7d     = sumIntRows(dailyRows ?? [], 'accounts_engaged')
  const profile_views  = sumIntRows(dailyRows ?? [], 'profile_views')

  // Followers: use the most recent day's count
  const sortedDaily = (dailyRows ?? []).sort((a, b) =>
    (b.date as string).localeCompare(a.date as string)
  )
  const followersNow   = sortedDaily[0]?.followers_count as number | null ?? null
  const followersOldest = sortedDaily[sortedDaily.length - 1]?.followers_count as number | null ?? null
  const followersDelta = followersNow != null && followersOldest != null
    ? followersNow - followersOldest
    : null

  // IG media posts — up to 20 most recent for ranking
  const { data: mediaRows } = igAccountId
    ? await db.from('meta_ig_media')
        .select('id, caption, published_at, media_type, reach, plays, likes, comments_count, shares, total_interactions')
        .eq('ig_account_id', igAccountId)
        .gte('published_at', windowStart)
        .lte('published_at', yesterday + 'T23:59:59Z')
        .not('published_at', 'is', null)
        .order('published_at', { ascending: false })
        .limit(20)
    : { data: [] }

  // Compute average reach for context (used in performance_vs_avg_pct)
  const reachValues = (mediaRows ?? [])
    .map((r) => r.reach as number | null)
    .filter((v): v is number => v != null)
  const avgReach7d = reachValues.length > 0
    ? reachValues.reduce((s, v) => s + v, 0) / reachValues.length
    : null

  // Rank by reach (or total_interactions as fallback), return top N
  const sortedMedia = (mediaRows ?? []).sort((a, b) =>
    ((b.reach as number | null) ?? 0) - ((a.reach as number | null) ?? 0)
  )

  const topPosts: IgPostSummary[] = sortedMedia.slice(0, MAX_IG_POSTS).map((m) => {
    const reach = m.reach as number | null
    const perfPct = reach != null && avgReach7d != null && avgReach7d > 0
      ? Math.round(((reach - avgReach7d) / avgReach7d) * 100)
      : null
    return {
      caption_truncated:       truncate(m.caption as string | null, MAX_CAPTION_LENGTH),
      published_at:            m.published_at as string,
      media_type:              m.media_type as string,
      reach,
      plays:                   m.plays as number | null,
      likes:                   m.likes as number | null,
      comments_count:          m.comments_count as number | null,
      shares:                  m.shares as number | null,
      total_interactions:      m.total_interactions as number | null,
      performance_vs_avg_pct:  perfPct,
    }
  })

  const dailyReachSeries = buildDailySeries(
    (dailyRows ?? []).map((r) => ({
      date:  r.date as string,
      value: r.reach != null ? Number(r.reach) : null,
    })),
  )

  return {
    account: {
      reach_7d,
      reach_prior_7d,
      accounts_engaged_7d: engaged_7d,
      profile_views_7d:    profile_views,
      followers_current:   followersNow,
      followers_7d_delta:  followersDelta,
    },
    topPosts,
    avgReach7d,
    dailyReachSeries,
  }
}

// ── Facebook page data ─────────────────────────────────────────────────────────
//
// Uses only v26-available metrics:
//   - page_views_total (stored as 'views' in meta_fb_page_insights)
//   - page_post_engagements (stored as 'engaged_users')
//   - fan_count
//
// Facebook post-level: reactions_total and clicks ONLY.
// Post-level reach/views/engaged_users are deprecated/unavailable in v26.

async function collectFbData(
  db: Db,
  windowStart: string,
  yesterday: string,
): Promise<{ page: FbPageMetrics; recentPosts: FbPostSummary[]; available: boolean; dailyViewsSeries: TrendPoint[] }> {
  const pageId = process.env.META_FACEBOOK_PAGE_ID
  if (!pageId) {
    return {
      page: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
      recentPosts: [],
      available: false,
      dailyViewsSeries: [],
    }
  }

  // Page-level daily metrics
  const { data: pageRows } = await db
    .from('meta_fb_page_insights')
    .select('date, views, engaged_users, fan_count')
    .eq('page_id', pageId)
    .gte('date', windowStart)
    .lte('date', yesterday)
    .order('date', { ascending: false })

  const views_7d        = sumIntRows(pageRows ?? [], 'views')
  const engaged_7d      = sumIntRows(pageRows ?? [], 'engaged_users')
  const sortedPageRows  = (pageRows ?? []).sort((a, b) => (b.date as string).localeCompare(a.date as string))
  const fanNow          = sortedPageRows[0]?.fan_count as number | null ?? null
  const fanOldest       = sortedPageRows[sortedPageRows.length - 1]?.fan_count as number | null ?? null
  const fanDelta        = fanNow != null && fanOldest != null ? fanNow - fanOldest : null

  // Recent FB posts — join with insights for reactions/clicks only
  const { data: postRows } = await db
    .from('meta_fb_posts')
    .select(`
      id, message, published_at, post_type,
      insights:meta_fb_post_insights(reactions_total, clicks, comments, shares)
    `)
    .eq('page_id', pageId)
    .gte('published_at', windowStart)
    .lte('published_at', yesterday + 'T23:59:59Z')
    .order('published_at', { ascending: false })
    .limit(MAX_FB_POSTS)

  const recentPosts: FbPostSummary[] = (postRows ?? []).map((p) => {
    const ins = Array.isArray(p.insights) ? p.insights[0] : p.insights
    return {
      message_truncated: truncate(p.message as string | null, MAX_CAPTION_LENGTH),
      published_at:      p.published_at as string,
      post_type:         p.post_type as string,
      reactions_total:   ins?.reactions_total as number | null ?? null,
      clicks:            ins?.clicks as number | null ?? null,
      comments:          ins?.comments as number | null ?? null,
      shares:            ins?.shares as number | null ?? null,
    }
  })

  const dailyViewsSeries = buildDailySeries(
    (pageRows ?? []).map((r) => ({
      date:  r.date as string,
      value: r.views != null ? Number(r.views) : null,
    })),
  )

  return {
    page: { views_7d, engaged_users_7d: engaged_7d, fan_count_current: fanNow, fan_count_7d_delta: fanDelta },
    recentPosts,
    available: true,
    dailyViewsSeries,
  }
}

// ── Deterministic signals ─────────────────────────────────────────────────────

function computeSignals(
  freshness: SourceFreshnessSummary,
  paid: BriefInputData['paid'],
  igAccount: IgAccountMetrics,
  needsReview: NeedsReviewCount,
): DeterministicSignals {
  // 1. Stale critical source check
  const staleSources: string[] = []
  if (!freshness.meta_ads_daily.healthy)        staleSources.push('meta_ads_daily')
  if (!freshness.meta_ig_account_daily.healthy) staleSources.push('meta_ig_account_daily')
  // meta_ads_backfill 'syncing' status is NORMAL — excluded from stale check
  // meta_*_organic_deep are weekly — use their own (more lenient) threshold

  const has_stale_critical_source = staleSources.length > 0

  // 2. Paid anomalies (across all active campaigns)
  const paidAnomalies: PaidAnomalySignal[] = []
  for (const c of paid?.active_campaigns ?? []) {
    if (c.anomaly) paidAnomalies.push(c.anomaly)
  }

  // 3. Organic IG anomaly: week-over-week reach drop
  const igReach7d = igAccount.reach_7d ?? 0
  const igReachPrior = igAccount.reach_prior_7d ?? 0
  let organic_ig_drop_detected = false
  let organic_ig_reach_pct: number | null = null

  if (igReachPrior > 0) {
    const changePct = (igReach7d - igReachPrior) / igReachPrior
    organic_ig_reach_pct = Math.round(changePct * 1000) / 10  // e.g. -42.5
    organic_ig_drop_detected = changePct < -ORGANIC_DROP_THRESHOLD
  }

  // 4. Compute overall status
  const status_reasons: string[] = []
  let computed_status: OverallStatus = 'green'

  if (has_stale_critical_source) {
    computed_status = 'red'
    staleSources.forEach((s) => status_reasons.push(`stale_source:${s}`))
  } else if (paidAnomalies.length > 0) {
    computed_status = 'amber'
    paidAnomalies.forEach((a) => status_reasons.push(`paid_anomaly:${a.campaign_name}:${a.metric_label}`))
  } else if (organic_ig_drop_detected) {
    computed_status = 'amber'
    status_reasons.push('organic_ig_drop')
  }
  // pending_review_count does not elevate status — it is surfaced in the brief regardless

  return {
    has_stale_critical_source,
    stale_sources: staleSources,
    paid_anomaly_count: paidAnomalies.length,
    paid_anomalies: paidAnomalies,
    organic_ig_drop_detected,
    organic_ig_reach_7d_vs_prior_7d_pct: organic_ig_reach_pct,
    pending_review_count: needsReview.total,
    gbp_kind: freshness.gbp.kind,
    computed_status,
    status_reasons,
  }
}

// ── Numeric helpers ───────────────────────────────────────────────────────────

function sumDecimalRows(rows: Array<Record<string, unknown>>, key: string): number | null {
  const vals = rows.map((r) => r[key] != null ? parseFloat(r[key] as string) : null).filter((v): v is number => v != null)
  return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) * 100) / 100 : null
}

function sumIntRows(rows: Array<Record<string, unknown>>, key: string): number | null {
  const vals = rows.map((r) => r[key] != null ? Number(r[key]) : null).filter((v): v is number => v != null && !isNaN(v))
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) : null
}

function avgDecimalRows(rows: Array<Record<string, unknown>>, key: string): number | null {
  const vals = rows.map((r) => r[key] != null ? parseFloat(r[key] as string) : null).filter((v): v is number => v != null)
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null
}

// ── Sparkline series builder ───────────────────────────────────────────────────
//
// Groups rows by date, sums values per date (to merge multiple campaigns),
// then sorts chronologically. Null/undefined values are skipped (not treated as zero).
// Zero is a valid value and IS included. Exported for unit testing.

export function buildDailySeries(
  rows: ReadonlyArray<{ date: string; value: number | null | undefined }>,
): TrendPoint[] {
  const byDate = new Map<string, number>()
  for (const row of rows) {
    if (row.value == null) continue
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.value)
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }))
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Collects and pre-computes all data needed for the Morning Brief.
 * Does not call any AI API.
 * Does not accept any caller-supplied auth context.
 *
 * @param briefDate - YYYY-MM-DD in Europe/Copenhagen
 */
export async function collectBriefData(briefDate: string): Promise<BriefInputData> {
  const db = createServiceClient()

  const yesterday      = subtractDays(briefDate, 1)
  const windowStart    = subtractDays(yesterday, 6)   // 7 days: windowStart..yesterday inclusive

  // Fetch account currency
  const { data: accountRows } = await db.from('meta_ad_accounts').select('currency').limit(1)
  const currency = (accountRows?.[0]?.currency as string | undefined) ?? 'DKK'

  // Run all independent data fetches in parallel
  const [
    freshnessPartial,
    gbpIntegrationStatus,
    paidData,
    igData,
    fbData,
    needsReview,
  ] = await Promise.all([
    collectSourceFreshness(db),
    detectGbpIntegrationStatus(db),
    collectPaidData(db, windowStart, yesterday),
    collectIgData(db, windowStart, yesterday),
    collectFbData(db, windowStart, yesterday),
    collectNeedsReviewCounts(db),
  ])

  // GBP data depends on integration status (sequential, fast)
  const gbpData = await collectGbpData(db, yesterday, gbpIntegrationStatus)

  const sourceFreshness: SourceFreshnessSummary = {
    ...freshnessPartial,
    gbp: gbpIntegrationStatus,
  }

  const signals = computeSignals(sourceFreshness, paidData, igData.account, needsReview)

  return {
    briefDate,
    dataWindowStart: windowStart,
    dataWindowEnd:   yesterday,
    currency,
    sourceFreshness,
    signals,
    paid: paidData,
    organic: {
      ig:                   igData.account,
      ig_top_posts:         igData.topPosts,
      ig_avg_reach_7d:      igData.avgReach7d,
      ig_daily_reach_series: igData.dailyReachSeries,
      fb:                   fbData.page,
      fb_recent_posts:      fbData.recentPosts,
      fb_available:         fbData.available,
      fb_daily_views_series: fbData.dailyViewsSeries,
    },
    gbp: gbpData,
    needsReview,
  }
}
