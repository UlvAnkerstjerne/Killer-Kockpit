/**
 * Which recommendations of the LATEST Paid Strategy still need a person, for the Morning Brief.
 *
 * Pure and read-only: the Brief loads the latest completed run and the live implementation rows at render time, so a
 * recommendation disappears the moment it is rejected, goes live or is finished, with no Brief regeneration. This is a view
 * over the same rows the CMO page uses, never a second copy of the state.
 */

import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { PaidStrategyRun } from '../types'
import type { ImplementationStatus, ImplementationView } from './types'

/** Nothing left to decide or act on: it was rejected, parked, is live, or is finished. */
export const SETTLED_FOR_BRIEF: readonly ImplementationStatus[] = ['rejected', 'cancelled', 'in_motion', 'completed', 'started']

export interface BriefRecommendation { rec: PaidStrategyRun['recommendations'][number]; index: number; view: ImplementationView | undefined }

export interface CmoBriefData { run: PaidStrategyRun; items: BriefRecommendation[]; implementations: StrategyImplementationData }

/**
 * Latest completed run only. Fresh ideas, prepared ones, blocked / waiting / needs-attention ones, ones Kockpit is working on
 * and ones ready to activate stay; rejected, cancelled, live and finished ones go. Returns null when there is nothing to show
 * (no access, no run, state unavailable, or nothing actionable) so the section can be hidden entirely.
 */
export function cmoBriefData(strategy: PaidStrategyData | null | undefined, implementations: StrategyImplementationData | null | undefined): CmoBriefData | null {
  if (!strategy?.allowed || strategy.error || !strategy.latest || !implementations || implementations.error) return null
  const run = strategy.latest
  const views = implementations.views.filter(v => v.strategyRunId === run.id)
  const items = run.recommendations
    .map((rec, index) => ({ rec, index, view: views.find(v => v.recommendationIndex === index) }))
    .filter(item => !item.view || !SETTLED_FOR_BRIEF.includes(item.view.status))
  return items.length ? { run, items, implementations } : null
}
