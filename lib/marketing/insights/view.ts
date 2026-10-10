/**
 * Read model for the CMO page and the Morning Brief. PURE: shapes already-loaded rows; reads nothing.
 * Recommendation and action state are looked up from the strategy data at render time, never copied into an insight.
 */

import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import { stateLabel } from '@/lib/marketing/paid-strategy/implementation/state'
import type { ActionView } from './actions/types'
import type { InsightKind, InsightRow, LinkRow, ObservationRow } from './types'

export type InsightHistoryEntry = Pick<ObservationRow, 'observed_at' | 'strength' | 'change'>
export type InsightLink = Pick<LinkRow, 'target_type' | 'target_run_id' | 'target_index' | 'relation'>
export interface InsightView extends InsightRow { history: InsightHistoryEntry[]; links: InsightLink[]; actions: ActionView[] }

export const KIND_ORDER: InsightKind[] = ['finding', 'content_opportunity', 'retargeting_hypothesis']

export function splitInsights(insights: InsightView[]): { active: InsightView[]; stale: InsightView[] } {
  return { active: insights.filter(i => i.status === 'active'), stale: insights.filter(i => i.status === 'stale') }
}

export interface LinkedRecommendation { runId: string; index: number; title: string; state: string; latestRun: boolean }

/** The recommendations an insight was derived from, with their current decision state read from the live implementation rows. */
export function linkedRecommendations(
  insight: Pick<InsightView, 'links'>, strategy: PaidStrategyData | null | undefined, implementations: StrategyImplementationData | null | undefined,
): LinkedRecommendation[] {
  if (!strategy?.allowed) return []
  const runs = [strategy.latest, ...strategy.previous].filter((r): r is NonNullable<typeof r> => !!r)
  const out: LinkedRecommendation[] = []
  for (const link of insight.links) {
    if (link.relation !== 'derived_from' || link.target_type !== 'paid_strategy_recommendation' || link.target_index === null) continue
    const run = runs.find(r => r.id === link.target_run_id)
    const rec = run?.recommendations[link.target_index]
    if (!run || !rec) continue
    const view = implementations && !implementations.error
      ? implementations.views.find(v => v.strategyRunId === run.id && v.recommendationIndex === link.target_index) : undefined
    const latestRun = strategy.latest?.id === run.id
    out.push({
      runId: run.id, index: link.target_index, title: rec.display_title ?? rec.title, latestRun,
      state: view ? stateLabel(view) : latestRun ? 'Not decided yet' : 'From an earlier analysis',
    })
  }
  return out
}
