/**
 * lib/marketing/paid-recs/generate.ts
 *
 * Orchestrator for Paid Recommendation generation.
 * Called by the API route after Meta + Google Ads syncs complete.
 *
 * v2 pipeline for Meta cpr_worsening and spend_no_results:
 *   1. Compute date windows
 *   2. Load campaigns + campaign-level insights → detect signals
 *   3. For Meta signals needing diagnosis: load ad sets, ads, ad insights
 *   4. Run deterministic diagnosis → build remediation plan
 *   5. Call Claude with signals + prepared remediation context
 *   6. Persist recommendations with v2 remediation plan
 *
 * Security: all DB access uses createServiceClient (service_role).
 */

import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import type { MetaAdRow, MetaAdSetRow, MetaCampaignInsightRow, MetaCampaignRow } from '@/lib/marketing/types/meta'
import type { GooglePaidAction, GooglePaidCampaign, GooglePaidDaily } from '@/lib/marketing/paid-performance'
import {
  buildMetaSignals,
  buildGoogleSignals,
  rankSignals,
  type MetaCampaignInput,
  type GoogleCampaignInput,
} from './signals'
import { callPaidRecommendationsAI, PAID_REC_PROMPT_VERSION } from '@/lib/ai/paid-recommendations'
import type { PaidRecSignal, PaidRemediationPlan } from './types'
import { compileExecutionPlan, type SyncedTarget, type ConfiguredAccounts } from './compile-plan'
import { GOOGLE_ADS_CUSTOMER_ID } from '@/lib/google/ads-sync'
import { diagnosePerformance, buildRemediationPlan, type AdInsightRow, type MetaAdWithSet, type MetaAdSetInfo, type RemediationCampaignContext } from './diagnose-performance'

// ─── Date ranges ──────────────────────────────────────────────────────────────

interface RecDateRanges {
  current: { start: string; end: string }
  prior:   { start: string; end: string }
}

