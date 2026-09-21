/**
 * lib/marketing/paid-recs/signals.ts
 *
 * Deterministic signal detection for Paid Recommendations.
 *
 * Pure functions — no I/O, no randomness, no side effects.
 * All thresholds exported for testability.
 *
 * Input:  raw daily rows from the DB pre-split into two 7-day windows
 *         (current = last 7 completed days; prior = the 7 days before that)
 * Output: PaidRecSignal[] — at most one signal per campaign, highest priority first
 *
 * Priority order (highest → lowest):
 *   1. spend_no_results   — urgent: spending with zero return
 *   2. cpr_worsening      — needs investigation
 *   3. strong_performance — good news; may justify scaling
 *   4. cpr_improving      — informational; positive trend
 *
 * Campaigns with no material signal are omitted from output.
 */

import type { MetaCampaignInsightRow, MetaCampaignRow } from '@/lib/marketing/types/meta'
import { googleActionIsPrimary, googleResultLabel } from '@/lib/marketing/paid-performance'
import type { GooglePaidAction, GooglePaidCampaign, GooglePaidDaily } from '@/lib/marketing/paid-performance'
import type { PaidRecSignal, PaidRecSignalType, PaidRecWindow } from './types'

// ─── Exported thresholds ──────────────────────────────────────────────────────

/** Minimum spend in account currency for a 7d window to be considered materially active. */
export const MIN_SPEND_7D = 150

/** Minimum primary results in the prior window to compute a valid CPR comparison. */
export const MIN_RESULTS_PRIOR = 3

/** Fractional CPR change threshold to fire cpr_worsening or cpr_improving. */
export const CPR_CHANGE_THRESHOLD = 0.25

/** Fractional result-count increase threshold to fire strong_performance. */
export const STRONG_PERF_THRESHOLD = 0.30

/** Meta action types that count as a lead for OUTCOME_LEADS campaigns. */
export const LEADS_ACTION_TYPES = ['lead', 'onsite_conversion.lead_grouped']

/** Meta action types that count as a purchase for OUTCOME_SALES campaigns. */
export const PURCHASE_ACTION_TYPES = ['purchase', 'omni_purchase']

// ─── Meta helpers ─────────────────────────────────────────────────────────────

function metaActionSum(rows: MetaCampaignInsightRow[], types: string[]): number {
  return rows.reduce((acc, r) => {
    const hit = r.actions_json?.find(a => types.includes(a.action_type))
    return acc + (hit ? Number(hit.value) : 0)
  }, 0)
}

/**
 * Returns the primary result label and count for a Meta campaign window.
 * Follows the same objective-specific logic as buildMetaPaidCampaigns.
 */
export function metaResultForObjective(
  rows: MetaCampaignInsightRow[],
  objective: string,
): { label: string; count: number } {
  const totalImpressions = rows.reduce((acc, r) => acc + (Number(r.impressions) || 0), 0)

  switch (objective) {
    case 'OUTCOME_LEADS':
      return { label: 'Leads', count: metaActionSum(rows, LEADS_ACTION_TYPES) }
    case 'OUTCOME_SALES':
      return { label: 'Purchases', count: metaActionSum(rows, PURCHASE_ACTION_TYPES) }
    case 'OUTCOME_TRAFFIC': {
      const linkClicks = metaActionSum(rows, ['link_click'])
      const lpv = metaActionSum(rows, ['landing_page_view', 'omni_landing_page_view'])
      const useLPV = linkClicks > 0 && lpv > 0 && lpv / linkClicks > 0.1
      return useLPV
        ? { label: 'Landing page views', count: lpv }
        : { label: 'Link clicks', count: linkClicks }
    }
    case 'OUTCOME_ENGAGEMENT':
      return { label: 'Post engagements', count: metaActionSum(rows, ['post_engagement']) }
    case 'OUTCOME_AWARENESS':
    default:
      return { label: 'Impressions', count: totalImpressions }
  }
}

/** Compute CPR or CPM depending on objective. null when count = 0. */
function metaCpr(spend: number, count: number, objective: string): number | null {
  if (count === 0) return null
  // Awareness: CPM (cost per 1000 impressions)
  if (objective === 'OUTCOME_AWARENESS') return (spend / count) * 1000
  return spend / count
}

function metaWindow(rows: MetaCampaignInsightRow[], objective: string): PaidRecWindow {
  const spend = rows.reduce((acc, r) => acc + (Number(r.spend) || 0), 0)
  const { count } = metaResultForObjective(rows, objective)
  return { spend, result_count: count, cpr: metaCpr(spend, count, objective) }
}

// ─── Google helpers ───────────────────────────────────────────────────────────

function googleWindow(
  rows: GooglePaidDaily[],
  campaign: GooglePaidCampaign,
  actions: GooglePaidAction[],
): { window: PaidRecWindow; label: string } {
  const eligible = actions.filter(a => a.customer_id === campaign.customer_id && googleActionIsPrimary(campaign, a))
  const eligibleIds = new Set(eligible.map(a => a.resource_name))

  let spendMicros = BigInt(0)
  let resultCount = 0
  const labels = new Set<string>()

  for (const row of rows) {
    spendMicros += BigInt(Math.round(Number(row.cost_micros)))
    for (const cr of (row.conversion_results ?? [])) {
      if (!eligibleIds.has(cr.action_resource_name)) continue
      resultCount += Number(cr.conversions)
      labels.add(googleResultLabel(cr.category, cr.action_name))
    }
  }

  const spend = Number(spendMicros) / 1_000_000
  const label = labels.size === 1
    ? [...labels][0]
    : eligible.length > 0
      ? googleResultLabel(eligible[0].category, eligible[0].name)
      : 'Conversions'

  const cpr = resultCount > 0 ? spend / resultCount : null
  return { window: { spend, result_count: resultCount, cpr }, label }
}

