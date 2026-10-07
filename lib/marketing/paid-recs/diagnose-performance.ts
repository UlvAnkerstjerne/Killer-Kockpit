/**
 * lib/marketing/paid-recs/diagnose-performance.ts
 *
 * Deterministic performance diagnostic for Meta paid campaigns.
 * Compares current 7-day vs prior 7-day at campaign, ad-set, and ad level.
 *
 * Pure diagnosis — no mutations, no AI calls, no side effects.
 * All thresholds are exported constants for testability.
 *
 * Classifications:
 *   weak_ad              — one ad materially worse than active siblings
 *   weak_adset           — one ad set dragging while others are healthy
 *   broad_deterioration  — performance dropped across entire campaign
 *   tracking_suspected   — funnel evidence suggests conversion tracking issue
 *   landing_page_issue   — traffic exists but zero/near-zero conversion
 *   insufficient_evidence — not enough data to diagnose
 */

import type { MetaInsightActionItem } from '@/lib/marketing/types/meta'
import type {
  AdDiagnostic, AdSetDiagnostic, DiagnosisClassification, PerformanceDiagnosis,
} from './types'
import { LEADS_ACTION_TYPES, PURCHASE_ACTION_TYPES } from './signals'

// ─── Volume guards (exported for tests) ────────────────────────────────────

/** Minimum spend in currency for an ad to be considered for weakness comparison. */
export const MIN_AD_SPEND = 50

/** Minimum impressions for an ad to have meaningful CTR evidence. */
export const MIN_AD_IMPRESSIONS = 200

/** Minimum clicks for conversion rate evidence. */
export const MIN_AD_CLICKS = 10

/** An ad's CPL must be this multiple of sibling median to be classified weak. */
export const WEAK_AD_CPL_RATIO = 1.8

/** An ad's CTR must be below this fraction of sibling median to support weakness. */
export const WEAK_AD_CTR_RATIO = 0.6

/** Minimum active sibling ads remaining after pausing the weak ad. */
export const MIN_REMAINING_ADS = 1

/** Minimum active sibling ad sets remaining after pausing the weak ad set. */
export const MIN_REMAINING_ADSETS = 1

/** An ad set's CPL must be this multiple of sibling median to be classified weak. */
export const WEAK_ADSET_CPL_RATIO = 1.8

// ─── Ad insight row shape (from meta_ad_insights table) ────────────────────

export interface AdInsightRow {
  ad_id: string
  date_start: string
  impressions: number | null
  reach: number | null
  clicks: number | null
  inline_link_clicks: number | null
  spend: string | null
  cpm: string | null
  cpc: string | null
  ctr: string | null
  actions_json: MetaInsightActionItem[] | null
  cost_per_action_json: MetaInsightActionItem[] | null
  action_values_json: MetaInsightActionItem[] | null
}

export interface MetaAdWithSet {
  id: string
  ad_set_id: string
  name: string
  status: string
}

