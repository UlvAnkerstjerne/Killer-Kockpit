/**
 * lib/marketing/paid-recs/generate.ts
 *
 * Orchestrator for Paid Recommendation generation.
 * Called by the API route after Meta + Google Ads syncs complete.
 *
 * Steps:
 *   1. Compute current and prior 7-day date windows (Copenhagen time)
 *   2. Load active Meta + Google Ads campaigns and 14 days of daily data
 *   3. Build deterministic signals (signals.ts — pure functions)
 *   4. If no signals: return early (no recommendations needed)
 *   5. Call Claude with signals (lib/ai/paid-recommendations.ts)
 *   6. If AI fails: return error (preserves existing needs_review records)
 *   7. Delete all existing needs_review records
 *   8. Insert new recommendations
 *
 * Security: all DB access uses createServiceClient (service_role).
 * No user identity is passed in — this is a background generation job.
 */

import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import type { MetaCampaignInsightRow, MetaCampaignRow } from '@/lib/marketing/types/meta'
import type { GooglePaidAction, GooglePaidCampaign, GooglePaidDaily } from '@/lib/marketing/paid-performance'
import {
  buildMetaSignals,
  buildGoogleSignals,
  rankSignals,
  type MetaCampaignInput,
  type GoogleCampaignInput,
} from './signals'
import { callPaidRecommendationsAI, PAID_REC_PROMPT_VERSION } from '@/lib/ai/paid-recommendations'
import type { PaidRecSignal, PaidRecSignalType } from './types'
import { SIGNAL_EXECUTION_MAP } from './types'

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
    current: { start: shift(7),  end: shift(1) },  // last 7 completed days
    prior:   { start: shift(14), end: shift(8) },  // the 7 days before that
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

  // Group insights by campaign_id and window
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
        .select('customer_id,campaign_id,name,status,channel_type,channel_sub_type,bidding_strategy_type,goal_config_level,conversion_goals,custom_conversion_goal,synced_at')
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

// ─── DB writes ────────────────────────────────────────────────────────────────

async function clearNeedsReview(db: Db): Promise<void> {
  const { error } = await db
    .from('paid_recommendations')
    .delete()
    .eq('status', 'needs_review')
  if (error) throw new Error(`Failed to clear needs_review records: ${error.message}`)
}

async function insertRecommendations(
  db: Db,
  signals: PaidRecSignal[],
  aiResult: Awaited<ReturnType<typeof callPaidRecommendationsAI>>,
  model: string,
  generatedAt: string,
): Promise<void> {
  if (!aiResult.ok) return

  const signalByCampaignId = new Map(signals.map(s => [s.campaign_id, s]))
  const rows = aiResult.output.recommendations.map(rec => {
    const signal = signalByCampaignId.get(rec.campaign_id)
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
      execution_type:        SIGNAL_EXECUTION_MAP[(signal?.signal_type ?? 'spend_no_results') as PaidRecSignalType] ?? 'monitor',
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
  skipped: boolean     // true when no signals detected (not an error)
  error?: string
}

/**
 * Generates paid recommendations from the current 7-day vs prior 7-day campaign data.
 *
 * Idempotent: clears all existing needs_review records before inserting new ones.
 * Approved and dismissed records are preserved.
 */
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

  // 2b. Suppress signals for campaigns that already have an in-motion recommendation
  const { data: inMotionRecs } = await db
    .from('paid_recommendations')
    .select('platform, campaign_id')
    .eq('execution_status', 'in_motion')
  const inMotionKeys = new Set(
    (inMotionRecs ?? []).map((r: { platform: string; campaign_id: string }) => `${r.platform}:${r.campaign_id}`),
  )
  const filteredSignals = signals.filter(s => !inMotionKeys.has(`${s.platform}:${s.campaign_id}`))
  if (filteredSignals.length === 0) {
    console.log('[paid-recs/generate] All signals suppressed — campaigns already in motion.')
    return { ok: true, signalCount: signals.length, recommendationCount: 0, skipped: true }
  }

  // 3. Call AI
  const aiResult = await callPaidRecommendationsAI(filteredSignals, now)
  if (!aiResult.ok) {
    console.error('[paid-recs/generate] AI call failed:', aiResult.errorDetail)
    return { ok: false, signalCount: filteredSignals.length, recommendationCount: 0, skipped: false, error: aiResult.error }
  }

  const { recommendations } = aiResult.output
  const model = aiResult.model

  // 4. Persist: clear old needs_review (but not those with in-motion siblings), insert new
  try {
    await clearNeedsReview(db)
    await insertRecommendations(db, filteredSignals, aiResult, model, generatedAt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[paid-recs/generate] DB write failed:', msg)
    return { ok: false, signalCount: signals.length, recommendationCount: 0, skipped: false, error: msg }
  }

  console.log(`[paid-recs/generate] Generated ${recommendations.length} recommendation(s) from ${filteredSignals.length} signal(s) (${signals.length - filteredSignals.length} suppressed).`)
  return {
    ok: true,
    signalCount: signals.length,
    recommendationCount: recommendations.length,
    skipped: false,
  }
}
