/**
 * Prior insights as CONTEXT for the next specialist run.
 *
 * The same shape and caution as the rejection memory (paid-strategy/evidence.ts humanDecisionsEvidence): a short, bounded,
 * labelled-untrusted list the model may use to avoid rediscovering the same thing and to say whether the new data supports it.
 * They are conclusions from EARLIER analyses, never current data, so figures inside them are not usable as evidence. The organic
 * figure check only grounds on numeric JSON values, and a prior insight's text is a string, so it can never ground a figure.
 */

import type { createServiceClient } from '@/lib/supabase/server'
import { STRENGTH_RANK, type InsightDomain, type InsightKind, type InsightStrength, type InsightTrend } from './types'

type Db = ReturnType<typeof createServiceClient>
export const MAX_PRIOR_INSIGHTS = 6
export const PRIOR_STATEMENT_CHARS = 220

export interface PriorInsightInput {
  id: string
  kind: InsightKind
  statement: string
  strength: InsightStrength
  trend: InsightTrend
  times_observed: number
  first_seen_at: string
  last_supported_at: string
}

/** Active (not stale) insights, strongest and most recently supported first. A failure only costs context. */
export async function loadPriorInsights(db: Db, domains: InsightDomain[], limit = MAX_PRIOR_INSIGHTS): Promise<PriorInsightInput[]> {
  try {
    const { data, error } = await db.from('marketing_insights')
      .select('id,kind,statement,strength,trend,times_observed,first_seen_at,last_supported_at')
      .in('domain', domains).eq('status', 'active').order('last_supported_at', { ascending: false }).limit(60)
    if (error || !Array.isArray(data)) return []
    return rankPriorInsights(data as PriorInsightInput[], limit)
  } catch {
    console.warn('[insights] Prior insights could not be read; continuing without them.')
    return []
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
    })),
  }
}