export interface MetaAdSetInfo {
  id: string
  campaign_id: string
  name: string
  status: string
  daily_budget: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function actionSum(rows: AdInsightRow[], types: string[]): number {
  return rows.reduce((acc, r) => {
    const hit = r.actions_json?.find(a => types.includes(a.action_type))
    return acc + (hit ? Number(hit.value) : 0)
  }, 0)
}

function resultCount(rows: AdInsightRow[], objective: string): number {
  switch (objective) {
    case 'OUTCOME_LEADS': return actionSum(rows, LEADS_ACTION_TYPES)
    case 'OUTCOME_SALES': return actionSum(rows, PURCHASE_ACTION_TYPES)
    default: return actionSum(rows, LEADS_ACTION_TYPES) || rows.reduce((a, r) => a + (Number(r.clicks) || 0), 0)
  }
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── Main diagnostic ────────────────────────────────────────────────────────

export interface DiagnosticInput {
  campaignId: string
  campaignName: string
  adAccountId: string
  objective: string
  currency: string
  dailyBudget: number | null
  ads: MetaAdWithSet[]
  adSets: MetaAdSetInfo[]
  currentAdInsights: AdInsightRow[]  // last 7 days
  priorAdInsights: AdInsightRow[]    // previous 7 days
}

export function diagnosePerformance(input: DiagnosticInput): PerformanceDiagnosis {
  const { campaignId, campaignName, objective, ads, adSets, currentAdInsights, priorAdInsights } = input

  // Build ad-level diagnostics
  const currentByAd = groupBy(currentAdInsights, r => r.ad_id)
  const priorByAd = groupBy(priorAdInsights, r => r.ad_id)

  const activeAds = ads.filter(a => a.status === 'ACTIVE')
  const adDiags: AdDiagnostic[] = activeAds.map(ad => {
    const cur = currentByAd.get(ad.id) ?? []
    const pri = priorByAd.get(ad.id) ?? []
    const spend = cur.reduce((a, r) => a + (Number(r.spend) || 0), 0)
    const impressions = cur.reduce((a, r) => a + (Number(r.impressions) || 0), 0)
    const reach = cur.reduce((a, r) => a + (Number(r.reach) || 0), 0)
    const clicks = cur.reduce((a, r) => a + (Number(r.clicks) || 0), 0)
    const results = resultCount(cur, objective)
    const priorResults = resultCount(pri, objective)
    const priorSpend = pri.reduce((a, r) => a + (Number(r.spend) || 0), 0)

    return {
      ad_id: ad.id,
      ad_name: ad.name,
      ad_set_id: ad.ad_set_id,
      status: ad.status,
      spend_current: spend,
      spend_prior: priorSpend,
      impressions_current: impressions,
      reach_current: reach,
      clicks_current: clicks,
      ctr_current: impressions > 0 ? clicks / impressions : null,
      cpc_current: clicks > 0 ? spend / clicks : null,
      results_current: results,
      cpl_current: results > 0 ? spend / results : null,
      results_prior: priorResults,
      cpl_prior: priorResults > 0 ? priorSpend / priorResults : null,
      frequency_current: reach > 0 ? impressions / reach : null,
      is_weak: false, // will be set below
    }
  })

  // Group ads into ad sets
  const activeAdSets = adSets.filter(as => as.status === 'ACTIVE')
  const adSetDiags: AdSetDiagnostic[] = activeAdSets.map(adSet => {
    const setAds = adDiags.filter(a => a.ad_set_id === adSet.id)
    const spend = setAds.reduce((a, d) => a + d.spend_current, 0)
    const results = setAds.reduce((a, d) => a + d.results_current, 0)
    const priorResults = setAds.reduce((a, d) => a + d.results_prior, 0)
    const priorSpend = setAds.reduce((a, d) => a + d.spend_prior, 0)
    return {
      adset_id: adSet.id,
      adset_name: adSet.name,
      status: adSet.status,
      spend_current: spend,
      results_current: results,
      cpl_current: results > 0 ? spend / results : null,
      results_prior: priorResults,
      cpl_prior: priorResults > 0 ? priorSpend / priorResults : null,
      active_ad_count: setAds.length,
      is_weak: false,
      ads: setAds,
    }
  })

  // ── Step 1: Identify weak ad ──
  const measurableAds = adDiags.filter(a => a.spend_current >= MIN_AD_SPEND && a.impressions_current >= MIN_AD_IMPRESSIONS)
  const adsWithResults = measurableAds.filter(a => a.cpl_current !== null)
  const adsWithoutResults = measurableAds.filter(a => a.results_current === 0 && a.spend_current >= MIN_AD_SPEND)

  let weakAd: AdDiagnostic | undefined
  if (adsWithResults.length >= 2) {
    const cpls = adsWithResults.map(a => a.cpl_current!)
    const medianCpl = median(cpls)
    if (medianCpl !== null && medianCpl > 0) {
      const worst = adsWithResults.reduce((prev, cur) => (cur.cpl_current! > prev.cpl_current!) ? cur : prev)
      const healthyCount = adsWithResults.filter(a => a.ad_id !== worst.ad_id).length
      if (worst.cpl_current! >= medianCpl * WEAK_AD_CPL_RATIO && healthyCount >= MIN_REMAINING_ADS) {
        worst.is_weak = true
        weakAd = worst
      }
    }
  } else if (adsWithoutResults.length > 0) {
    // Ad spending with zero results while siblings have results
    const healthyAds = adDiags.filter(a => a.results_current > 0)
    if (healthyAds.length >= MIN_REMAINING_ADS) {
      const worst = adsWithoutResults.reduce((prev, cur) => cur.spend_current > prev.spend_current ? cur : prev)
      worst.is_weak = true
      weakAd = worst
    }
  }

  // ── Step 2: Identify weak ad set ──
  let weakAdSet: AdSetDiagnostic | undefined
  const measurableAdSets = adSetDiags.filter(as => as.spend_current >= MIN_AD_SPEND)
  const adSetsWithResults = measurableAdSets.filter(as => as.cpl_current !== null)
  if (adSetsWithResults.length >= 2) {
    const cpls = adSetsWithResults.map(as => as.cpl_current!)
    const medianCpl = median(cpls)
    if (medianCpl !== null && medianCpl > 0) {
      const worst = adSetsWithResults.reduce((prev, cur) => (cur.cpl_current! > prev.cpl_current!) ? cur : prev)
      const healthyCount = adSetsWithResults.filter(as => as.adset_id !== worst.adset_id).length
      if (worst.cpl_current! >= medianCpl * WEAK_ADSET_CPL_RATIO && healthyCount >= MIN_REMAINING_ADSETS) {
        worst.is_weak = true
        weakAdSet = worst
      }
    }
  }

  // ── Step 3: Classify ──
  let classification: DiagnosisClassification
  let evidenceSummary: string
  const totalCurrentResults = adDiags.reduce((a, d) => a + d.results_current, 0)
  const totalCurrentClicks = adDiags.reduce((a, d) => a + d.clicks_current, 0)
  const totalCurrentSpend = adDiags.reduce((a, d) => a + d.spend_current, 0)
  const healthySiblings = adDiags.filter(a => !a.is_weak && a.results_current > 0).length

  if (measurableAds.length === 0) {
    classification = 'insufficient_evidence'
    evidenceSummary = 'Not enough measured ad data to perform a diagnostic.'
  } else if (totalCurrentClicks > MIN_AD_CLICKS && totalCurrentResults === 0 && totalCurrentSpend >= MIN_AD_SPEND) {
    // Traffic exists but zero conversions — tracking or landing page
    classification = 'tracking_suspected'
    evidenceSummary = `Campaign has ${totalCurrentClicks} clicks and ${totalCurrentSpend.toFixed(0)} ${input.currency} spend but zero results. Tracking or landing page issue suspected.`
  } else if (weakAd) {
    classification = 'weak_ad'
    const ratio = weakAd.cpl_current !== null && median(adsWithResults.filter(a => a.ad_id !== weakAd!.ad_id).map(a => a.cpl_current!)) !== null
      ? `${(weakAd.cpl_current / median(adsWithResults.filter(a => a.ad_id !== weakAd!.ad_id).map(a => a.cpl_current!))!).toFixed(1)}×`
      : ''
    evidenceSummary = weakAd.cpl_current !== null
      ? `Ad "${weakAd.ad_name}" has ${ratio} the CPL of active siblings. ${healthySiblings} healthy ad${healthySiblings !== 1 ? 's' : ''} remain.`
      : `Ad "${weakAd.ad_name}" spent ${weakAd.spend_current.toFixed(0)} ${input.currency} with zero results while ${healthySiblings} sibling ad${healthySiblings !== 1 ? 's' : ''} produced results.`
  } else if (weakAdSet) {
    classification = 'weak_adset'
    const siblingCpls = adSetsWithResults.filter(as => as.adset_id !== weakAdSet!.adset_id).map(as => as.cpl_current!)
    const ratio = weakAdSet.cpl_current !== null && median(siblingCpls) !== null
      ? `${(weakAdSet.cpl_current / median(siblingCpls)!).toFixed(1)}×`
      : ''
    evidenceSummary = `Ad set "${weakAdSet.adset_name}" has ${ratio} the CPL of active siblings.`
  } else {
    classification = 'broad_deterioration'
    evidenceSummary = `Performance deteriorated across the campaign without a clearly isolated weak ad or ad set. Total spend: ${totalCurrentSpend.toFixed(0)} ${input.currency}, total results: ${totalCurrentResults}.`
  }

  return {
    campaign_id: campaignId,
    campaign_name: campaignName,
    classification,
    evidence_summary: evidenceSummary,
    ad_sets: adSetDiags,
    weak_ad: weakAd,
    weak_adset: weakAdSet,
    healthy_sibling_count: healthySiblings,
  }
}

// ─── Build remediation actions from diagnosis ────────────────────────────────

import type { PaidRecExecutionPlan, PaidRemediationPlan } from './types'
import { MAX_AUTOMATED_BUDGET_CHANGE } from './guardrails'

export function buildRemediationPlan(
  diagnosis: PerformanceDiagnosis,
  campaign: { id: string; adAccountId: string; currency: string; dailyBudget: number | null },
): PaidRemediationPlan {
  const actions: PaidRecExecutionPlan[] = []
  let monitoringDays = 5
  let expectedOutcome: string
  let fallback: string | null = null

  switch (diagnosis.classification) {
    case 'weak_ad': {
      const ad = diagnosis.weak_ad!
      actions.push({
        action_type: 'meta_pause_ad',
        platform: 'meta',
        target_type: 'ad',
        target_id: ad.ad_id,
        ad_account_id: campaign.adAccountId,
        ad_name: ad.ad_name,
        expected_current_status: 'ACTIVE',
      })
      expectedOutcome = `Pausing the weak ad should reduce wasted spend. Monitor the remaining ${diagnosis.healthy_sibling_count} active ad${diagnosis.healthy_sibling_count !== 1 ? 's' : ''} for five days.`
      fallback = 'If CPL does not improve after five days, consider refreshing creative or reviewing the campaign structure.'
      break
    }
    case 'weak_adset': {
      const adSet = diagnosis.weak_adset!
      actions.push({
        action_type: 'meta_pause_adset',
        platform: 'meta',
        target_type: 'adset',
        target_id: adSet.adset_id,
        campaign_id: campaign.id,
        ad_account_id: campaign.adAccountId,
        adset_name: adSet.adset_name,
        expected_current_status: 'ACTIVE',
      })
      expectedOutcome = 'Pausing the weak ad set should concentrate spend on healthier ad sets.'
      fallback = 'If no improvement after five days, consider a broader campaign review.'
      break
    }
    case 'broad_deterioration': {
      if (campaign.dailyBudget && campaign.dailyBudget > 0) {
        const reduction = Math.round(campaign.dailyBudget * (1 - MAX_AUTOMATED_BUDGET_CHANGE))
        actions.push({
          action_type: 'meta_set_campaign_budget',
          platform: 'meta',
          target_type: 'campaign',
          target_id: campaign.id,
          ad_account_id: campaign.adAccountId,
          currency: campaign.currency,
          current_daily_budget: campaign.dailyBudget,
          target_daily_budget: reduction,
        })
        expectedOutcome = `Reduce daily budget from ${campaign.dailyBudget} to ${reduction} ${campaign.currency} (${Math.round(MAX_AUTOMATED_BUDGET_CHANGE * 100)}% reduction) while monitoring for five days.`
      } else {
        // Cannot adjust budget — manual action required
        actions.push({
          action_type: 'manual_action_required',
          platform: 'meta',
          campaign_id: campaign.id,
          reason: 'Performance deteriorated broadly but daily budget is unavailable for automated adjustment.',
        })
        expectedOutcome = 'Manual budget review required.'
      }
      fallback = 'If CPL continues to worsen, consider pausing the campaign or refreshing all creative.'
      break
    }
    case 'tracking_suspected': {
      actions.push({
        action_type: 'run_tracking_diagnostic',
        platform: 'meta',
        campaign_id: campaign.id,
      })
      expectedOutcome = 'Run tracking diagnostic to identify the conversion funnel break point.'
      fallback = 'Manual tracking investigation required if diagnostic is inconclusive.'
      break
    }
    case 'landing_page_issue':
    case 'insufficient_evidence': {
      actions.push({
        action_type: 'manual_action_required',
        platform: 'meta',
        campaign_id: campaign.id,
        reason: diagnosis.classification === 'landing_page_issue'
          ? 'Landing page or lead form performance requires a change Kockpit cannot safely perform yet.'
          : 'Insufficient evidence for an automated remediation.',
      })
      expectedOutcome = 'Manual investigation required.'
      break
    }
  }

  return {
    version: 'v2',
    diagnosis,
    actions,
    monitoring_days: monitoringDays,
    expected_outcome: expectedOutcome,
    fallback,
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const arr = map.get(k) ?? []
    arr.push(item)
    map.set(k, arr)
  }
  return map
}
