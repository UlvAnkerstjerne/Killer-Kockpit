/**
 * lib/marketing/paid-strategy/generate.ts
 *
 * Orchestrator for a Paid Strategy (MESPER) run. Manual only.
 *
 * Reads stored Meta Ads tables, builds whitelisted evidence, calls the MESPER-based
 * analysis, and persists the result to marketing_paid_strategy_runs.
 *
 * It writes NOTHING else: no paid_recommendations, no execution events, no Meta/Google
 * calls. The caller must authenticate and authorize SUPER_ADMIN before creating the
 * service client passed in here.
 */

import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { callPaidStrategyAI, PAID_STRATEGY_PROMPT_VERSION } from '@/lib/ai/paid-strategy'
import { loadMesperSkill, type LoadedSkill } from '@/lib/ai/skills/mesper'
import {
  buildPaidStrategyEvidence, strategyWindows,
  type StrategyAd, type StrategyAdInsight, type StrategyAdSet, type StrategyCampaign, type StrategyCampaignInsight,
} from './evidence'

type Db = ReturnType<typeof createServiceClient>
const LEASE_MS = 10 * 60_000

export type PaidStrategyRefreshResult = { ok: boolean; runId?: string; recommendationCount?: number; error?: string }

type PageResponse = { data: unknown[] | null; error: unknown }
async function readPages<T>(query: (from: number, to: number) => PromiseLike<PageResponse>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const { data, error } = await query(rows.length, rows.length + pageSize - 1)
    if (error) throw new Error('storage')
    if (!data?.length) return rows
    rows.push(...data as T[])
    if (data.length < pageSize) return rows
  }
}

export async function loadPaidStrategyInputs(db: Db, now: Date) {
  const w = strategyWindows(now)
  const [accounts, campaigns, adSets, ads, campaignInsights, adInsights] = await Promise.all([
    readPages<{ id: string; currency: string }>((a, b) => db.from('meta_ad_accounts').select('id,currency').order('id').range(a, b)),
    readPages<StrategyCampaign>((a, b) => db.from('meta_ad_campaigns').select('id,name,status,objective,daily_budget,created_at_meta').order('id').range(a, b)),
    readPages<StrategyAdSet>((a, b) => db.from('meta_ad_sets').select('id,campaign_id,name,status,daily_budget').order('id').range(a, b)),
    readPages<StrategyAd>((a, b) => db.from('meta_ads').select('id,ad_set_id,name,status').order('id').range(a, b)),
    readPages<StrategyCampaignInsight>((a, b) => db.from('meta_campaign_insights')
      .select('campaign_id,date_start,impressions,clicks,inline_link_clicks,spend,frequency,actions_json')
      .gte('date_start', w.prior.start).lte('date_start', w.current.end)
      .order('date_start').order('campaign_id').range(a, b)),
    readPages<StrategyAdInsight>((a, b) => db.from('meta_ad_insights')
      .select('ad_id,date_start,impressions,clicks,inline_link_clicks,spend,actions_json')
      .gte('date_start', w.prior.start).lte('date_start', w.current.end)
      .order('date_start').order('ad_id').range(a, b)),
  ])
  return { now, currency: accounts[0]?.currency ?? 'DKK', campaigns, adSets, ads, campaignInsights, adInsights }
}

export async function generatePaidStrategy(
  db: Db,
  actorId: string,
  options: { now?: Date; skill?: LoadedSkill } = {},
): Promise<PaidStrategyRefreshResult> {
  const now = options.now ?? new Date()
  let skill: LoadedSkill
  try {
    skill = options.skill ?? loadMesperSkill()
  } catch (err) {
    console.error('[paid-strategy/generate] Skill verification failed:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'The pinned MESPER skill files could not be verified. No analysis was run.' }
  }

  const w = strategyWindows(now)
  let runId: string | undefined
  try {
    const expired = await db.from('marketing_paid_strategy_runs')
      .update({ status: 'failed', lease_expires_at: null, error: 'Run interrupted. Please generate again.' })
      .eq('status', 'running').lt('lease_expires_at', now.toISOString())
    if (expired.error) throw new Error('storage')

    const claim = await db.from('marketing_paid_strategy_runs').insert({
      status: 'running', requested_by: actorId, started_at: now.toISOString(), generated_at: now.toISOString(),
      window_start: w.current.start, window_end: w.current.end,
      prompt_version: PAID_STRATEGY_PROMPT_VERSION, skill_ref: skill.ref, skill_hash: skill.hash,
      lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
    }).select('id').single()
    if (claim.error?.code === '23505') return { ok: false, error: 'A Paid Strategy analysis is already running. Try again after it finishes.' }
    if (claim.error || !claim.data) throw new Error('storage')
    runId = claim.data.id as string

    const evidence = buildPaidStrategyEvidence(await loadPaidStrategyInputs(db, now))
    if (evidence.budget.spend_current_28d + evidence.budget.spend_prior_28d <= 0) {
      return await fail(db, runId, 'No stored Meta Ads spend was found in the last 56 days, so there is nothing to analyse.')
    }

    const ai = await callPaidStrategyAI(skill, evidence)
    if (!ai.ok) return await fail(db, runId, ai.error)

    const done = await db.from('marketing_paid_strategy_runs').update({
      status: 'completed', generated_at: new Date().toISOString(), lease_expires_at: null,
      model: ai.model, evidence, recommendations: ai.recommendations, error: null,
    }).eq('id', runId).eq('status', 'running').select('id').single()
    if (done.error || !done.data) throw new Error('storage')
    return { ok: true, runId, recommendationCount: ai.recommendations.length }
  } catch {
    if (runId) {
      await db.from('marketing_paid_strategy_runs')
        .update({ status: 'failed', lease_expires_at: null, error: 'Paid Strategy generation failed. Previous results are preserved.' })
        .eq('id', runId).eq('status', 'running')
    }
    return { ok: false, error: 'Paid Strategy generation failed. Previous results are preserved.' }
  }
}

async function fail(db: Db, runId: string, message: string): Promise<PaidStrategyRefreshResult> {
  await db.from('marketing_paid_strategy_runs')
    .update({ status: 'failed', lease_expires_at: null, error: message.slice(0, 500) })
    .eq('id', runId).eq('status', 'running')
  return { ok: false, error: message }
}