// ─── Signal type selection ────────────────────────────────────────────────────

/**
 * Determines the highest-priority signal for a campaign window pair.
 * Returns null if no material signal is present.
 */
export function pickSignalType(
  current: PaidRecWindow,
  prior: PaidRecWindow | null,
): { signal: PaidRecSignalType; change_pct: number | null } | null {
  if (current.spend < MIN_SPEND_7D) return null

  // 1. spend_no_results — spending with zero primary results
  if (current.result_count === 0) {
    return { signal: 'spend_no_results', change_pct: null }
  }

  // CPR worsening (second priority after spend_no_results)
  if (prior !== null && prior.cpr !== null && current.cpr !== null && prior.result_count >= MIN_RESULTS_PRIOR) {
    const changePct = (current.cpr - prior.cpr) / prior.cpr
    if (changePct > CPR_CHANGE_THRESHOLD) {
      return { signal: 'cpr_worsening', change_pct: changePct }
    }
  }

  // 3. strong_performance — result count significantly up (checked before cpr_improving
  //    so that combined "more results AND cheaper" is headlined as strong_performance)
  if (prior !== null && prior.result_count >= MIN_RESULTS_PRIOR) {
    const resultChangePct = (current.result_count - prior.result_count) / prior.result_count
    if (resultChangePct >= STRONG_PERF_THRESHOLD) {
      return { signal: 'strong_performance', change_pct: resultChangePct }
    }
  }

  // 4. cpr_improving — efficiency up but no other dominant signal
  if (prior !== null && prior.cpr !== null && current.cpr !== null && prior.result_count >= MIN_RESULTS_PRIOR) {
    const changePct = (current.cpr - prior.cpr) / prior.cpr
    if (changePct < -CPR_CHANGE_THRESHOLD) {
      return { signal: 'cpr_improving', change_pct: changePct }
    }
  }

  return null
}

// ─── Per-platform signal builders ─────────────────────────────────────────────

/** Input shape expected from the generate.ts orchestrator for one Meta campaign. */
export interface MetaCampaignInput {
  campaign: MetaCampaignRow & { currency: string }
  currentRows: MetaCampaignInsightRow[]
  priorRows: MetaCampaignInsightRow[]
}

export function buildMetaSignals(inputs: MetaCampaignInput[]): PaidRecSignal[] {
  const signals: PaidRecSignal[] = []

  for (const { campaign, currentRows, priorRows } of inputs) {
    // Skip ZZ-prefixed campaigns (archived/test)
    if (campaign.name.toUpperCase().startsWith('ZZ ')) continue

    const objective = campaign.objective ?? 'OUTCOME_AWARENESS'
    const current = metaWindow(currentRows, objective)
    const prior = priorRows.length > 0 ? metaWindow(priorRows, objective) : null
    const picked = pickSignalType(current, prior)
    if (!picked) continue

    const { label } = metaResultForObjective(currentRows, objective)
    signals.push({
      platform: 'meta',
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      objective,
      signal_type: picked.signal,
      currency: campaign.currency,
      result_label: label,
      current,
      prior,
      change_pct: picked.change_pct,
    })
  }

  return signals
}

/** Input shape expected from the generate.ts orchestrator for one Google campaign. */
export interface GoogleCampaignInput {
  campaign: GooglePaidCampaign & { currency: string }
  actions: GooglePaidAction[]
  currentRows: GooglePaidDaily[]
  priorRows: GooglePaidDaily[]
}

export function buildGoogleSignals(inputs: GoogleCampaignInput[]): PaidRecSignal[] {
  const signals: PaidRecSignal[] = []

  for (const { campaign, actions, currentRows, priorRows } of inputs) {
    const { window: current, label } = googleWindow(currentRows, campaign, actions)
    const priorResult = priorRows.length > 0 ? googleWindow(priorRows, campaign, actions) : null
    const prior = priorResult?.window ?? null
    const picked = pickSignalType(current, prior)
    if (!picked) continue

    signals.push({
      platform: 'google',
      campaign_id: `${campaign.customer_id}:${campaign.campaign_id}`,
      campaign_name: campaign.name,
      objective: campaign.channel_type,
      signal_type: picked.signal,
      currency: campaign.currency,
      result_label: label,
      current,
      prior,
      change_pct: picked.change_pct,
    })
  }

  return signals
}

// ─── Main export ──────────────────────────────────────────────────────────────

/** Maximum number of signals to send to the AI (cap for prompt size). */
export const MAX_SIGNALS_FOR_AI = 5

/**
 * Signal priority order for ranking before the AI call.
 * Lower index = higher priority.
 */
const SIGNAL_PRIORITY: Record<PaidRecSignalType, number> = {
  spend_no_results:    0,
  cpr_worsening:       1,
  strong_performance:  2,
  cpr_improving:       3,
}

/**
 * Combines Meta and Google signals, sorts by priority, and caps at MAX_SIGNALS_FOR_AI.
 * Pure: same inputs always yield same output.
 */
export function rankSignals(meta: PaidRecSignal[], google: PaidRecSignal[]): PaidRecSignal[] {
  return [...meta, ...google]
    .sort((a, b) => SIGNAL_PRIORITY[a.signal_type] - SIGNAL_PRIORITY[b.signal_type])
    .slice(0, MAX_SIGNALS_FOR_AI)
}
