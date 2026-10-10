import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import { SETTLED_FOR_BRIEF } from '@/lib/marketing/paid-strategy/implementation/surface'
import type { InsightView } from '../view'
import { clip } from '../text'

export interface ImplementRoute { runId: string; index: number; title: string; successMetric: string | null; test: string }

/**
 * The ONLY direct route: the insight was derived from a recommendation of the LATEST completed Paid Strategy that has not been
 * settled yet. That is the only thing Kockpit's implementation flow accepts (it is keyed on the latest run and indexes 0-2, in code
 * and in the database), so nothing else can be implemented from an insight. Decided here, by code; the model never proposes it.
 */
export function implementRouteFor(
  insight: Pick<InsightView, 'links'>, strategy: PaidStrategyData | null | undefined, implementations: StrategyImplementationData | null | undefined,
): ImplementRoute | null {
  if (!strategy?.allowed || !strategy.latest || !implementations || implementations.error) return null
  const run = strategy.latest
  for (const link of insight.links) {
    if (link.relation !== 'derived_from' || link.target_type !== 'paid_strategy_recommendation' || link.target_index === null || link.target_run_id !== run.id) continue
    const rec = run.recommendations[link.target_index]
    if (!rec) continue
    const view = implementations.views.find(v => v.strategyRunId === run.id && v.recommendationIndex === link.target_index)
    if (view && SETTLED_FOR_BRIEF.includes(view.status)) continue
    return { runId: run.id, index: link.target_index, title: rec.display_title ?? rec.title, successMetric: clip(rec.success_metric, 600), test: clip(rec.exact_test_or_action, 700) ?? '' }
  }
  return null
}
