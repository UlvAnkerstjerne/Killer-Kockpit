/**
 * lib/marketing/brief/material-signals.ts
 *
 * Deterministic material signal layer for the Marketing Morning Brief v2.
 * Sits between BriefInputData and the AI prompt.
 *
 * Responsibilities:
 *   - Identify and rank commercially material facts across 6 data sources
 *   - Apply per-source volume guards so small-audience large-% swings are suppressed
 *   - Merge same-movement signals into one candidate with multiple evidence items
 *   - Return at most MAX_SIGNAL_CANDIDATES candidates, ranked strongest first
 *
 * Guarantees:
 *   - Pure function — no side effects, no I/O, no randomness
 *   - All thresholds exported as named constants for testability
 *   - UNTRUSTED text (campaign names, captions, queries, keywords)
 *     is stored under the DATA: prefix in observations
 *   - Does NOT generate recommendations — only identifies facts
 *   - Never outputs Infinity%, NaN%, or misleading metric labels
 *   - "Interactions" means website clicks + calls + direction requests only
 *     (impressions are never called interactions)
 */

import type { BriefInputData, PaidAnomalySignal } from './types'

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
  metric:     string         // e.g. 'spend_7d', 'reach_7d', 'clicks_7d'
  current:    number | null
  prior:      number | null
  change_pct: number | null  // fractional: 0.20 = +20%. null when prior unavailable or metric is absolute (e.g. position)
}

export interface MaterialSignalCandidate {
  id:                    string   // stable slug derived from source + stable entity IDs, not display labels
  source:                SignalSource
  category:              SignalCategory
  observation:           string   // concise factual sentence — no recommendations, no Infinity/NaN
  evidence:              SignalMetricEvidence[]
  materiality_score:     number   // higher = more material; used only for ranking
  commercially_relevant: boolean
  creatively_relevant:   boolean
}

// ─── Exported thresholds ──────────────────────────────────────────────────────

// Google Ads — account level (any metric can trigger)
export const GADS_MIN_SPEND_7D_FOR_SIGNAL        = 100   // DKK/account currency
export const GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL  = 500
export const GADS_MIN_CLICKS_7D_FOR_SIGNAL       = 20
export const GADS_MATERIAL_CHANGE_PCT            = 0.20  // fractional

// Google Ads — per-result
export const GADS_MIN_RESULTS_FOR_SIGNAL         = 5

// Organic IG
export const IG_MIN_REACH_FOR_SIGNAL             = 200
export const IG_MATERIAL_REACH_CHANGE_PCT        = 0.15
export const IG_POST_OUTPERFORMANCE_PCT          = 0.50  // post must be ≥ 50% above avg
export const IG_POST_OUTPERFORMANCE_MIN_REACH    = 100
// Follower change: BOTH thresholds must be met for a candidate to fire.
// Absolute floor prevents noise on large accounts; rate floor prevents noise on small accounts.
export const IG_MIN_FOLLOWER_DELTA               = 100   // absolute change (gains or losses)
export const IG_MIN_FOLLOWER_CHANGE_RATE         = 0.004 // ~0.4% of existing follower base

// Search Console — movement
export const GSC_MIN_CLICKS_FOR_SIGNAL           = 30
export const GSC_MIN_IMPRESSIONS_FOR_SIGNAL      = 500
export const GSC_MATERIAL_CHANGE_PCT             = 0.20
// Position: lower is better. Absolute delta threshold (positions, not percent).
export const GSC_MATERIAL_POSITION_DELTA         = 1.0   // e.g. 7.2 → 4.8 = 2.4 positions, material
export const GSC_MIN_POSITION_IMPRESSIONS        = 500   // must have adequate impression volume

// Search Console — opportunity (high impressions, middling position, low CTR)
export const GSC_OPPORTUNITY_MIN_IMPRESSIONS     = 500
export const GSC_OPPORTUNITY_MAX_POSITION        = 15    // not ranking on page 1
export const GSC_OPPORTUNITY_MAX_CTR             = 0.03  // 3% CTR

