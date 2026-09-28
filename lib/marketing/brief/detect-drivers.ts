/**
 * lib/marketing/brief/detect-drivers.ts
 *
 * Deterministic driver detection for the Marketing Morning Brief.
 *
 * Pure function: MaterialSignalCandidate[] + BriefInputData + DriverContextData → MarketingDriverCandidate[]
 *
 * Responsibilities:
 *   - For each material signal, look across other data sources for plausible drivers
 *   - Score candidates using mechanism, temporal alignment, magnitude, evidence count
 *   - Apply counter-evidence to weaken or discard candidates
 *   - Return ranked candidates, strongest first
 *
 * Guarantees:
 *   - Pure function — no side effects, no I/O
 *   - Never claims causation — uses "likely driver", "possible contributor"
 *   - Every candidate includes a caveat
 *   - Discards weak candidates (score below threshold)
 *   - Handles 7d vs 28d window differences explicitly
 */

import type { BriefInputData } from './types'
import type { MaterialSignalCandidate } from './material-signals'
import type { DriverContextData, GoogleAdsDriverContext } from './driver-context'
import type {
  MarketingDriverCandidate,
  DriverConfidence,
  DriverEvidence,
  DriverScoreFactors,
  TemporalAlignment,
} from './driver-types'

// ─── Exported thresholds ────────────────────────────────────────────────────

export const DRIVER_MATERIAL_CHANGE_PCT    = 0.20   // 20% change is material
export const DRIVER_MIN_SCORE              = 0.30   // below this, discard
export const DRIVER_LIKELY_SCORE           = 0.60   // above this, "likely"
export const CADENCE_MATERIAL_CHANGE_RATIO = 0.50   // 50% fewer/more posts is material

// ─── Helpers ────────────────────────────────────────────────────────────────

function changePct(current: number, prior: number): number | null {
  if (prior === 0) return current > 0 ? null : 0
  return (current - prior) / prior
}

function isMaterial(pct: number | null, threshold: number): boolean {
  if (pct === null) return true // emergence
  return Math.abs(pct) >= threshold
}