function recDateRanges(now = new Date()): RecDateRanges {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(now)
  const shift = (days: number): string => {
    const d = new Date(`${today}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString().slice(0, 10)
  }
  return {
    current: { start: shift(7),  end: shift(1) },
    prior:   { start: shift(14), end: shift(8) },
  }
}

// ─── Pagination helper ────────────────────────────────────────────────────────

type Db = ReturnType<typeof createServiceClient>
type PageResponse = { data: unknown[] | null; error: unknown }

async function readPages<T>(query: (offset: number) => PromiseLike<PageResponse>): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const { data, error } = await query(rows.length)
    if (error) throw new Error('Generate: DB query failed')
    if (!data?.length) return rows
    rows.push(...data as T[])
  }
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

async function loadMetaData(db: Db, ranges: RecDateRanges): Promise<MetaCampaignInput[]> {
  const [campaigns, accounts, insights] = await Promise.all([
    readPages<MetaCampaignRow>(offset =>
      db.from('meta_ad_campaigns')
        .select('id,ad_account_id,name,status,objective,daily_budget,lifetime_budget,created_at_meta,synced_at')
        .eq('status', 'ACTIVE')
        .order('id').range(offset, offset + 499)
    ),
    readPages<{ id: string; currency: string }>(offset =>
      db.from('meta_ad_accounts')
        .select('id,currency')
        .order('id').range(offset, offset + 499)
    ),
    readPages<MetaCampaignInsightRow>(offset =>
      db.from('meta_campaign_insights')
        .select('campaign_id,date_start,impressions,reach,clicks,inline_link_clicks,spend,cpm,cpc,ctr,frequency,actions_json,cost_per_action_json,action_values_json')
        .gte('date_start', ranges.prior.start)
        .lte('date_start', ranges.current.end)
        .order('date_start').order('campaign_id').range(offset, offset + 999)
    ),
  ])

  const currencyById = new Map(accounts.map(a => [a.id, a.currency]))

  const currentByCampaign = new Map<string, MetaCampaignInsightRow[]>()
  const priorByCampaign   = new Map<string, MetaCampaignInsightRow[]>()
  for (const row of insights) {
    const isCurrent = row.date_start >= ranges.current.start && row.date_start <= ranges.current.end
    const isPrior   = row.date_start >= ranges.prior.start   && row.date_start <= ranges.prior.end
    if (isCurrent) {
      const arr = currentByCampaign.get(row.campaign_id) ?? []
      arr.push(row); currentByCampaign.set(row.campaign_id, arr)
    }
    if (isPrior) {
      const arr = priorByCampaign.get(row.campaign_id) ?? []
      arr.push(row); priorByCampaign.set(row.campaign_id, arr)
    }
  }

  return campaigns
    .filter(c => !c.name.toUpperCase().startsWith('ZZ '))
    .map(c => ({
      campaign: { ...c, currency: currencyById.get(c.ad_account_id) ?? 'DKK' },
      currentRows: currentByCampaign.get(c.id) ?? [],
      priorRows:   priorByCampaign.get(c.id)   ?? [],
    }))
}

async function loadGoogleData(db: Db, ranges: RecDateRanges): Promise<GoogleCampaignInput[]> {
  const [campaigns, accounts, actions, daily] = await Promise.all([
    readPages<GooglePaidCampaign>(offset =>
      db.from('google_ads_campaigns')
        .select('customer_id,campaign_id,name,status,channel_type,channel_sub_type,bidding_strategy_type,goal_config_level,conversion_goals,custom_conversion_goal,budget_resource_name,daily_budget_micros,budget_explicitly_shared,synced_at')
        .eq('status', 'ENABLED')
        .order('customer_id').order('campaign_id').range(offset, offset + 499)
    ),
    readPages<{ customer_id: string; currency_code: string }>(offset =>
      db.from('google_ads_accounts')
        .select('customer_id,currency_code')
        .order('customer_id').range(offset, offset + 499)
    ),
    readPages<GooglePaidAction>(offset =>
      db.from('google_ads_conversion_actions')
        .select('customer_id,resource_name,name,category,origin,primary_for_goal,status,type')
        .order('customer_id').order('resource_name').range(offset, offset + 499)
    ),
    readPages<GooglePaidDaily>(offset =>
      db.from('google_ads_campaign_daily')
        .select('customer_id,campaign_id,date,cost_micros,impressions,clicks,conversions,all_conversions,conversion_results')
        .gte('date', ranges.prior.start)
        .lte('date', ranges.current.end)
        .order('date').order('customer_id').order('campaign_id').range(offset, offset + 999)
    ),
  ])

  const currencyByAccount = new Map(accounts.map(a => [a.customer_id, a.currency_code]))

  const currentByCampaign = new Map<string, GooglePaidDaily[]>()
  const priorByCampaign   = new Map<string, GooglePaidDaily[]>()
  for (const row of daily) {
    const key = `${row.customer_id}:${row.campaign_id}`
    const isCurrent = row.date >= ranges.current.start && row.date <= ranges.current.end
    const isPrior   = row.date >= ranges.prior.start   && row.date <= ranges.prior.end
    if (isCurrent) {
      const arr = currentByCampaign.get(key) ?? []
      arr.push(row); currentByCampaign.set(key, arr)
    }
    if (isPrior) {
      const arr = priorByCampaign.get(key) ?? []
      arr.push(row); priorByCampaign.set(key, arr)
    }
  }

  return campaigns.map(c => {
    const key = `${c.customer_id}:${c.campaign_id}`
    return {
      campaign: { ...c, currency: currencyByAccount.get(c.customer_id) ?? 'DKK' },
      actions,
      currentRows: currentByCampaign.get(key) ?? [],
      priorRows:   priorByCampaign.get(key)   ?? [],
    }
  })
}

// ─── V2 diagnostic data loader ──────────────────────────────────────────────

/** Loads ad sets, ads, and ad-level insights for a Meta campaign. */
async function loadMetaDiagnosticData(
  db: Db,
  campaignId: string,
  ranges: RecDateRanges,
): Promise<{ adSets: MetaAdSetInfo[]; ads: MetaAdWithSet[]; currentAdInsights: AdInsightRow[]; priorAdInsights: AdInsightRow[] }> {
  const [adSets, ads] = await Promise.all([
    readPages<MetaAdSetRow>(offset =>
      db.from('meta_ad_sets')
        .select('id,campaign_id,name,status,daily_budget')
        .eq('campaign_id', campaignId)
        .order('id').range(offset, offset + 499)
    ),
    readPages<MetaAdRow>(offset =>
      db.from('meta_ads')
        .select('id,ad_set_id,name,status')
        .order('id').range(offset, offset + 499)
    ),
  ])

  // Filter ads to those belonging to this campaign's ad sets
  const adSetIds = new Set(adSets.map(as => as.id))
  const campaignAds = ads.filter(a => adSetIds.has(a.ad_set_id))
  const adIds = campaignAds.map(a => a.id)

  if (adIds.length === 0) {
    return { adSets, ads: campaignAds, currentAdInsights: [], priorAdInsights: [] }
  }

  const adInsights = await readPages<AdInsightRow>(offset =>
    db.from('meta_ad_insights')
      .select('ad_id,date_start,impressions,reach,clicks,inline_link_clicks,spend,cpm,cpc,ctr,actions_json,cost_per_action_json,action_values_json')
      .in('ad_id', adIds)
      .gte('date_start', ranges.prior.start)
      .lte('date_start', ranges.current.end)
      .order('date_start').order('ad_id').range(offset, offset + 999)
  )

  const currentAdInsights = adInsights.filter(r => r.date_start >= ranges.current.start && r.date_start <= ranges.current.end)
  const priorAdInsights = adInsights.filter(r => r.date_start >= ranges.prior.start && r.date_start <= ranges.prior.end)

  return {
    adSets: adSets.map(as => ({ id: as.id, campaign_id: as.campaign_id, name: as.name, status: as.status, daily_budget: as.daily_budget })),
    ads: campaignAds.map(a => ({ id: a.id, ad_set_id: a.ad_set_id, name: a.name, status: a.status })),
    currentAdInsights,
    priorAdInsights,
  }
}

// ─── DB writes ────────────────────────────────────────────────────────────────

async function clearStaleReviews(db: Db, campaignKeys: Set<string>): Promise<void> {
  if (campaignKeys.size === 0) return
  const campaignIds = [...campaignKeys].map(k => k.split(':')[1])
  const { error } = await db
    .from('paid_recommendations')
    .delete()
    .eq('status', 'needs_review')
    .in('campaign_id', campaignIds)
  if (error) throw new Error(`Failed to clear stale review records: ${error.message}`)
}

async function insertRecommendations(
  db: Db,
  signals: PaidRecSignal[],
  aiResult: Awaited<ReturnType<typeof callPaidRecommendationsAI>>,
  model: string,
  generatedAt: string,
  targets: Map<string, SyncedTarget>,
  configuredAccounts: ConfiguredAccounts,
  remediationPlans: Map<string, PaidRemediationPlan>,
): Promise<void> {
  if (!aiResult.ok) return

  const signalByCampaignId = new Map(signals.map(s => [s.campaign_id, s]))
  const rows = aiResult.output.recommendations.map(rec => {
    const signal = signalByCampaignId.get(rec.campaign_id)
    const key = `${rec.platform}:${rec.campaign_id}`
    const v2Plan = remediationPlans.get(key)

    // V2: use remediation plan if available. V1 fallback: compile from AI intent.
    let executionPlan: unknown = null
    let executionPlanVersion: string | null = null
    let executionType: string | null = null

    if (v2Plan) {
      // Store the full v2 plan in execution_plan JSONB
      executionPlan = v2Plan
      executionPlanVersion = 'v2'
      // Determine execution type from the plan's actions
      const hasManual = v2Plan.actions.some(a => a.action_type === 'manual_action_required')
      const hasMutation = v2Plan.actions.some(a =>
        !['manual_action_required', 'monitor_only', 'run_tracking_diagnostic', 'create_task'].includes(a.action_type)
      )
      const hasDiag = v2Plan.actions.some(a => a.action_type === 'run_tracking_diagnostic')
      if (hasManual) executionType = null // no automated execution
      else if (hasMutation) executionType = 'platform_action'
      else if (hasDiag) executionType = 'create_task' // diagnostic may create task
      else executionType = 'monitor'
    } else {
      // V1 fallback for non-diagnostic signals (Google, cpr_improving, etc.)
      const compiled = rec.action_intent ? compileExecutionPlan(rec.action_intent, targets.get(key) ?? {
        platform: rec.platform, campaignId: '', accountId: '', status: '', currency: '',
      }, configuredAccounts) : { ok: false as const, reason: 'No structured action intent.' }
      if (compiled.ok) {
        executionPlan = compiled.plan
        executionPlanVersion = 'v1'
        executionType = ['create_task', 'run_tracking_diagnostic'].includes(compiled.plan.action_type) ? 'create_task'
          : compiled.plan.action_type === 'monitor_only' ? 'monitor' : 'platform_action'
      }
    }

    return {
      platform:              rec.platform,
      campaign_id:           rec.campaign_id,
      campaign_name:         signal?.campaign_name ?? '',
      signal_type:           signal?.signal_type ?? 'spend_no_results',
      spend_7d:              signal?.current.spend           ?? null,
      currency:              signal?.currency                ?? null,
      result_label:          signal?.result_label            ?? null,
      result_count_7d:       signal?.current.result_count    ?? null,
      cpr_7d:                signal?.current.cpr             ?? null,
      spend_prior_7d:        signal?.prior?.spend            ?? null,
      result_count_prior_7d: signal?.prior?.result_count     ?? null,
      cpr_prior_7d:          signal?.prior?.cpr              ?? null,
      change_pct:            signal?.change_pct              ?? null,
      what_changed:          rec.what_changed,
      evidence:              rec.evidence,
      interpretation:        rec.interpretation,
      recommended_action:    rec.recommended_action,
      urgency:               rec.urgency,
      status:                'needs_review' as const,
      execution_type:        executionType,
      execution_plan:        executionPlan,
      execution_plan_version: executionPlanVersion,
      execution_status:      'pending_approval' as const,
      ai_model:              model,
      prompt_version:        PAID_REC_PROMPT_VERSION,
      generated_at:          generatedAt,
    }
  })

  if (rows.length === 0) return

  const { error } = await db.from('paid_recommendations').insert(rows)
  if (error) throw new Error(`Failed to insert recommendations: ${error.message}`)
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface GenerateResult {
  ok: boolean
  signalCount: number
  recommendationCount: number
  skipped: boolean
  error?: string
}

export async function generatePaidRecommendations(now = new Date()): Promise<GenerateResult> {
  const db = createServiceClient()
  const ranges = recDateRanges(now)
  const generatedAt = now.toISOString()

  // 1. Load data
  let metaInputs: MetaCampaignInput[]
  let googleInputs: GoogleCampaignInput[]
  try {
    ;[metaInputs, googleInputs] = await Promise.all([
      loadMetaData(db, ranges),
      loadGoogleData(db, ranges),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[paid-recs/generate] Data load failed:', msg)
    return { ok: false, signalCount: 0, recommendationCount: 0, skipped: false, error: msg }
  }

  // 2. Detect signals
  const metaSignals   = buildMetaSignals(metaInputs)
  const googleSignals = buildGoogleSignals(googleInputs)
  const signals       = rankSignals(metaSignals, googleSignals)

  if (signals.length === 0) {
    console.log('[paid-recs/generate] No material signals detected — skipping generation.')
    return { ok: true, signalCount: 0, recommendationCount: 0, skipped: true }
  }

  // 2b. Suppress signals for campaigns with active recommendations
  const { data: activeRecs } = await db
    .from('paid_recommendations')
    .select('platform, campaign_id')
    .in('execution_status', ['pending_approval', 'executing', 'in_motion'])
    .neq('status', 'dismissed')
  const activeKeys = new Set(
    (activeRecs ?? []).map((r: { platform: string; campaign_id: string }) => `${r.platform}:${r.campaign_id}`),
  )
  const filteredSignals = signals.filter(s => !activeKeys.has(`${s.platform}:${s.campaign_id}`))
  if (filteredSignals.length === 0) {
    console.log('[paid-recs/generate] All signals suppressed — campaigns already have active recommendations.')
    return { ok: true, signalCount: signals.length, recommendationCount: 0, skipped: true }
  }

  // 3. V2 diagnostic: for Meta cpr_worsening and spend_no_results, run ad-level diagnosis
  const remediationPlans = new Map<string, PaidRemediationPlan>()
  const metaInputMap = new Map(metaInputs.map(i => [i.campaign.id, i]))

  for (const signal of filteredSignals) {
    if (signal.platform !== 'meta') continue
    if (signal.signal_type !== 'cpr_worsening' && signal.signal_type !== 'spend_no_results') continue

    const campaignInput = metaInputMap.get(signal.campaign_id)
    if (!campaignInput) continue

    try {
      const diagData = await loadMetaDiagnosticData(db, signal.campaign_id, ranges)
      const diagnosis = diagnosePerformance({
        campaignId: signal.campaign_id,
        campaignName: signal.campaign_name,
        adAccountId: campaignInput.campaign.ad_account_id,
        objective: campaignInput.campaign.objective ?? 'OUTCOME_AWARENESS',
        currency: signal.currency,
        dailyBudget: campaignInput.campaign.daily_budget ? Number(campaignInput.campaign.daily_budget) : null,
        ads: diagData.ads,
        adSets: diagData.adSets,
        currentAdInsights: diagData.currentAdInsights,
        priorAdInsights: diagData.priorAdInsights,
      })

      const campaignContext: RemediationCampaignContext = {
        id: signal.campaign_id,
        adAccountId: campaignInput.campaign.ad_account_id,
        currency: signal.currency,
        dailyBudget: campaignInput.campaign.daily_budget ? Number(campaignInput.campaign.daily_budget) : null,
        adSets: diagData.adSets,
      }
      const plan = buildRemediationPlan(diagnosis, campaignContext)
      remediationPlans.set(`meta:${signal.campaign_id}`, plan)

      console.log(`[paid-recs/generate] V2 diagnostic for ${signal.campaign_name}: ${diagnosis.classification}`)
    } catch (err) {
      console.error(`[paid-recs/generate] Diagnostic failed for ${signal.campaign_id}:`, err instanceof Error ? err.message : err)
      // Fall through to v1 AI-driven recommendation
    }
  }

  // 4. Call AI
  const aiResult = await callPaidRecommendationsAI(filteredSignals, now)
  if (!aiResult.ok) {
    console.error('[paid-recs/generate] AI call failed:', aiResult.errorDetail)
    return { ok: false, signalCount: filteredSignals.length, recommendationCount: 0, skipped: false, error: aiResult.error }
  }

  const { recommendations } = aiResult.output
  const model = aiResult.model

  // 5. Persist
  try {
    const newRecCampaignKeys = new Set(recommendations.map(r => `${r.platform}:${r.campaign_id}`))
    await clearStaleReviews(db, newRecCampaignKeys)
    const targets = new Map<string, SyncedTarget>()
    for (const input of metaInputs) targets.set(`meta:${input.campaign.id}`, { platform: 'meta', campaignId: input.campaign.id, accountId: input.campaign.ad_account_id, status: input.campaign.status, currency: input.campaign.currency, dailyBudget: input.campaign.daily_budget ? Number(input.campaign.daily_budget) : null })
    for (const input of googleInputs) targets.set(`google:${input.campaign.campaign_id}`, { platform: 'google', campaignId: input.campaign.campaign_id, accountId: input.campaign.customer_id, status: input.campaign.status, currency: input.campaign.currency, dailyBudget: input.campaign.daily_budget_micros ? input.campaign.daily_budget_micros / 1_000_000 : null, campaignBudgetResourceName: input.campaign.budget_resource_name ?? undefined, sharedBudget: input.campaign.budget_explicitly_shared ?? undefined })
    const configuredAccounts: ConfiguredAccounts = {
      metaAdAccountId: process.env.META_AD_ACCOUNT_ID,
      googleCustomerId: GOOGLE_ADS_CUSTOMER_ID || undefined,
    }
    await insertRecommendations(db, filteredSignals, aiResult, model, generatedAt, targets, configuredAccounts, remediationPlans)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[paid-recs/generate] DB write failed:', msg)
    return { ok: false, signalCount: signals.length, recommendationCount: 0, skipped: false, error: msg }
  }

  console.log(`[paid-recs/generate] Generated ${recommendations.length} recommendation(s) from ${filteredSignals.length} signal(s) (${signals.length - filteredSignals.length} suppressed). ${remediationPlans.size} v2 diagnostic(s).`)
  return {
    ok: true,
    signalCount: signals.length,
    recommendationCount: recommendations.length,
    skipped: false,
  }
}
