/**
 * Prior insights as CONTEXT for the next specialist run.
 *
 * The same shape and caution as the rejection memory (paid-strategy/evidence.ts humanDecisionsEvidence): a short, bounded,
 * labelled-untrusted list the model may use to avoid rediscovering the same thing and to say whether the new data supports it.
 * They are conclusions from EARLIER analyses, never current data, so figures inside them are not usable as evidence. The organic
 * figure check only grounds on numeric JSON values, and a prior insight's text is a string, so it can never ground a figure.
 */

import type { createServiceClient } from '@/lib/supabase/server'
import { insightSinceAction, type InsightSince } from './actions/result'
import type { ActionKind, ActionOutcome, ActionStatus } from './actions/types'
import { STRENGTH_RANK, type InsightDomain, type InsightKind, type InsightStrength, type InsightTrend } from './types'

type Db = ReturnType<typeof createServiceClient>
export const MAX_PRIOR_INSIGHTS = 6
export const PRIOR_STATEMENT_CHARS = 220

/** What a person did about an insight, so the next analysis can see it. Chosen / completed / stopped actions only. */
export interface PriorActionInput { title: string; kind: ActionKind; status: ActionStatus; chosen_at: string | null; completed_at: string | null; outcome: ActionOutcome | null }

export interface PriorInsightInput {
  id: string
  kind: InsightKind
  statement: string
  strength: InsightStrength
  trend: InsightTrend
  times_observed: number
  first_seen_at: string
  last_supported_at: string
  actions?: PriorActionInput[]
}

export const MAX_PRIOR_ACTIONS_PER_INSIGHT = 2

/** Active (not stale) insights, strongest and most recently supported first. A failure only costs context. */
export async function loadPriorInsights(db: Db, domains: InsightDomain[], limit = MAX_PRIOR_INSIGHTS): Promise<PriorInsightInput[]> {
  try {
    const { data, error } = await db.from('marketing_insights')
      .select('id,kind,statement,strength,trend,times_observed,first_seen_at,last_supported_at')
      .in('domain', domains).eq('status', 'active').order('last_supported_at', { ascending: false }).limit(60)
    if (error || !Array.isArray(data)) return []
    const ranked = rankPriorInsights(data as PriorInsightInput[], limit)
    return await withActions(db, ranked)
  } catch {
    console.warn('[insights] Prior insights could not be read; continuing without them.')
    return []
  }
}

/** Attaches what people did about each insight. A failure here only costs that context. */
async function withActions(db: Db, items: PriorInsightInput[]): Promise<PriorInsightInput[]> {
  if (!items.length) return items
  try {
    const { data, error } = await db.from('marketing_insight_actions').select('insight_id,title,kind,status,chosen_at,completed_at,outcome')
      .in('insight_id', items.map(i => i.id)).in('status', ['chosen', 'completed', 'abandoned']).order('chosen_at', { ascending: false }).limit(60)
    if (error || !Array.isArray(data)) return items
    const by = new Map<string, PriorActionInput[]>()
    for (const row of data as (PriorActionInput & { insight_id: string })[]) {
      const list = by.get(row.insight_id) ?? []
      if (list.length < MAX_PRIOR_ACTIONS_PER_INSIGHT) by.set(row.insight_id, [...list, { title: row.title, kind: row.kind, status: row.status, chosen_at: row.chosen_at, completed_at: row.completed_at, outcome: row.outcome }])
    }
    return items.map(i => (by.has(i.id) ? { ...i, actions: by.get(i.id) } : i))
  } catch {
    return items
  }
}

export function rankPriorInsights(items: PriorInsightInput[], limit = MAX_PRIOR_INSIGHTS): PriorInsightInput[] {
  return [...items]
    .sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] || Date.parse(b.last_supported_at) - Date.parse(a.last_supported_at))
    .slice(0, limit)
}

/** Post refs from an earlier run (P3, U1) mean nothing in a new run's evidence, so they are neutralised before reuse. */
export function neutraliseRefs(text: string): string {
  return text.replace(/\b[PUB]\d{1,3}\b/g, 'a post')
}

type ActionEvidence = { what: string; kind: ActionKind; state: 'in_progress' | 'completed' | 'stopped'; started_on: string | null; finished_on: string | null; insight_since: InsightSince | null }
function actionEvidence(a: PriorActionInput, insight: PriorInsightInput, text: (value: string, max: number) => string): ActionEvidence {
  return {
    what: text(neutraliseRefs(a.title), 100), kind: a.kind,
    state: a.status === 'completed' ? 'completed' : a.status === 'abandoned' ? 'stopped' : 'in_progress',
    started_on: a.chosen_at?.slice(0, 10) ?? null, finished_on: a.completed_at?.slice(0, 10) ?? null,
    insight_since: insightSinceAction(a.outcome, insight),
  }
}

/** Empty when there is nothing to say, so a first run sees exactly the evidence it saw before this feature existed. */
export function priorInsightsEvidence(items: PriorInsightInput[], text: (value: string, max: number) => string) {
  const ranked = rankPriorInsights(items)
  if (!ranked.length) return null
  return {
    purpose: 'Conclusions reached by EARLIER analyses. They are not current data and not proof. Use them to avoid rediscovering the same thing and to say whether this data supports, weakens or does not address them.',
    items: ranked.map(i => ({
      kind: i.kind,
      statement: text(neutraliseRefs(i.statement), PRIOR_STATEMENT_CHARS),
      strength: i.strength,
      trend: i.trend,
      seen_in_runs: i.times_observed,
      first_seen_on: i.first_seen_at.slice(0, 10),
      last_supported_on: i.last_supported_at.slice(0, 10),
      ...(i.actions?.length ? { actions_taken: i.actions.map(a => actionEvidence(a, i, text)) } : {}),
    })),
  }
}