// GA4 — any metric can trigger (one combined candidate)
export const GA4_MIN_SESSIONS_FOR_SIGNAL         = 50
export const GA4_MIN_NEW_USERS_FOR_SIGNAL        = 30
export const GA4_MIN_PAGE_VIEWS_FOR_SIGNAL       = 100
export const GA4_MATERIAL_CHANGE_PCT             = 0.20

// GBP Performance
// "Interactions" = website_clicks + calls + direction_requests — NEVER impressions
export const GBP_MIN_INTERACTIONS_FOR_SIGNAL     = 20
export const GBP_MIN_IMPRESSIONS_FOR_SIGNAL      = 200   // separate guard for impression metrics
export const GBP_MATERIAL_CHANGE_PCT             = 0.20
export const GBP_KEYWORD_MIN_IMPRESSIONS         = 50    // minimum volume to surface keyword context

// Output cap
export const MAX_SIGNAL_CANDIDATES               = 12

// ─── Category base weights (for scoring) ─────────────────────────────────────

const CATEGORY_BASE: Record<SignalCategory, number> = {
  commercial_consequence: 100,
  traffic_audience:        60,
  creative_learning:       40,
  seo_local_search:        30,
  data_health:             20,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fractional change. Returns null when prior = 0 and current > 0 (emergence).
 * Never returns Infinity or NaN.
 */
function changePct(current: number, prior: number): number | null {
  if (prior === 0) return current > 0 ? null : 0
  return (current - prior) / prior
}

/**
 * Is the change material?
 * null (emergence, prior=0→positive) is always considered material once the volume guard passes.
 */
function isMaterial(pct: number | null, threshold: number): boolean {
  if (pct === null) return true   // emergence
  return Math.abs(pct) >= threshold
}

/**
 * Magnitude for scoring.
 * Uses emergenceProxy (default 1.0 = 100%) when pct is null (prior was 0).
 * Capped at 2.0 (200%) to prevent extreme outliers from dominating.
 */
function scoreMagnitude(pct: number | null, emergenceProxy = 1.0): number {
  if (pct === null) return emergenceProxy
  return Math.abs(pct)
}

/** Score = category_base × (1 + magnitude_capped) × volume_factor. */
function score(
  category: SignalCategory,
  absMagnitude: number,
  volumeFactor: number,
): number {
  return CATEGORY_BASE[category] * (1 + Math.min(absMagnitude, 2)) * Math.min(volumeFactor, 1)
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/** Format a non-null fractional change safely. */
function fmtPct(pct: number): string {
  return `${Math.abs(pct * 100).toFixed(1)}%`
}

/** Sanitize UNTRUSTED text for use as DATA: in an observation. */
function dataTag(text: string): string {
  return `DATA:${text.slice(0, 80)}`
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n * 100) / 100)
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

// ─── Per-source signal builders ───────────────────────────────────────────────

function metaPaidSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []

  // Reuse PaidAnomalySignal records — already computed deterministically.
  // change_pct in PaidAnomalySignal is in percentage UNITS (e.g. 28.5 = 28.5%), not fractional.
  // Anomalies live in data.signals, not data.paid — process regardless of paid nullability.
  const anomalies: PaidAnomalySignal[] = data.signals.paid_anomalies

  for (const anomaly of anomalies) {
    const changeFrac   = anomaly.change_pct / 100
    const volFactor    = clamp(anomaly.yesterday_value / (anomaly.yesterday_value + 1000))
    const isCommercial = ['spend', 'cpc', 'cpm'].includes(anomaly.metric_label)

    candidates.push({
      id: `meta_paid_anomaly_${slugify(anomaly.campaign_name)}_${anomaly.metric_label}`,
      source: 'meta_paid',
      category: 'commercial_consequence',
      observation: `${dataTag(anomaly.campaign_name)} — ${anomaly.metric_label} ${anomaly.direction === 'increase' ? 'up' : 'down'} ${Math.abs(anomaly.change_pct).toFixed(1)}% vs 6-day average (yesterday: ${fmtNum(anomaly.yesterday_value)}, baseline: ${fmtNum(anomaly.baseline_value)}).`,
      evidence: [
        {
          metric:     anomaly.metric_label,
          current:    anomaly.yesterday_value,
          prior:      anomaly.baseline_value,
          change_pct: changeFrac,
        },
      ],
      materiality_score: score('commercial_consequence', Math.abs(changeFrac), volFactor),
      commercially_relevant: isCommercial,
      creatively_relevant: false,
    })
  }

  return candidates
}

function googleAdsSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const gads = data.googleAds
  if (!gads) return candidates

  // ── Account-level: ANY material movement in spend / impressions / clicks
  //    triggers ONE candidate. Use the strongest mover as headline.
  {
    type AccountMetric = {
      key:       string
      label:     string
      current:   number
      prior:     number | null
      minVolume: number
    }
    const checks: AccountMetric[] = [
      { key: 'spend_7d',       label: 'spend',       current: gads.total_spend_7d,       prior: gads.total_spend_prior_7d,       minVolume: GADS_MIN_SPEND_7D_FOR_SIGNAL },
      { key: 'impressions_7d', label: 'impressions', current: gads.total_impressions_7d, prior: gads.total_impressions_prior_7d, minVolume: GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL },
      { key: 'clicks_7d',      label: 'clicks',      current: gads.total_clicks_7d,      prior: gads.total_clicks_prior_7d,      minVolume: GADS_MIN_CLICKS_7D_FOR_SIGNAL },
    ]

    const evidence: SignalMetricEvidence[] = []
    type BestMetric = { key: string; label: string; current: number; prior: number; pct: number | null; mag: number }
    let strongest: BestMetric | null = null

    for (const c of checks) {
      if (c.prior === null || c.current < c.minVolume) continue
      const pct = changePct(c.current, c.prior)
      if (!isMaterial(pct, GADS_MATERIAL_CHANGE_PCT)) continue
      const mag = scoreMagnitude(pct)
      evidence.push({ metric: c.key, current: c.current, prior: c.prior, change_pct: pct })
      if (!strongest || mag > strongest.mag) {
        strongest = { key: c.key, label: c.label, current: c.current, prior: c.prior, pct, mag }
      }
    }

    if (evidence.length > 0 && strongest) {
      const dir          = strongest.pct === null || strongest.pct >= 0 ? 'up' : 'down'
      const volFactor    = clamp(strongest.current / (strongest.current + GADS_MIN_SPEND_7D_FOR_SIGNAL * 5))
      // Only include currency unit for spend — impressions and clicks are dimensionless counts.
      const isSpend      = strongest.key === 'spend_7d'
      const currencySufx = isSpend ? ` ${gads.currency}` : ''
      const obs = strongest.pct !== null
        ? `Google Ads ${strongest.label} ${dir} ${fmtPct(strongest.pct)} vs prior 7 days (${fmtNum(strongest.current)} vs ${fmtNum(strongest.prior)}${currencySufx}).`
        : `Google Ads ${strongest.label} increased from 0 to ${fmtNum(strongest.current)}${currencySufx}.`

      candidates.push({
        id: 'google_ads_account_totals',
        source: 'google_ads',
        category: 'commercial_consequence',
        observation: obs,
        evidence,
        materiality_score: score('commercial_consequence', strongest.mag, volFactor),
        commercially_relevant: true,
        creatively_relevant: false,
      })
    }
  }

  // ── Per-campaign result comparisons
  //    Signal ID uses result_id (action resource name) — NOT the display label,
  //    so the ID is stable regardless of label changes.
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

      const dir       = pct === null || pct >= 0 ? 'up' : 'down'
      const volFactor = clamp(result.count / (GADS_MIN_RESULTS_FOR_SIGNAL * 4))
      const obs = pct !== null
        ? `${dataTag(campaign.name)} — ${result.label} ${dir} ${fmtPct(pct)} vs prior 7 days (${result.count} vs ${result.prior_count}).`
        : `${dataTag(campaign.name)} — ${result.label} increased from 0 to ${result.count}.`

      candidates.push({
        id: `google_ads_result_${slugify(campaign.id)}_${slugify(result.result_id)}`,
        source: 'google_ads',
        category: 'commercial_consequence',
        observation: obs,
        evidence,
        materiality_score: score('commercial_consequence', scoreMagnitude(pct), volFactor),
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
      const dir = pct === null || pct >= 0 ? 'up' : 'down'
      const evidence: SignalMetricEvidence[] = [
        { metric: 'ig_reach_7d', current: reachCurrent, prior: reachPrior, change_pct: pct },
      ]
      const engCurrent = ig.accounts_engaged_7d
      if (engCurrent !== null) {
        evidence.push({ metric: 'ig_accounts_engaged_7d', current: engCurrent, prior: null, change_pct: null })
      }
      const obs = pct !== null
        ? `Instagram organic reach ${dir} ${fmtPct(pct)} vs prior 7 days (${fmtNum(reachCurrent)} vs ${fmtNum(reachPrior)}).`
        : `Instagram organic reach increased from 0 to ${fmtNum(reachCurrent)}.`

      candidates.push({
        id: 'organic_ig_reach',
        source: 'organic_ig',
        category: 'traffic_audience',
        observation: obs,
        evidence,
        materiality_score: score('traffic_audience', scoreMagnitude(pct), clamp(reachCurrent / (IG_MIN_REACH_FOR_SIGNAL * 5))),
        commercially_relevant: false,
        creatively_relevant: true,
      })
    }
  }

  // Follower delta — BOTH absolute floor AND rate-of-change must be met.
  // Absolute floor: suppresses routine +/- noise on large accounts.
  // Rate floor: expressed as fraction of the approximate follower base (followers before
  //   the 7-day window = followers_current - followers_7d_delta), so the bar scales with
  //   account size. Missing or non-positive base → no signal (cannot compute rate safely).
  const followerDelta   = ig.followers_7d_delta
  const followerCurrent = ig.followers_current
  if (followerDelta !== null && Math.abs(followerDelta) >= IG_MIN_FOLLOWER_DELTA) {
    const followerBase   = followerCurrent !== null ? followerCurrent - followerDelta : null
    const baseIsValid    = followerBase !== null && followerBase > 0
    const changeRate     = baseIsValid ? Math.abs(followerDelta) / followerBase! : null
    if (changeRate !== null && changeRate >= IG_MIN_FOLLOWER_CHANGE_RATE) {
      candidates.push({
        id: 'organic_ig_followers',
        source: 'organic_ig',
        category: 'traffic_audience',
        observation: `Instagram follower count ${followerDelta > 0 ? 'grew' : 'fell'} by ${Math.abs(followerDelta)} in the past 7 days (current: ${fmtNum(followerCurrent ?? 0)}).`,
        evidence: [
          { metric: 'ig_followers_delta_7d', current: followerDelta, prior: null, change_pct: changeRate * Math.sign(followerDelta) },
        ],
        materiality_score: score('traffic_audience', changeRate, 0.5),
        commercially_relevant: false,
        creatively_relevant: false,
      })
    }
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
      observation: `Instagram post ${post.published_at} (${post.media_type}) reached ${fmtNum(post.reach ?? 0)}, ${post.performance_vs_avg_pct!.toFixed(0)}% above 7-day average. Caption: ${dataTag(post.caption_truncated ?? '')}`,
      evidence: [
        {
          metric:     'ig_post_reach',
          current:    post.reach ?? null,
          prior:      null,
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
  const clicksOk      = clicksCurrent >= GSC_MIN_CLICKS_FOR_SIGNAL
  const impOk         = impCurrent    >= GSC_MIN_IMPRESSIONS_FOR_SIGNAL

  // ── Movement candidate — strongest signal drives the headline
  {
    type MovingMetric = {
      metric: string
      label:  string
      current: number
      prior:   number
      pct:     number | null
      mag:     number
    }
    const moving: MovingMetric[] = []

    if (clicksOk && clicksPrior !== null) {
      const pct = changePct(clicksCurrent, clicksPrior)
      if (isMaterial(pct, GSC_MATERIAL_CHANGE_PCT)) {
        moving.push({ metric: 'gsc_clicks_7d', label: 'clicks', current: clicksCurrent, prior: clicksPrior, pct, mag: scoreMagnitude(pct) })
      }
    }
    if (impOk && impPrior !== null) {
      const pct = changePct(impCurrent, impPrior)
      if (isMaterial(pct, GSC_MATERIAL_CHANGE_PCT)) {
        moving.push({ metric: 'gsc_impressions_7d', label: 'impressions', current: impCurrent, prior: impPrior, pct, mag: scoreMagnitude(pct) })
      }
    }

    const ctrCurrent = sc.ctr_7d
    const ctrPrior   = sc.ctr_prior_7d
    if (clicksOk && ctrCurrent !== null && ctrPrior !== null) {
      const pct = changePct(ctrCurrent, ctrPrior)
      if (isMaterial(pct, GSC_MATERIAL_CHANGE_PCT)) {
        moving.push({ metric: 'gsc_ctr_7d', label: 'CTR', current: ctrCurrent, prior: ctrPrior, pct, mag: scoreMagnitude(pct) })
      }
    }

    // Average position: lower = better. Use absolute delta, not %.
    // Stored as null change_pct since fractional position change is misleading.
    const posCurrent = sc.avg_position_7d
    const posPrior   = sc.avg_position_prior_7d
    if (
      posCurrent !== null && posPrior !== null &&
      impCurrent >= GSC_MIN_POSITION_IMPRESSIONS
    ) {
      const posDelta = posCurrent - posPrior // negative = improvement
      if (Math.abs(posDelta) >= GSC_MATERIAL_POSITION_DELTA) {
        // Magnitude: each position counts as ~0.15 relative impact, capped at 1.
        moving.push({
          metric: 'gsc_avg_position_7d',
          label:  'average position',
          current: posCurrent,
          prior:   posPrior,
          pct:     null,   // absolute delta — do not express as %
          mag:     Math.min(Math.abs(posDelta) * 0.15, 1.0),
        })
      }
    }

    if (moving.length > 0) {
      moving.sort((a, b) => b.mag - a.mag)
      const s = moving[0]
      const evidence: SignalMetricEvidence[] = moving.map(m => ({
        metric: m.metric, current: m.current, prior: m.prior, change_pct: m.pct,
      }))

      let obs: string
      if (s.metric === 'gsc_avg_position_7d') {
        const delta = s.current - s.prior
        const dir   = delta < 0 ? 'improved' : 'declined'
        obs = `Organic search average position ${dir} by ${Math.abs(delta).toFixed(1)} positions vs prior 7 days (${s.current.toFixed(1)} vs ${s.prior.toFixed(1)}).`
      } else {
        const dir = s.pct === null || s.pct >= 0 ? 'up' : 'down'
        obs = s.pct !== null
          ? `Organic search ${s.label} ${dir} ${fmtPct(s.pct)} vs prior 7 days (${fmtNum(s.current)} vs ${fmtNum(s.prior)}).`
          : `Organic search ${s.label} increased from 0 to ${fmtNum(s.current)}.`
      }

      const volFactor = clicksOk
        ? clamp(clicksCurrent / (GSC_MIN_CLICKS_FOR_SIGNAL * 10))
        : clamp(impCurrent    / (GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 5))

      candidates.push({
        id: 'search_console_organic',
        source: 'search_console',
        category: 'seo_local_search',
        observation: obs,
        evidence,
        materiality_score: score('seo_local_search', s.mag, volFactor),
        commercially_relevant: true,
        creatively_relevant: false,
      })
    }
  }

  // ── Opportunity candidate: high-impression query with low CTR and middling position
  {
    const opQueries = sc.top_queries.filter(
      q =>
        q.impressions >= GSC_OPPORTUNITY_MIN_IMPRESSIONS &&
        q.position    !== null &&
        q.position    >  GSC_OPPORTUNITY_MAX_POSITION &&
        q.ctr         <  GSC_OPPORTUNITY_MAX_CTR,
    )
    if (opQueries.length > 0) {
      const top = opQueries[0]
      const posLabel = top.position !== null ? top.position.toFixed(1) : 'unknown'
      candidates.push({
        id: 'search_console_opportunity',
        source: 'search_console',
        category: 'seo_local_search',
        observation: `High-impression query at average position ${posLabel} with low CTR (${(top.ctr * 100).toFixed(1)}%): ${dataTag(top.query)} (${fmtNum(top.impressions)} impressions, ${top.clicks} clicks).`,
        evidence: [
          { metric: 'gsc_query_impressions', current: top.impressions, prior: null, change_pct: null },
          { metric: 'gsc_query_ctr',         current: top.ctr,         prior: null, change_pct: null },
          { metric: 'gsc_query_position',    current: top.position ?? 0, prior: null, change_pct: null },
        ],
        materiality_score: score('seo_local_search', clamp(top.impressions / (GSC_OPPORTUNITY_MIN_IMPRESSIONS * 5)), 0.5),
        commercially_relevant: true,
        creatively_relevant: true,
      })
    }
  }

  return candidates
}

function ga4Signals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const ga4 = data.ga4
  if (!ga4) return candidates

  // ANY material movement in sessions / new users / page views →
  // ONE combined candidate. Strongest mover drives the headline.
  type Ga4Metric = { key: string; label: string; current: number; prior: number | null; minVolume: number }
  const checks: Ga4Metric[] = [
    { key: 'ga4_sessions_7d',   label: 'sessions',   current: ga4.sessions_7d,   prior: ga4.sessions_prior_7d,   minVolume: GA4_MIN_SESSIONS_FOR_SIGNAL },
    { key: 'ga4_new_users_7d',  label: 'new users',  current: ga4.new_users_7d,  prior: ga4.new_users_prior_7d,  minVolume: GA4_MIN_NEW_USERS_FOR_SIGNAL },
    { key: 'ga4_page_views_7d', label: 'page views', current: ga4.page_views_7d, prior: ga4.page_views_prior_7d, minVolume: GA4_MIN_PAGE_VIEWS_FOR_SIGNAL },
  ]

  const evidence: SignalMetricEvidence[] = []
  type BestMetric = { key: string; label: string; current: number; prior: number; pct: number | null; mag: number }
  let strongest: BestMetric | null = null

  for (const c of checks) {
    if (c.prior === null || c.current < c.minVolume) continue
    const pct = changePct(c.current, c.prior)
    if (!isMaterial(pct, GA4_MATERIAL_CHANGE_PCT)) continue
    const mag = scoreMagnitude(pct)
    evidence.push({ metric: c.key, current: c.current, prior: c.prior, change_pct: pct })
    if (!strongest || mag > strongest.mag) {
      strongest = { key: c.key, label: c.label, current: c.current, prior: c.prior, pct, mag }
    }
  }

  if (evidence.length === 0 || !strongest) return candidates

  const dir       = strongest.pct === null || strongest.pct >= 0 ? 'up' : 'down'
  const volFactor = clamp(strongest.current / (GA4_MIN_SESSIONS_FOR_SIGNAL * 10))
  const obs = strongest.pct !== null
    ? `Website ${strongest.label} ${dir} ${fmtPct(strongest.pct)} vs prior 7 days (${fmtNum(strongest.current)} vs ${fmtNum(strongest.prior)}).`
    : `Website ${strongest.label} increased from 0 to ${fmtNum(strongest.current)}.`

  candidates.push({
    id: 'ga4_traffic',
    source: 'ga4',
    category: 'traffic_audience',
    observation: obs,
    evidence,
    materiality_score: score('traffic_audience', strongest.mag, volFactor),
    commercially_relevant: true,
    creatively_relevant: false,
  })

  return candidates
}

function gbpPerformanceSignals(data: BriefInputData): MaterialSignalCandidate[] {
  const candidates: MaterialSignalCandidate[] = []
  const gbp = data.gbpPerformance
  if (!gbp) return candidates

  // "Interactions" = website_clicks + calls + direction_requests — NEVER impressions.
  const interactions = (gbp.website_clicks_28d ?? 0) + (gbp.call_clicks_28d ?? 0) + (gbp.direction_requests_28d ?? 0)
  const totalImpressions = (gbp.search_impressions_28d ?? 0) + (gbp.maps_impressions_28d ?? 0)

  const interactionVolOk = interactions    >= GBP_MIN_INTERACTIONS_FOR_SIGNAL
  const impressionVolOk  = totalImpressions >= GBP_MIN_IMPRESSIONS_FOR_SIGNAL

  // ── Period-over-period movement candidate
  if (interactionVolOk || impressionVolOk) {
    type GbpMetric = { key: string; label: string; current: number | null; prior: number | null; isImpression: boolean }
    const allMetrics: GbpMetric[] = [
      { key: 'gbp_search_impressions_28d', label: 'Search impressions',  current: gbp.search_impressions_28d, prior: gbp.search_impressions_prior_28d, isImpression: true },
      { key: 'gbp_maps_impressions_28d',   label: 'Maps impressions',    current: gbp.maps_impressions_28d,   prior: gbp.maps_impressions_prior_28d,   isImpression: true },
      { key: 'gbp_website_clicks_28d',     label: 'Website clicks',      current: gbp.website_clicks_28d,     prior: gbp.website_clicks_prior_28d,     isImpression: false },
      { key: 'gbp_call_clicks_28d',        label: 'Calls',               current: gbp.call_clicks_28d,        prior: gbp.call_clicks_prior_28d,        isImpression: false },
      { key: 'gbp_direction_requests_28d', label: 'Direction requests',  current: gbp.direction_requests_28d, prior: gbp.direction_requests_prior_28d, isImpression: false },
    ]

    type MovingMetric = { key: string; label: string; current: number; prior: number; pct: number | null; mag: number }
    const moving: MovingMetric[] = []

    for (const m of allMetrics) {
      if (m.current === null || m.prior === null) continue
      // Apply per-metric volume guard
      if (m.isImpression && !impressionVolOk) continue
      if (!m.isImpression && !interactionVolOk) continue

      const pct = changePct(m.current, m.prior)
      if (!isMaterial(pct, GBP_MATERIAL_CHANGE_PCT)) continue
      moving.push({ key: m.key, label: m.label, current: m.current, prior: m.prior, pct, mag: scoreMagnitude(pct) })
    }

    if (moving.length > 0) {
      moving.sort((a, b) => b.mag - a.mag)
      const s = moving[0]
      const dir = s.pct === null || s.pct >= 0 ? 'up' : 'down'
      const obs = s.pct !== null
        ? `Google Business Profile ${s.label} ${dir} ${fmtPct(s.pct)} vs prior 28-day period (${fmtNum(s.current)} vs ${fmtNum(s.prior)}).`
        : `Google Business Profile ${s.label} increased from 0 to ${fmtNum(s.current)}.`

      const strongestIsImpression = s.key.includes('impressions')
      const volFactor = strongestIsImpression
        ? clamp(totalImpressions / (GBP_MIN_IMPRESSIONS_FOR_SIGNAL  * 5))
        : clamp(interactions     / (GBP_MIN_INTERACTIONS_FOR_SIGNAL * 5))

      candidates.push({
        id: 'gbp_performance',
        source: 'gbp_performance',
        category: 'seo_local_search',
        observation: obs,
        evidence: moving.map(m => ({ metric: m.key, current: m.current, prior: m.prior, change_pct: m.pct })),
        materiality_score: score('seo_local_search', s.mag, volFactor),
        commercially_relevant: true,
        creatively_relevant: false,
      })
    }
  }

  // ── GBP keyword context candidate (independent of movement)
  //    Surface top keyword(s) from the latest month as demand context.
  //    Be honest: threshold impressions are labeled <N, not as exact counts.
  //
  //    Volume gate: only an exact impressions value can prove the minimum-volume
  //    threshold has been met.  A threshold value (e.g. <100 impressions) is an
  //    upper bound — it does NOT prove the keyword exceeds GBP_KEYWORD_MIN_IMPRESSIONS.
  //    Threshold-only keywords may appear as supporting context once an exact
  //    qualifying keyword has triggered the candidate, but cannot trigger it alone.
  //
  //    Suppression: if gbp_performance already occupies the brief, keyword context
  //    adds editorial redundancy — the same GBP story is already leading the brief.
  //    Only emit keyword context when there is no material GBP performance signal.
  const hasGbpPerformance = candidates.some(c => c.id === 'gbp_performance')
  const topKws = gbp.top_keywords.slice(0, 3)
  if (!hasGbpPerformance && topKws.length > 0 && gbp.keyword_month !== null) {
    const hasExactQualifyingKeyword = topKws.some(
      (k) => k.impressions !== null && k.impressions >= GBP_KEYWORD_MIN_IMPRESSIONS,
    )
    if (hasExactQualifyingKeyword) {
      const kwSummary = topKws.map(k => {
        const imp = k.impressions !== null
          ? `${fmtNum(k.impressions)} impressions`
          : k.impressionsThreshold !== null
            ? `<${fmtNum(k.impressionsThreshold)} impressions`
            : 'impressions unavailable'
        return `${dataTag(k.keyword)} (${imp})`
      }).join('; ')

      candidates.push({
        id: 'gbp_keyword_context',
        source: 'gbp_performance',
        category: 'seo_local_search',
        observation: `Top Google search keywords driving GBP impressions (${gbp.keyword_month}): ${kwSummary}.`,
        evidence: topKws.map(k => ({
          metric:     'gbp_keyword_impressions',
          current:    k.impressions ?? k.impressionsThreshold ?? null,
          prior:      null,
          change_pct: null,
        })),
        materiality_score: score('seo_local_search', 0.2, 0.4),
        commercially_relevant: false,
        creatively_relevant: true,
      })
    }
  }

  return candidates
}

function dataHealthSignals(data: BriefInputData): MaterialSignalCandidate[] {
  // Collect stale sources: Meta sources come from deterministic signals;
  // Google sources (google_ads, gsc, ga4) are checked directly from sourceFreshness.
  const stale = new Set<string>(data.signals.stale_sources)

  const sf = data.sourceFreshness
  if (!sf.google_ads.healthy) stale.add('google_ads')
  if (!sf.gsc.healthy)        stale.add('gsc')
  if (!sf.ga4.healthy)        stale.add('ga4')

  if (stale.size === 0) return []

  const staleList = [...stale]
  return [
    {
      id: 'data_health_stale_sources',
      source: 'data_health',
      category: 'data_health',
      observation: `Critical data source(s) stale or failed: ${staleList.join(', ')}. Brief data may be incomplete.`,
      evidence: [],
      materiality_score: CATEGORY_BASE.data_health,
      commercially_relevant: false,
      creatively_relevant: false,
    },
  ]
}

// ─── Deduplication ────────────────────────────────────────────────────────────
//
// Same id → keep first (highest scored, since input is sorted descending).

function deduplicateCandidates(candidates: MaterialSignalCandidate[]): MaterialSignalCandidate[] {
  const seen   = new Set<string>()
  const result: MaterialSignalCandidate[] = []
  for (const c of candidates) {
    if (!seen.has(c.id)) {
      seen.add(c.id)
      result.push(c)
    }
  }
  return result
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

  // Sort descending by materiality_score, deduplicate, cap at max.
  const sorted = all.sort((a, b) => b.materiality_score - a.materiality_score)
  const deduped = deduplicateCandidates(sorted)
  return deduped.slice(0, MAX_SIGNAL_CANDIDATES)
}
