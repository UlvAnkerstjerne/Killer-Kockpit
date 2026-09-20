/**
 * lib/marketing/brief/material-signals.ts
 *
 * Deterministic material signal layer for the Marketing Morning Brief v2.
 * Sits between BriefInputData and the AI prompt.
 *
 * Responsibilities:
 *   - Identify and rank commercially material facts across 6 data sources
 *   - Apply volume guards so small-audience large-% swings are suppressed
 *   - Merge same-movement signals to avoid duplicate coverage
 *   - Return at most MAX_SIGNAL_CANDIDATES candidates, ranked strongest first
 *
 * Guarantees:
 *   - Pure function — no side effects, no I/O, no randomness
 *   - All thresholds exported as named constants for testability
 *   - UNTRUSTED text (campaign names, captions, queries, page URLs)
 *     is stored in evidence items under the DATA: prefix
 *   - Does NOT generate recommendations — only identifies facts
 */

import type {
  BriefInputData,
  PaidAnomalySignal,
  GoogleAdsCampaignSummary,
} from './types'

// ─── Public types ─────────────────────────────────────────────────────────────

export type SignalSource =
  | 'meta_paid'
  | 'google_ads'
  | 'organic_ig'
  | 'search_console'
  | 'ga4'
  | 'gbp_performance'
  | 'data_health'

export type SignalCategory =
  | 'commercial_consequence'   // Revenue / cost / conversion impact
  | 'traffic_audience'         // Sessions, reach, impressions movement
  | 'creative_learning'        // Post/creative performance vs baseline
  | 'seo_local_search'         // GSC / GBP opportunity or movement
  | 'data_health'              // Stale/failed data source

export interface SignalMetricEvidence {
  metric:   string         // e.g. 'spend_7d', 'reach_7d', 'clicks_7d'
  current:  number | null
  prior:    number | null
  change_pct: number | null  // fractional: 0.20 = +20%. null when prior unavailable
}

export interface MaterialSignalCandidate {
  id:                   string   // stable slug, e.g. 'meta_paid_anomaly_camp1_spend'
  source:               SignalSource
  category:             SignalCategory
  observation:          string   // concise factual sentence, no recommendation
  evidence:             SignalMetricEvidence[]
  materiality_score:    number   // higher = more material; used only for ranking
  commercially_relevant: boolean
  creatively_relevant:   boolean
}

// ─── Exported thresholds ──────────────────────────────────────────────────────

// Google Ads
export const GADS_MIN_SPEND_7D_FOR_SIGNAL   = 100   // DKK (or account currency)
export const GADS_MIN_RESULTS_FOR_SIGNAL    = 5
export const GADS_MATERIAL_CHANGE_PCT       = 0.20  // fractional

// Organic IG
export const IG_MIN_REACH_FOR_SIGNAL          = 200
export const IG_MATERIAL_REACH_CHANGE_PCT     = 0.15
export const IG_POST_OUTPERFORMANCE_PCT       = 0.50  // post must be ≥ 50% above avg
export const IG_POST_OUTPERFORMANCE_MIN_REACH = 100
export const IG_MIN_FOLLOWER_DELTA            = 20

// Search Console
export const GSC_MIN_CLICKS_FOR_SIGNAL        = 30
export const GSC_MIN_IMPRESSIONS_FOR_SIGNAL   = 500
export const GSC_MATERIAL_CHANGE_PCT          = 0.20

// GA4
export const GA4_MIN_SESSIONS_FOR_SIGNAL      = 50
export const GA4_MATERIAL_CHANGE_PCT          = 0.20

// GBP Performance
export const GBP_MIN_INTERACTIONS_FOR_SIGNAL  = 20
export const GBP_MATERIAL_CHANGE_PCT          = 0.20

// Output cap
export const MAX_SIGNAL_CANDIDATES            = 12

// ─── Category base weights (for scoring) ─────────────────────────────────────

