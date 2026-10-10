import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import type { CreativeRun } from '@/lib/marketing/brain/types'
import type { PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'
import { createActionStore } from './actions/repo'
import { syncActionResults } from './actions/sync'
import { captureRun, recordInformed, type CaptureResult } from './capture'
import { extractFromCreativeRun, extractFromPaidRun } from './extract'
import { evaluateFacebookAdsChecks, type MetaChecksInput } from './skill-checks/facebook-ads'
import { loadMetaChecksInput } from './skill-checks/inputs'
import { createInsightStore } from './repo'

type Db = ReturnType<typeof createServiceClient>
/** Backfill replays at most this many recent runs per source, oldest first, so trends reflect real order. */
export const BACKFILL_RUNS_PER_SOURCE = 6
const PAID_COLUMNS = 'id,started_at,generated_at,status,window_start,window_end,model,prompt_version,skill_ref,skill_hash,recommendations,error'

export async function captureCreativeRunById(db: Db, runId: string): Promise<CaptureResult | null> {
  const { data, error } = await db.from('marketing_creative_intelligence_runs').select('*').eq('id', runId).in('status', ['completed', 'partial']).maybeSingle()
  if (error) throw new Error('insights_storage')
  if (!data) return null
  return captureRun(createInsightStore(db), extractFromCreativeRun(data as CreativeRun))
}

export async function capturePaidRunById(db: Db, runId: string): Promise<CaptureResult | null> {
  const { data, error } = await db.from('marketing_paid_strategy_runs').select(PAID_COLUMNS).eq('id', runId).eq('status', 'completed').maybeSingle()
  if (error) throw new Error('insights_storage')
  if (!data) return null
  return captureRun(createInsightStore(db), extractFromPaidRun(data as PaidStrategyRun))
}

/**
 * Evaluates the facebook-ads checklist on stored Meta data and captures any warning or fail as an insight. Deterministic and
 * idempotent per day: a second evaluation on the same day is skipped. A Paid Strategy run passes the inputs it already loaded.
 */
export async function captureFacebookAdsChecks(db: Db, input: MetaChecksInput): Promise<CaptureResult> {
  return captureRun(createInsightStore(db), evaluateFacebookAdsChecks(input).extraction)
}

/**
 * Generators call this AFTER their own run is saved. Capturing is a derived view of a finished run: it must never fail or
 * delay the run it describes, so any problem (including the migration not being applied yet) is logged and swallowed.
 */
export async function captureQuietly(label: string, work: () => Promise<unknown>): Promise<void> {
  try { await work() } catch (error) {
    console.warn(`[insights] ${label}: capture skipped (${error instanceof Error ? error.message : 'unknown error'}). The run itself is unaffected.`)
  }
}

/**
 * Records how chosen actions ended (task done or cancelled, implementation completed or stopped) together with what the insight
 * looked like then. Read-only toward tasks and implementations. Called before prior insights are loaded for a new run, and by
 * the capture button, so what people did is in front of the next analysis.
 */
export async function syncInsightActionResults(db: Db) {
  return syncActionResults({
    store: createActionStore(db),
    readTasks: async ids => {
      if (!ids.length) return []
      const { data, error } = await db.from('tasks').select('id,status,completed_at,approved_at,updated_at').in('id', ids)
      if (error) throw new Error('insight_actions_storage')
      return (data ?? []) as Awaited<ReturnType<Parameters<typeof syncActionResults>[0]['readTasks']>>
    },
    readImplementations: async keys => {
      if (!keys.length) return []
      const { data, error } = await db.from('marketing_paid_strategy_implementations').select('strategy_run_id,recommendation_index,status,completed_at,updated_at').in('strategy_run_id', [...new Set(keys.map(k => k.runId))])
      if (error) throw new Error('insight_actions_storage')
      return (data ?? []) as Awaited<ReturnType<Parameters<typeof syncActionResults>[0]['readImplementations']>>
    },
    readInsights: async ids => {
      const { data, error } = await db.from('marketing_insights').select('id,strength,trend,times_observed,last_supported_at').in('id', ids)
      if (error) throw new Error('insight_actions_storage')
      return (data ?? []) as Awaited<ReturnType<Parameters<typeof syncActionResults>[0]['readInsights']>>
    },
  })
}

export async function recordInformedQuietly(db: Db, insightIds: string[], target: { type: 'paid_strategy_run' | 'creative_run'; runId: string }): Promise<void> {
  await captureQuietly('informed links', () => recordInformed(createInsightStore(db), insightIds, target))
}

/** Replays the latest runs of each source through the same idempotent capture. Safe to run repeatedly. */
export async function backfillInsights(db: Db): Promise<{ creative: number; paid: number; checklist: number; created: number; updated: number }> {
  const [creative, paid] = await Promise.all([
    db.from('marketing_creative_intelligence_runs').select('id').in('status', ['completed', 'partial']).order('generated_at', { ascending: false }).limit(BACKFILL_RUNS_PER_SOURCE),
    db.from('marketing_paid_strategy_runs').select('id').eq('status', 'completed').order('generated_at', { ascending: false }).limit(BACKFILL_RUNS_PER_SOURCE),
  ])
  if (creative.error || paid.error) throw new Error('insights_storage')
  const out = { creative: 0, paid: 0, checklist: 0, created: 0, updated: 0 }
  const tally = (key: 'creative' | 'paid' | 'checklist', result: CaptureResult | null) => {
    if (!result || result.skipped) return
    if (key === 'checklist' && !result.created && !result.updated && !result.unconfirmed) return // nothing was assessable or changed
    out[key]++; out.created += result.created; out.updated += result.updated
  }
  for (const row of [...(creative.data ?? [])].reverse()) tally('creative', await captureCreativeRunById(db, row.id as string))
  for (const row of [...(paid.data ?? [])].reverse()) tally('paid', await capturePaidRunById(db, row.id as string))
  await captureQuietly('action results', () => syncInsightActionResults(db))
  // The checklist reads today's stored data, so it is evaluated once, last.
  tally('checklist', await captureFacebookAdsChecks(db, await loadMetaChecksInput(db, new Date())))
  return out
}