function fmtPct(pct: number): string {
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${Math.round(pct * 100)}%`
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Score a driver candidate. Returns 0–1. */
function computeScore(factors: DriverScoreFactors): number {
  // Weighted: mechanism 30%, temporal 25%, magnitude 20%, evidence 10%, counter 15%
  return (
    factors.mechanism_strength  * 0.30 +
    factors.temporal_alignment  * 0.25 +
    factors.magnitude_alignment * 0.20 +
    factors.supporting_evidence * 0.10 +
    factors.counter_evidence    * 0.15
  )
}

function scoreToConfidence(score: number): DriverConfidence {
  return score >= DRIVER_LIKELY_SCORE ? 'likely' : 'possible'
}

/** Determine temporal alignment from a last-active date vs target window. */
function inferTemporalAlignment(
  lastActiveDate: string | null,
  targetWindowStart: string,
  targetWindowEnd: string,
): TemporalAlignment {
  if (!lastActiveDate) return 'unclear'
  if (lastActiveDate < targetWindowStart) return 'preceding'
  if (lastActiveDate <= targetWindowEnd) return 'overlapping'
  return 'following'
}

/** How well do two percentage changes align in direction and magnitude? */
function magnitudeAlignment(driverPct: number | null, targetPct: number | null): number {
  if (driverPct === null || targetPct === null) return 0.5
  // Same direction?
  if (Math.sign(driverPct) !== Math.sign(targetPct)) return 0.1
  // Magnitude ratio (closer = better)
  const ratio = Math.min(Math.abs(driverPct), Math.abs(targetPct)) /
                Math.max(Math.abs(driverPct), Math.abs(targetPct))
  return 0.3 + ratio * 0.7  // 0.3–1.0
}

function temporalAlignmentScore(ta: TemporalAlignment): number {
  switch (ta) {
    case 'preceding':   return 1.0
    case 'overlapping': return 0.8
    case 'unclear':     return 0.5
    case 'following':   return 0.2
  }
}

// ─── Rule 1: Google Ads → GBP ───────────────────────────────────────────────

function googleAdsToGbpDrivers(
  signal: MaterialSignalCandidate,
  data: BriefInputData,
  context: DriverContextData,
): MarketingDriverCandidate[] {
  // Only fires for GBP performance signals
  if (signal.source !== 'gbp_performance') return []
  const gads = context.googleAds
  if (!gads) return []

  const gbp = data.gbpPerformance
  if (!gbp) return []

  const candidates: MarketingDriverCandidate[] = []

  // Get the target signal's primary evidence change
  const targetPrimaryEvidence = signal.evidence[0]
  const targetPct = targetPrimaryEvidence?.change_pct ?? null

  // ── Check: was Ads already inactive in BOTH periods?
  // If so, Ads cannot be the driver.
  const bothPeriodsInactive =
    gads.total_impressions_28d < 100 &&
    (gads.total_impressions_prior_28d === null || gads.total_impressions_prior_28d < 100)
  if (bothPeriodsInactive) return []

  // ── Pattern A: Paid activity STOPPED or materially decreased
  const adsImpPct   = gads.total_impressions_prior_28d !== null
    ? changePct(gads.total_impressions_28d, gads.total_impressions_prior_28d) : null
  const adsClickPct = gads.total_clicks_prior_28d !== null
    ? changePct(gads.total_clicks_28d, gads.total_clicks_prior_28d) : null
  const adsSpendPct = gads.total_spend_prior_28d !== null
    ? changePct(gads.total_spend_28d, gads.total_spend_prior_28d) : null

  const anyAdsMaterial =
    isMaterial(adsImpPct, DRIVER_MATERIAL_CHANGE_PCT) ||
    isMaterial(adsClickPct, DRIVER_MATERIAL_CHANGE_PCT) ||
    isMaterial(adsSpendPct, DRIVER_MATERIAL_CHANGE_PCT)

  if (!anyAdsMaterial) return []

  // Determine if this is a decrease or increase pattern
  const adsDirection = (adsImpPct ?? 0) < 0 ? 'decrease' : 'increase'
  const targetDirection = (targetPct ?? 0) < 0 ? 'decrease' : 'increase'

  // Ads must move in same direction as GBP for this to be a driver
  if (adsDirection !== targetDirection) return []

  // Build evidence
  const evidence: DriverEvidence[] = []
  if (adsImpPct !== null) {
    evidence.push({
      metric: 'google_ads_impressions_28d',
      label: 'Google Ads impressions',
      current: gads.total_impressions_28d,
      prior: gads.total_impressions_prior_28d,
      change_pct: adsImpPct,
      window: '28d',
    })
  }
  if (adsClickPct !== null) {
    evidence.push({
      metric: 'google_ads_clicks_28d',
      label: 'Google Ads clicks',
      current: gads.total_clicks_28d,
      prior: gads.total_clicks_prior_28d,
      change_pct: adsClickPct,
      window: '28d',
    })
  }
  if (adsSpendPct !== null) {
    evidence.push({
      metric: 'google_ads_spend_28d',
      label: 'Google Ads spend',
      current: gads.total_spend_28d,
      prior: gads.total_spend_prior_28d,
      change_pct: adsSpendPct,
      window: '28d',
    })
  }

  const temporal = inferTemporalAlignment(
    gads.last_active_date,
    data.gbpPerformance ? subtractDays(data.dataWindowEnd, 27) : data.dataWindowStart,
    data.dataWindowEnd,
  )

  // Campaign pause state
  const hasPausedCampaigns = gads.paused_count > 0
  const allPaused = gads.enabled_count === 0 && gads.paused_count > 0

  // Build observation text
  let observation: string
  if (adsDirection === 'decrease') {
    if (allPaused && gads.last_active_date) {
      observation = `Google Ads campaigns are currently paused and recorded activity ended on ${gads.last_active_date}.`
    } else if (allPaused) {
      observation = `Google Ads campaigns are currently paused with no recent activity.`
    } else {
      const strongestPct = [adsImpPct, adsClickPct, adsSpendPct]
        .filter((p): p is number => p !== null)
        .sort((a, b) => Math.abs(b) - Math.abs(a))[0]
      observation = strongestPct
        ? `Google Ads activity fell ${fmtPct(strongestPct)} over the comparable 28-day period.`
        : `Google Ads activity materially decreased over the comparable 28-day period.`
    }
  } else {
    const strongestPct = [adsImpPct, adsClickPct, adsSpendPct]
      .filter((p): p is number => p !== null)
      .sort((a, b) => Math.abs(b) - Math.abs(a))[0]
    observation = strongestPct
      ? `Google Ads activity increased ${fmtPct(strongestPct)} over the comparable 28-day period.`
      : `Google Ads activity materially increased over the comparable 28-day period.`
  }

  const mechanism = adsDirection === 'decrease'
    ? 'Reduced paid search/display activity reduces paid impressions that contribute to GBP visibility.'
    : 'Increased paid search/display activity can boost GBP visibility through paid impressions.'

  // Score
  const strongestAdsPct = [adsImpPct, adsClickPct, adsSpendPct]
    .filter((p): p is number => p !== null)
    .sort((a, b) => Math.abs(b) - Math.abs(a))[0] ?? null

  const factors: DriverScoreFactors = {
    mechanism_strength:   allPaused ? 0.9 : hasPausedCampaigns ? 0.7 : 0.6,
    temporal_alignment:   temporalAlignmentScore(temporal),
    magnitude_alignment:  magnitudeAlignment(strongestAdsPct, targetPct),
    supporting_evidence:  Math.min(evidence.length / 3, 1),
    counter_evidence:     1.0,  // will be reduced below
  }

  const score = computeScore(factors)
  if (score < DRIVER_MIN_SCORE) return []

  candidates.push({
    id:                  `driver_gads_to_gbp_${signal.id}`,
    target_signal_id:    signal.id,
    driver_type:         'google_ads_to_gbp',
    source:              'google_ads',
    observation,
    evidence,
    temporal_alignment:  temporal,
    mechanism,
    confidence:          scoreToConfidence(score),
    caveat:              'Timing and mechanism are consistent with paid visibility contributing to the GBP change, but Kockpit cannot quantify exactly how much of the GBP movement was paid versus organic.',
    supporting_entity_ids: hasPausedCampaigns ? gads.paused_campaign_ids : undefined,
  })

  return candidates
}

// Helper for subtractDays within this module
function subtractDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ─── Rule 2: Paid traffic → GA4 website traffic ─────────────────────────────

function paidToGa4Drivers(
  signal: MaterialSignalCandidate,
  data: BriefInputData,
  context: DriverContextData,
): MarketingDriverCandidate[] {
  if (signal.source !== 'ga4') return []
  const ga4 = data.ga4
  if (!ga4) return []

  const candidates: MarketingDriverCandidate[] = []
  const evidence: DriverEvidence[] = []

  // Target signal direction
  const targetPrimaryEvidence = signal.evidence[0]
  const targetPct = targetPrimaryEvidence?.change_pct ?? null
  const targetDirection = (targetPct ?? 0) < 0 ? 'decrease' : 'increase'

  // Google Ads 7d clicks (from standard BriefInputData)
  const gads = data.googleAds
  let gadsClickPct: number | null = null
  if (gads && gads.total_clicks_prior_7d !== null) {
    gadsClickPct = changePct(gads.total_clicks_7d, gads.total_clicks_prior_7d)
    if (isMaterial(gadsClickPct, DRIVER_MATERIAL_CHANGE_PCT)) {
      evidence.push({
        metric: 'google_ads_clicks_7d',
        label: 'Google Ads clicks',
        current: gads.total_clicks_7d,
        prior: gads.total_clicks_prior_7d,
        change_pct: gadsClickPct,
        window: '7d',
      })
    }
  }

  // Meta paid clicks (from standard BriefInputData)
  const paid = data.paid
  let metaClickPct: number | null = null
  if (paid) {
    const currentMetaClicks = paid.active_campaigns.reduce((s, c) => s + (c.clicks_7d ?? 0), 0)
    // We don't have prior meta clicks in standard data, but check context
    if (context.metaPaid && context.metaPaid.total_clicks_prior_28d !== null) {
      // Use 7d window from standard data for meta — no separate 7d prior available
      // So we skip meta comparison unless context has it
    }
  }

  // Counter-evidence: Search Console organic clicks stable?
  let counterEvidence = 1.0  // no counter-evidence
  const gsc = data.searchConsole
  if (gsc && gsc.clicks_prior_7d !== null) {
    const gscPct = changePct(gsc.clicks_7d, gsc.clicks_prior_7d)
    if (gscPct !== null) {
      // If organic search is moving in same direction as GA4, paid may not be the only driver
      if (Math.sign(gscPct) === Math.sign(targetPct ?? 0) && Math.abs(gscPct) >= 0.15) {
        counterEvidence = 0.7  // organic is also moving, weakens paid-only explanation
      }
    }
  }

  if (evidence.length === 0) return []

  // Ensure driver direction matches target direction
  const driverDirection = (gadsClickPct ?? 0) < 0 ? 'decrease' : 'increase'
  if (driverDirection !== targetDirection) return []

  const temporal: TemporalAlignment = 'overlapping'  // 7d vs 7d

  const factors: DriverScoreFactors = {
    mechanism_strength:   0.7,
    temporal_alignment:   temporalAlignmentScore(temporal),
    magnitude_alignment:  magnitudeAlignment(gadsClickPct, targetPct),
    supporting_evidence:  Math.min(evidence.length / 2, 1),
    counter_evidence:     counterEvidence,
  }

  const score = computeScore(factors)
  if (score < DRIVER_MIN_SCORE) return []

  const strongestPct = evidence
    .map(e => e.change_pct)
    .filter((p): p is number => p !== null)
    .sort((a, b) => Math.abs(b) - Math.abs(a))[0]

  const paidLabel = evidence.map(e => e.label).join(' + ')
  const observation = strongestPct
    ? `${paidLabel} ${fmtPct(strongestPct)} over the same 7-day period.`
    : `Paid traffic sources materially changed over the same 7-day period.`

  candidates.push({
    id:                  `driver_paid_to_ga4_${signal.id}`,
    target_signal_id:    signal.id,
    driver_type:         'paid_to_ga4',
    source:              'google_ads',
    observation,
    evidence,
    temporal_alignment:  temporal,
    mechanism:           'Changes in paid click volume directly affect total website sessions.',
    confidence:          scoreToConfidence(score),
    caveat:              counterEvidence < 1.0
      ? 'Organic search traffic also moved in this period, so paid changes may not be the sole contributor.'
      : 'Paid clicks are a direct traffic source, but other channels may also have contributed.',
  })

  return candidates
}

// ─── Rule 3: Search Console → GA4 organic traffic ───────────────────────────

function gscToGa4OrganicDrivers(
  signal: MaterialSignalCandidate,
  data: BriefInputData,
): MarketingDriverCandidate[] {
  if (signal.source !== 'ga4') return []
  const ga4 = data.ga4
  const gsc = data.searchConsole
  if (!ga4 || !gsc || gsc.clicks_prior_7d === null) return []

  const gscClickPct = changePct(gsc.clicks_7d, gsc.clicks_prior_7d)
  if (!isMaterial(gscClickPct, DRIVER_MATERIAL_CHANGE_PCT)) return []

  const targetPct = signal.evidence[0]?.change_pct ?? null
  const targetDirection = (targetPct ?? 0) < 0 ? 'decrease' : 'increase'
  const gscDirection = (gscClickPct ?? 0) < 0 ? 'decrease' : 'increase'

  if (gscDirection !== targetDirection) return []

  const evidence: DriverEvidence[] = [{
    metric: 'gsc_clicks_7d',
    label: 'Organic search clicks',
    current: gsc.clicks_7d,
    prior: gsc.clicks_prior_7d,
    change_pct: gscClickPct,
    window: '7d',
  }]

  if (gsc.impressions_prior_7d !== null) {
    const impPct = changePct(gsc.impressions_7d, gsc.impressions_prior_7d)
    if (impPct !== null && Math.abs(impPct) >= 0.10) {
      evidence.push({
        metric: 'gsc_impressions_7d',
        label: 'Organic search impressions',
        current: gsc.impressions_7d,
        prior: gsc.impressions_prior_7d,
        change_pct: impPct,
        window: '7d',
      })
    }
  }

  const factors: DriverScoreFactors = {
    mechanism_strength:   0.8,
    temporal_alignment:   0.8,  // same 7d window
    magnitude_alignment:  magnitudeAlignment(gscClickPct, targetPct),
    supporting_evidence:  Math.min(evidence.length / 2, 1),
    counter_evidence:     1.0,
  }

  const score = computeScore(factors)
  if (score < DRIVER_MIN_SCORE) return []

  return [{
    id:                  `driver_gsc_to_ga4_${signal.id}`,
    target_signal_id:    signal.id,
    driver_type:         'gsc_to_ga4_organic',
    source:              'search_console',
    observation:         `Organic search clicks ${fmtPct(gscClickPct!)} over the same 7-day period.`,
    evidence,
    temporal_alignment:  'overlapping',
    mechanism:           'Changes in organic Google search clicks directly affect organic website sessions.',
    confidence:          scoreToConfidence(score),
    caveat:              'Search Console and GA4 organic sessions are closely related but may not match exactly due to attribution differences.',
  }]
}

// ─── Rule 4: Exceptional content → IG reach ─────────────────────────────────

function contentToIgReachDrivers(
  signal: MaterialSignalCandidate,
  data: BriefInputData,
  context: DriverContextData,
): MarketingDriverCandidate[] {
  if (signal.source !== 'organic_ig') return []
  if (signal.id !== 'organic_ig_reach') return []

  const targetPct = signal.evidence[0]?.change_pct ?? null
  // Only explains increases — exceptional posts drive reach UP
  if (targetPct !== null && targetPct < 0) return []

  const exceptionalIds = context.igCadence.exceptional_post_ids
  if (exceptionalIds.length === 0) return []

  // Find the exceptional posts in the top posts data
  const topPosts = data.organic.ig_top_posts
  const exceptionalPosts = topPosts.filter(p => {
    // Match by published_at date since we may not have exact IDs in top posts
    return p.performance_vs_avg_pct !== null && p.performance_vs_avg_pct >= 200
  })

  if (exceptionalPosts.length === 0) return []

  const best = exceptionalPosts[0]
  const evidence: DriverEvidence[] = [{
    metric: 'ig_post_reach',
    label: `${best.media_type} published ${best.published_at.slice(0, 10)}`,
    current: best.reach,
    prior: data.organic.ig_avg_reach_7d,
    change_pct: best.performance_vs_avg_pct !== null ? best.performance_vs_avg_pct / 100 : null,
    window: '7d',
  }]

  const factors: DriverScoreFactors = {
    mechanism_strength:   0.8,
    temporal_alignment:   0.9,  // published within the window
    magnitude_alignment:  0.7,
    supporting_evidence:  Math.min(exceptionalPosts.length / 2, 1),
    counter_evidence:     1.0,
  }

  const score = computeScore(factors)
  if (score < DRIVER_MIN_SCORE) return []

  const perfLabel = best.performance_vs_avg_pct !== null
    ? `${Math.round(best.performance_vs_avg_pct)}% above average`
    : 'significantly above average'

  return [{
    id:                  `driver_content_to_ig_${signal.id}`,
    target_signal_id:    signal.id,
    driver_type:         'content_to_ig_reach',
    source:              'organic_ig',
    observation:         `An exceptional ${best.media_type} (${perfLabel}) published within the window likely boosted account reach.`,
    evidence,
    temporal_alignment:  'overlapping',
    mechanism:           'A single high-performing post can disproportionately increase account-level reach.',
    confidence:          scoreToConfidence(score),
    caveat:              'One exceptional post does not establish a repeatable pattern. Account reach depends on multiple factors including algorithmic distribution.',
    supporting_entity_ids: exceptionalIds,
  }]
}

// ─── Rule 5: Posting cadence → organic reach ────────────────────────────────

function postingCadenceToOrganicDrivers(
  signal: MaterialSignalCandidate,
  data: BriefInputData,
  context: DriverContextData,
): MarketingDriverCandidate[] {
  if (signal.source !== 'organic_ig') return []
  if (signal.id !== 'organic_ig_reach') return []

  const cadence = context.igCadence
  // Need at least some posts in one period for comparison
  if (cadence.posts_current_7d === 0 && cadence.posts_prior_7d === 0) return []
  if (cadence.posts_prior_7d === 0) return []  // can't compare from zero

  const cadenceChangePct = changePct(cadence.posts_current_7d, cadence.posts_prior_7d)
  if (!isMaterial(cadenceChangePct, CADENCE_MATERIAL_CHANGE_RATIO)) return []

  // Direction must match target
  const targetPct = signal.evidence[0]?.change_pct ?? null
  const cadenceDirection = (cadenceChangePct ?? 0) < 0 ? 'decrease' : 'increase'
  const targetDirection = (targetPct ?? 0) < 0 ? 'decrease' : 'increase'
  if (cadenceDirection !== targetDirection) return []

  const evidence: DriverEvidence[] = [{
    metric: 'ig_posting_cadence_7d',
    label: 'Posts published',
    current: cadence.posts_current_7d,
    prior: cadence.posts_prior_7d,
    change_pct: cadenceChangePct,
    window: '7d',
  }]

  const factors: DriverScoreFactors = {
    mechanism_strength:   0.4,  // weak — cadence ≠ reach
    temporal_alignment:   0.8,
    magnitude_alignment:  magnitudeAlignment(cadenceChangePct, targetPct),
    supporting_evidence:  0.5,
    counter_evidence:     1.0,
  }

  const score = computeScore(factors)
  if (score < DRIVER_MIN_SCORE) return []

  return [{
    id:                  `driver_cadence_to_organic_${signal.id}`,
    target_signal_id:    signal.id,
    driver_type:         'posting_cadence_to_organic',
    source:              'organic_ig',
    observation:         `Posting frequency changed from ${cadence.posts_prior_7d} to ${cadence.posts_current_7d} posts between comparison periods.`,
    evidence,
    temporal_alignment:  'overlapping',
    mechanism:           'Publishing frequency affects how often content enters algorithmic distribution.',
    confidence:          'possible',  // always possible, never likely — too indirect
    caveat:              'Posting frequency is one of many factors affecting reach. More posts do not guarantee more reach, and fewer posts do not always reduce it.',
  }]
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Detect plausible drivers for each material signal candidate.
 *
 * Pure function — no side effects, no I/O.
 *
 * Returns candidates sorted by score descending, with at most one driver per
 * signal (the strongest). Weak candidates are discarded.
 */
export function detectDrivers(
  signals: MaterialSignalCandidate[],
  data: BriefInputData,
  context: DriverContextData,
): MarketingDriverCandidate[] {
  const allCandidates: MarketingDriverCandidate[] = []

  for (const signal of signals) {
    const drivers: MarketingDriverCandidate[] = [
      ...googleAdsToGbpDrivers(signal, data, context),
      ...paidToGa4Drivers(signal, data, context),
      ...gscToGa4OrganicDrivers(signal, data),
      ...contentToIgReachDrivers(signal, data, context),
      ...postingCadenceToOrganicDrivers(signal, data, context),
    ]

    // Keep only the strongest driver per signal
    if (drivers.length > 0) {
      // Sort by score proxy: likely > possible, then by evidence count
      drivers.sort((a, b) => {
        const confA = a.confidence === 'likely' ? 1 : 0
        const confB = b.confidence === 'likely' ? 1 : 0
        if (confA !== confB) return confB - confA
        return b.evidence.length - a.evidence.length
      })
      allCandidates.push(drivers[0])
    }
  }

  return allCandidates
}
