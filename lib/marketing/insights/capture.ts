/**
 * Applies one source run to the durable insight store. The only side effects are through `InsightStore`.
 *
 * Idempotent: a run that has observations already is skipped, and each insight remembers the last run that touched it, so a
 * retry after a partial failure converges instead of double counting. Observations are written LAST: they are the marker
 * that a run has been captured.
 */

import { reconcileRun } from './reconcile'
import type { InsightDomain, InsightInsert, InsightPatch, InsightRow, InsightSourceKind, LinkRow, ObservationRow, RunExtraction } from './types'

export interface InsightStore {
  listInsights(domains: InsightDomain[]): Promise<InsightRow[]>
  hasObservations(sourceKind: InsightSourceKind, runId: string): Promise<boolean>
  insertInsight(row: InsightInsert): Promise<string>
  updateInsight(id: string, patch: InsightPatch): Promise<void>
  insertObservations(rows: ObservationRow[]): Promise<void>
  insertLinks(rows: LinkRow[]): Promise<void>
}

export interface CaptureResult { skipped: boolean; created: number; updated: number; unconfirmed: number }

export async function captureRun(store: InsightStore, extraction: RunExtraction): Promise<CaptureResult> {
  if (await store.hasObservations(extraction.sourceKind, extraction.runId)) return { skipped: true, created: 0, updated: 0, unconfirmed: 0 }
  const domains = [...new Set<InsightDomain>([
    ...extraction.candidates.map(c => c.domain),
    ...(Object.entries(extraction.coverage) as [InsightDomain, boolean][]).filter(([, covered]) => covered).map(([d]) => d),
  ])]
  if (!domains.length) return { skipped: false, created: 0, updated: 0, unconfirmed: 0 }

  const plan = reconcileRun(await store.listInsights(domains), extraction)
  const observations: ObservationRow[] = []
  const links: LinkRow[] = []
  const derived = (insightId: string, candidateIndex: number) => {
    const index = extraction.candidates[candidateIndex].recommendation_index
    if (extraction.sourceKind === 'paid_strategy_run' && index !== null) {
      links.push({ insight_id: insightId, target_type: 'paid_strategy_recommendation', target_run_id: extraction.runId, target_index: index, relation: 'derived_from' })
    }
  }

  for (const planned of plan.inserts) {
    const id = await store.insertInsight(planned.insert)
    observations.push({ ...planned.observation, insight_id: id })
    derived(id, planned.candidateIndex)
  }
  for (const planned of plan.updates) {
    if (planned.patch) await store.updateInsight(planned.insightId, planned.patch)
    observations.push({ ...planned.observation, insight_id: planned.insightId })
    derived(planned.insightId, planned.candidateIndex)
  }
  for (const miss of plan.misses) await store.updateInsight(miss.insightId, miss.patch)

  if (links.length) await store.insertLinks(links)
  if (observations.length) await store.insertObservations(observations)
  return { skipped: false, created: plan.inserts.length, updated: plan.updates.length, unconfirmed: plan.misses.length }
}

/** Records which earlier insights were put in front of a later run, so "what informed this" can be answered afterwards. */
export async function recordInformed(store: InsightStore, insightIds: string[], target: { type: 'paid_strategy_run' | 'creative_run'; runId: string }): Promise<void> {
  const unique = [...new Set(insightIds)]
  if (!unique.length) return
  await store.insertLinks(unique.map(id => ({ insight_id: id, target_type: target.type, target_run_id: target.runId, target_index: null, relation: 'informed' as const })))
}