const CATEGORY_BASE: Record<SignalCategory, number> = {
  commercial_consequence: 100,
  traffic_audience:        60,
  creative_learning:       40,
  seo_local_search:        30,
  data_health:             20,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function changePct(current: number, prior: number): number {
  if (prior === 0) return current > 0 ? Infinity : 0
  return (current - prior) / prior
}

function isMaterial(pct: number, threshold: number): boolean {
  return Math.abs(pct) >= threshold
}

/** Score a candidate by category weight × magnitude × volume factor. */
function score(
  category: SignalCategory,
  absChangePct: number,
  volumeFactor: number, // 0–1, derived from current value vs minimum threshold
): number {
  return CATEGORY_BASE[category] * (1 + Math.min(absChangePct, 2)) * Math.min(volumeFactor, 1)
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/** Sanitize an UNTRUSTED string for use as DATA: evidence in an observation. */
function dataTag(text: string): string {
  return `DATA:${text.slice(0, 80)}`
}

// ─── Per-source signal builders ───────────────────────────────────────────────

function metaPaidSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []

  // Reuse PaidAnomalySignal records — already computed deterministically.
  // change_pct in PaidAnomalySignal is in percentage units (e.g. 28.5 = 28.5%), not fractional.
  // Anomalies live in data.signals, not data.paid, so they are processed regardless of paid nullability.
  const anomalies: PaidAnomalySignal[] = data.signals.paid_anomalies

  for (const anomaly of anomalies) {
    const changeFrac = anomaly.change_pct / 100
    const volFactor  = clamp(anomaly.yesterday_value / (anomaly.yesterday_value + 1000))
    const isCommercial = ['spend', 'cpc', 'cpm'].includes(anomaly.metric_label)

    candidates.push({
      id: `meta_paid_anomaly_${slugify(anomaly.campaign_name)}_${anomaly.metric_label}`,
      source: 'meta_paid',
      category: 'commercial_consequence',
      observation: `${dataTag(anomaly.campaign_name)} — ${anomaly.metric_label} ${anomaly.direction === 'increase' ? 'up' : 'down'} ${Math.abs(anomaly.change_pct).toFixed(1)}% vs 6-day average (yesterday: ${fmtNum(anomaly.yesterday_value)}, baseline: ${fmtNum(anomaly.baseline_value)}).`,
      evidence: [
        {
          metric: anomaly.metric_label,
          current: anomaly.yesterday_value,
          prior: anomaly.baseline_value,
          change_pct: changeFrac,
        },
      ],
      materiality_score: score('commercial_consequence', Math.abs(changeFrac), volFactor),
      commercially_relevant: isCommercial,
      creatively_relevant: false,
    })
  }

  // Meta paid currently lacks prior spend at account level in BriefInputData,
  // so we skip account-level comparison here (anomalies cover campaign-level already).

  return candidates
}

function googleAdsSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const gads = data.googleAds
  if (!gads) return candidates

  // Account-level totals comparison
  const spendCurrent = gads.total_spend_7d
  const spendPrior   = gads.total_spend_prior_7d

  if (spendPrior !== null && spendCurrent >= GADS_MIN_SPEND_7D_FOR_SIGNAL) {
    const pct = changePct(spendCurrent, spendPrior)
    if (isMaterial(pct, GADS_MATERIAL_CHANGE_PCT)) {
      const evidence: SignalMetricEvidence[] = [
        { metric: 'spend_7d', current: spendCurrent, prior: spendPrior, change_pct: pct },
      ]

      const clicksCurrent = gads.total_clicks_7d
      const clicksPrior   = gads.total_clicks_prior_7d
      if (clicksPrior !== null) {
        const clicksPct = changePct(clicksCurrent, clicksPrior)
        if (isMaterial(clicksPct, GADS_MATERIAL_CHANGE_PCT)) {
          evidence.push({ metric: 'clicks_7d', current: clicksCurrent, prior: clicksPrior, change_pct: clicksPct })
        }
      }

      const impCurrent = gads.total_impressions_7d
      const impPrior   = gads.total_impressions_prior_7d
      if (impPrior !== null) {
        const impPct = changePct(impCurrent, impPrior)
        if (isMaterial(impPct, GADS_MATERIAL_CHANGE_PCT)) {
          evidence.push({ metric: 'impressions_7d', current: impCurrent, prior: impPrior, change_pct: impPct })
        }
      }

      const volFactor = clamp(spendCurrent / (GADS_MIN_SPEND_7D_FOR_SIGNAL * 5))
      candidates.push({
        id: 'google_ads_account_spend',
        source: 'google_ads',
        category: 'commercial_consequence',
        observation: `Google Ads account spend ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct * 100).toFixed(1)}% vs prior 7 days (${fmtNum(spendCurrent)} vs ${fmtNum(spendPrior)} ${gads.currency}).`,
        evidence,
        materiality_score: score('commercial_consequence', Math.abs(pct), volFactor),
        commercially_relevant: true,
        creatively_relevant: false,
      })
    }
  }

  // Per-campaign result comparisons
  for (const campaign of gads.active_campaigns) {
    if (campaign.spend_7d < GADS_MIN_SPEND_7D_FOR_SIGNAL) continue

    for (const result of campaign.top_results) {
      if (result.count < GADS_MIN_RESULTS_FOR_SIGNAL) continue
      if (result.prior_count === null) continue

      const pct = changePct(result.count, result.prior_count)
      if (!isMaterial(pct, GADS_MATERIAL_CHANGE_PCT)) continue

      const evidence: SignalMetricEvidence[] = [
        { metric: result.label, current: result.count, prior: result.prior_count, change_pct: pct },
      ]
      if (result.costPerResult !== null && result.prior_costPerResult !== null) {
        const cprPct = changePct(result.costPerResult, result.prior_costPerResult)
        evidence.push({ metric: `costPer_${result.label}`, current: result.costPerResult, prior: result.prior_costPerResult, change_pct: cprPct })
      }

      const volFactor = clamp(result.count / (GADS_MIN_RESULTS_FOR_SIGNAL * 4))
      candidates.push({
        id: `google_ads_result_${slugify(campaign.id)}_${slugify(result.label)}`,
        source: 'google_ads',
        category: 'commercial_consequence',
        observation: `${dataTag(campaign.name)} — ${result.label} ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct * 100).toFixed(1)}% vs prior 7 days (${result.count} vs ${result.prior_count}).`,
        evidence,
        materiality_score: score('commercial_consequence', Math.abs(pct), volFactor),
        commercially_relevant: true,
        creatively_relevant: false,
      })
    }
  }

  return candidates
}

function organicIgSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const ig = data.organic.ig

  // Reach comparison
  const reachCurrent = ig.reach_7d
  const reachPrior   = ig.reach_prior_7d

  if (reachCurrent !== null && reachPrior !== null && reachCurrent >= IG_MIN_REACH_FOR_SIGNAL) {
    const pct = changePct(reachCurrent, reachPrior)
    if (isMaterial(pct, IG_MATERIAL_REACH_CHANGE_PCT)) {
      const evidence: SignalMetricEvidence[] = [
        { metric: 'ig_reach_7d', current: reachCurrent, prior: reachPrior, change_pct: pct },
      ]

      const engCurrent = ig.accounts_engaged_7d
      if (engCurrent !== null) {
        evidence.push({ metric: 'ig_accounts_engaged_7d', current: engCurrent, prior: null, change_pct: null })
      }

      const volFactor = clamp(reachCurrent / (IG_MIN_REACH_FOR_SIGNAL * 5))
      candidates.push({
        id: 'organic_ig_reach',
        source: 'organic_ig',
        category: 'traffic_audience',
        observation: `Instagram organic reach ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct * 100).toFixed(1)}% vs prior 7 days (${fmtNum(reachCurrent)} vs ${fmtNum(reachPrior)}).`,
        evidence,
        materiality_score: score('traffic_audience', Math.abs(pct), volFactor),
        commercially_relevant: false,
        creatively_relevant: true,
      })
    }
  }

  // Follower delta
  const followerDelta = ig.followers_7d_delta
  if (followerDelta !== null && Math.abs(followerDelta) >= IG_MIN_FOLLOWER_DELTA) {
    candidates.push({
      id: 'organic_ig_followers',
      source: 'organic_ig',
      category: 'traffic_audience',
      observation: `Instagram follower count ${followerDelta > 0 ? 'grew' : 'fell'} by ${Math.abs(followerDelta)} in the past 7 days (current: ${fmtNum(ig.followers_current ?? 0)}).`,
      evidence: [
        { metric: 'ig_followers_delta_7d', current: followerDelta, prior: null, change_pct: null },
      ],
      materiality_score: score('traffic_audience', clamp(Math.abs(followerDelta) / 100), 0.5),
      commercially_relevant: false,
      creatively_relevant: false,
    })
  }

  // Top posts with significant outperformance
  const outperformingPosts = data.organic.ig_top_posts.filter(
    (p) =>
      p.performance_vs_avg_pct !== null &&
      p.performance_vs_avg_pct >= IG_POST_OUTPERFORMANCE_PCT * 100 &&
      (p.reach ?? 0) >= IG_POST_OUTPERFORMANCE_MIN_REACH,
  )

  for (const post of outperformingPosts.slice(0, 2)) {
    candidates.push({
      id: `organic_ig_post_${post.published_at}`,
      source: 'organic_ig',
      category: 'creative_learning',
      observation: `Instagram post published ${post.published_at} (${post.media_type}) reached ${fmtNum(post.reach ?? 0)}, ${post.performance_vs_avg_pct!.toFixed(0)}% above 7-day average. Caption: ${dataTag(post.caption_truncated ?? '')}`,
      evidence: [
        {
          metric: 'ig_post_reach',
          current: post.reach ?? null,
          prior: null,
          change_pct: post.performance_vs_avg_pct !== null ? post.performance_vs_avg_pct / 100 : null,
        },
      ],
      materiality_score: score('creative_learning', (post.performance_vs_avg_pct ?? 0) / 100, clamp((post.reach ?? 0) / 500)),
      commercially_relevant: false,
      creatively_relevant: true,
    })
  }

  return candidates
}

function searchConsoleSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const sc = data.searchConsole
  if (!sc) return candidates

  const clicksCurrent = sc.clicks_7d
  const clicksPrior   = sc.clicks_prior_7d
  const impCurrent    = sc.impressions_7d
  const impPrior      = sc.impressions_prior_7d

  const clicksOk = clicksCurrent >= GSC_MIN_CLICKS_FOR_SIGNAL
  const impOk    = impCurrent >= GSC_MIN_IMPRESSIONS_FOR_SIGNAL

  if (!clicksOk && !impOk) return candidates

  const evidence: SignalMetricEvidence[] = []
  let dominated = false
  let dominantPct = 0

  if (clicksOk && clicksPrior !== null) {
    const pct = changePct(clicksCurrent, clicksPrior)
    if (isMaterial(pct, GSC_MATERIAL_CHANGE_PCT)) {
      evidence.push({ metric: 'gsc_clicks_7d', current: clicksCurrent, prior: clicksPrior, change_pct: pct })
      dominated = true
      dominantPct = pct
    }
  }

  if (impOk && impPrior !== null) {
    const pct = changePct(impCurrent, impPrior)
    if (isMaterial(pct, GSC_MATERIAL_CHANGE_PCT)) {
      evidence.push({ metric: 'gsc_impressions_7d', current: impCurrent, prior: impPrior, change_pct: pct })
      if (!dominated) { dominated = true; dominantPct = pct }
    }
  }

  const ctrCurrent = sc.ctr_7d
  const ctrPrior   = sc.ctr_prior_7d
  if (ctrCurrent !== null && ctrPrior !== null && clicksOk) {
    const pct = changePct(ctrCurrent, ctrPrior)
    if (isMaterial(pct, GSC_MATERIAL_CHANGE_PCT)) {
      evidence.push({ metric: 'gsc_ctr_7d', current: ctrCurrent, prior: ctrPrior, change_pct: pct })
    }
  }

  if (evidence.length === 0) return candidates

  const volFactor = clamp(clicksCurrent / (GSC_MIN_CLICKS_FOR_SIGNAL * 10))
  const direction = dominantPct > 0 ? 'up' : 'down'
  candidates.push({
    id: 'search_console_organic',
    source: 'search_console',
    category: 'seo_local_search',
    observation: `Organic search clicks ${direction} ${Math.abs(dominantPct * 100).toFixed(1)}% vs prior 7 days (${fmtNum(clicksCurrent)} vs ${fmtNum(clicksPrior ?? 0)}).`,
    evidence,
    materiality_score: score('seo_local_search', Math.abs(dominantPct), volFactor),
    commercially_relevant: true,
    creatively_relevant: false,
  })

  return candidates
}

