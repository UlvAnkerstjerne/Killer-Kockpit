/**
 * Decides, for one source run, which candidates are NEW insights, which re-observe an EXISTING one (and whether it gained or
 * lost support), and which existing insights this run failed to reproduce. PURE and deterministic.
 *
 * Duplicates are avoided in three layers: an exact stable key where a source has one, otherwise text similarity inside one
 * scope (domain + kind [+ paid recommendation type]) with a bonus for shared source posts, and one-to-one assignment so a
 * single existing insight can absorb only one candidate per run. Every write is also idempotent per source run
 * (`last_source_run_id`), so replaying a run changes nothing.
 *
 * A miss only counts when the run actually covers the insight's domain (see RunExtraction.coverage): a failed or skipped
 * specialist step is silence, not evidence against an earlier conclusion.
 */

import { similarity } from './text'
import {
  STRENGTH_RANK, type InsightCandidate, type InsightInsert, type InsightPatch, type InsightRow, type InsightTrend,
  type ObservationChange, type ObservationRow, type RunExtraction, type SourceRef,
} from './types'

export const MATCH_THRESHOLD = 0.55
/** When both sides carry a stable key and the keys differ, only a clearly equivalent restatement may still merge. */
export const DIFFERENT_KEY_THRESHOLD = 0.7
const SHARED_POST_BONUS = 0.15
/** Not reproduced in this many consecutive covered runs -> stale. */
export const STALE_AFTER_MISSES = 2

type PlannedObservation = Omit<ObservationRow, 'insight_id'>
export interface PlannedInsert { candidateIndex: number; insert: InsightInsert; observation: PlannedObservation }
export interface PlannedUpdate { insightId: string; candidateIndex: number; patch: InsightPatch | null; observation: PlannedObservation }
export interface PlannedMiss { insightId: string; patch: InsightPatch }
export interface ReconcilePlan { inserts: PlannedInsert[]; updates: PlannedUpdate[]; misses: PlannedMiss[] }

const permalinks = (refs: SourceRef[]): Set<string> =>
  new Set(refs.flatMap(r => (r.type === 'instagram_post' && r.permalink ? [r.permalink] : [])))

export function matchScore(candidate: InsightCandidate, existing: InsightRow): number {
  if (candidate.stable_key && existing.stable_key && candidate.stable_key === existing.stable_key) return 1
  let score = similarity(`${candidate.title} ${candidate.statement}`, `${existing.title} ${existing.statement}`)
  const mine = permalinks(candidate.refs)
  if (mine.size && [...permalinks(existing.refs)].some(link => mine.has(link))) score = Math.min(1, score + SHARED_POST_BONUS)
  const bothKeyed = !!candidate.stable_key && !!existing.stable_key
  return score >= (bothKeyed ? DIFFERENT_KEY_THRESHOLD : MATCH_THRESHOLD) ? score : 0
}

function observationFor(extraction: RunExtraction, candidate: InsightCandidate, change: ObservationChange): PlannedObservation {
  return {
    source_kind: extraction.sourceKind, source_run_id: extraction.runId, source_index: candidate.recommendation_index,
    observed_at: extraction.observedAt, strength: candidate.strength, change,
    statement: candidate.statement, evidence_text: candidate.evidence_text, limitations: candidate.limitations, refs: candidate.refs,
  }
}

export function reconcileRun(existing: InsightRow[], extraction: RunExtraction): ReconcilePlan {
  const plan: ReconcilePlan = { inserts: [], updates: [], misses: [] }
  const { candidates, observedAt, runId } = extraction

  // Every viable pairing, best first; ties go to the older insight so the result never depends on input order.
  const pairs: { c: number; e: number; score: number }[] = []
  candidates.forEach((candidate, c) => existing.forEach((row, e) => {
    if (row.scope_key !== candidate.scope_key) return
    const score = matchScore(candidate, row)
    if (score > 0) pairs.push({ c, e, score })
  }))
  pairs.sort((a, b) => b.score - a.score || Date.parse(existing[a.e].first_seen_at) - Date.parse(existing[b.e].first_seen_at) || a.c - b.c)

  const claimedCandidates = new Set<number>()
  const claimedExisting = new Set<number>()
  for (const { c, e } of pairs) {
    if (claimedCandidates.has(c) || claimedExisting.has(e)) continue
    claimedCandidates.add(c); claimedExisting.add(e)
    const candidate = candidates[c]
    const row = existing[e]
    const rankNow = STRENGTH_RANK[candidate.strength]
    const rankBefore = STRENGTH_RANK[row.strength]
    const change: ObservationChange = rankNow > rankBefore ? 'strengthened' : rankNow < rankBefore ? 'weakened' : 'reconfirmed'
    const observation = observationFor(extraction, candidate, change)

    if (row.last_source_run_id === runId) { plan.updates.push({ insightId: row.id, candidateIndex: c, patch: null, observation }); continue }
    if (Date.parse(observedAt) <= Date.parse(row.last_seen_at)) {
      // An older run replayed after a newer one: keep the history, never let it rewind the current state.
      plan.updates.push({
        insightId: row.id, candidateIndex: c, observation: { ...observation, change: 'reconfirmed' },
        patch: { times_observed: row.times_observed + 1, first_seen_at: Date.parse(observedAt) < Date.parse(row.first_seen_at) ? observedAt : row.first_seen_at },
      })
      continue
    }
    const trend: InsightTrend = change === 'strengthened' ? 'strengthening' : change === 'weakened' ? 'weakening' : 'steady'
    plan.updates.push({
      insightId: row.id, candidateIndex: c, observation,
      patch: {
        // The newest wording and evidence represent the insight today; earlier wording lives on in its observations.
        title: candidate.title, statement: candidate.statement, evidence_text: candidate.evidence_text, limitations: candidate.limitations,
        suggestion: candidate.suggestion, refs: candidate.refs,
        strength: candidate.strength, peak_strength: STRENGTH_RANK[candidate.strength] > STRENGTH_RANK[row.peak_strength] ? candidate.strength : row.peak_strength,
        trend, status: 'active', times_observed: row.times_observed + 1, runs_since_seen: 0,
        last_seen_at: observedAt, last_supported_at: observedAt, last_source_run_id: runId,
      },
    })
  }

  candidates.forEach((candidate, c) => {
    if (claimedCandidates.has(c)) return
    plan.inserts.push({
      candidateIndex: c, observation: observationFor(extraction, candidate, 'new'),
      insert: {
        domain: candidate.domain, kind: candidate.kind, scope_key: candidate.scope_key, stable_key: candidate.stable_key,
        title: candidate.title, statement: candidate.statement, evidence_text: candidate.evidence_text, limitations: candidate.limitations,
        suggestion: candidate.suggestion, strength: candidate.strength, peak_strength: candidate.strength,
        trend: 'new', status: 'active', times_observed: 1, runs_since_seen: 0,
        first_seen_at: observedAt, last_seen_at: observedAt, last_supported_at: observedAt, last_source_run_id: runId, refs: candidate.refs,
      },
    })
  })

  existing.forEach((row, e) => {
    if (claimedExisting.has(e) || !extraction.coverage[row.domain]) return
    if (row.last_source_run_id === runId || Date.parse(row.last_seen_at) >= Date.parse(observedAt)) return
    const misses = row.runs_since_seen + 1
    plan.misses.push({
      insightId: row.id,
      patch: { runs_since_seen: misses, trend: 'unconfirmed', status: misses >= STALE_AFTER_MISSES ? 'stale' : row.status, last_source_run_id: runId },
    })
  })
  return plan
}