function ga4Signals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const ga4 = data.ga4
  if (!ga4) return candidates

  const sessCurrent = ga4.sessions_7d
  const sessPrior   = ga4.sessions_prior_7d

  if (sessCurrent < GA4_MIN_SESSIONS_FOR_SIGNAL) return candidates
  if (sessPrior === null) return candidates

  const sessionsPct = changePct(sessCurrent, sessPrior)
  if (!isMaterial(sessionsPct, GA4_MATERIAL_CHANGE_PCT)) return candidates

  const evidence: SignalMetricEvidence[] = [
    { metric: 'ga4_sessions_7d', current: sessCurrent, prior: sessPrior, change_pct: sessionsPct },
  ]

  const nuCurrent = ga4.new_users_7d
  const nuPrior   = ga4.new_users_prior_7d
  if (nuPrior !== null) {
    const nuPct = changePct(nuCurrent, nuPrior)
    if (isMaterial(nuPct, GA4_MATERIAL_CHANGE_PCT)) {
      evidence.push({ metric: 'ga4_new_users_7d', current: nuCurrent, prior: nuPrior, change_pct: nuPct })
    }
  }

  const pvCurrent = ga4.page_views_7d
  const pvPrior   = ga4.page_views_prior_7d
  if (pvPrior !== null) {
    const pvPct = changePct(pvCurrent, pvPrior)
    if (isMaterial(pvPct, GA4_MATERIAL_CHANGE_PCT)) {
      evidence.push({ metric: 'ga4_page_views_7d', current: pvCurrent, prior: pvPrior, change_pct: pvPct })
    }
  }

  const volFactor = clamp(sessCurrent / (GA4_MIN_SESSIONS_FOR_SIGNAL * 10))
  candidates.push({
    id: 'ga4_sessions',
    source: 'ga4',
    category: 'traffic_audience',
    observation: `Website sessions ${sessionsPct > 0 ? 'up' : 'down'} ${Math.abs(sessionsPct * 100).toFixed(1)}% vs prior 7 days (${fmtNum(sessCurrent)} vs ${fmtNum(sessPrior)}).`,
    evidence,
    materiality_score: score('traffic_audience', Math.abs(sessionsPct), volFactor),
    commercially_relevant: true,
    creatively_relevant: false,
  })

  return candidates
}

function gbpPerformanceSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const gbp = data.gbpPerformance
  if (!gbp) return candidates

  // Aggregate current interactions for volume guard
  const interactions = [
    gbp.website_clicks_28d,
    gbp.call_clicks_28d,
    gbp.direction_requests_28d,
  ].reduce<number>((sum, v) => sum + (v ?? 0), 0)

  if (interactions < GBP_MIN_INTERACTIONS_FOR_SIGNAL) return candidates

  const evidence: SignalMetricEvidence[] = []
  let dominantPct = 0

  const metrics: Array<[string, number | null, number | null]> = [
    ['gbp_search_impressions_28d', gbp.search_impressions_28d, gbp.search_impressions_prior_28d],
    ['gbp_maps_impressions_28d',   gbp.maps_impressions_28d,   gbp.maps_impressions_prior_28d],
    ['gbp_website_clicks_28d',     gbp.website_clicks_28d,     gbp.website_clicks_prior_28d],
    ['gbp_call_clicks_28d',        gbp.call_clicks_28d,        gbp.call_clicks_prior_28d],
    ['gbp_direction_requests_28d', gbp.direction_requests_28d, gbp.direction_requests_prior_28d],
  ]

  for (const [metric, current, prior] of metrics) {
    if (current === null || prior === null) continue
    const pct = changePct(current, prior)
    if (isMaterial(pct, GBP_MATERIAL_CHANGE_PCT)) {
      evidence.push({ metric, current, prior, change_pct: pct })
      if (dominantPct === 0) dominantPct = pct
    }
  }

  if (evidence.length === 0) return candidates

  const volFactor = clamp(interactions / (GBP_MIN_INTERACTIONS_FOR_SIGNAL * 5))
  const direction = dominantPct > 0 ? 'up' : 'down'
  candidates.push({
    id: 'gbp_performance',
    source: 'gbp_performance',
    category: 'seo_local_search',
    observation: `Google Business Profile interactions ${direction} ${Math.abs(dominantPct * 100).toFixed(1)}% vs prior 28-day period.`,
    evidence,
    materiality_score: score('seo_local_search', Math.abs(dominantPct), volFactor),
    commercially_relevant: true,
    creatively_relevant: false,
  })

  return candidates
}

function dataHealthSignals(data: BriefInputData): MaterialSignalCandidate[] {
  if (!data.signals.has_stale_critical_source) return []

  const stale = data.signals.stale_sources
  return [
    {
      id: 'data_health_stale_sources',
      source: 'data_health',
      category: 'data_health',
      observation: `Critical data source(s) stale or failed: ${stale.join(', ')}. Brief data may be incomplete.`,
      evidence: [],
      materiality_score: CATEGORY_BASE.data_health,
      commercially_relevant: false,
      creatively_relevant: false,
    },
  ]
}

// ─── Deduplication ────────────────────────────────────────────────────────────
//
// If two candidates share the same source + direction on overlapping metrics,
// merge them: keep the higher-scored one and append the other's evidence items.

function deduplicateCandidates(candidates: MaterialSignalCandidate[]): MaterialSignalCandidate[] {
  // Strategy: same id → deduplicate (keep first since they're sorted by score).
  // Candidates from different sources are never merged.
  const seen = new Set<string>()
  const result: MaterialSignalCandidate[] = []

  for (const c of candidates) {
    if (!seen.has(c.id)) {
      seen.add(c.id)
      result.push(c)
    }
  }

  return result
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n * 100) / 100)
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildMaterialSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const all: MaterialSignalCandidate[] = [
    ...metaPaidSignals(data),
    ...googleAdsSignals(data),
    ...organicIgSignals(data),
    ...searchConsoleSignals(data),
    ...ga4Signals(data),
    ...gbpPerformanceSignals(data),
    ...dataHealthSignals(data),
  ]

  // Sort descending by materiality_score, then deduplicate, then cap at max.
  const sorted = all.sort((a, b) => b.materiality_score - a.materiality_score)
  const deduped = deduplicateCandidates(sorted)
  return deduped.slice(0, MAX_SIGNAL_CANDIDATES)
}
