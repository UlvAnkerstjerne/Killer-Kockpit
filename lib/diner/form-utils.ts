/**
 * lib/diner/form-utils.ts
 *
 * Pure utility functions for the Mystery Diner questionnaire.
 * No side effects, no imports from Node.js or Next.js — safe in client components.
 */

import type { DinerCheckpoint, DinerResponsesMap } from './types'

// ─── Waiting time logic ───────────────────────────────────────────────────────

/** True when the 20+ band is selected — critical flag at submit. */
export function isWaitingTimeCritical(band: string | null): boolean {
  return band === '20+'
}

/**
 * True when conditional checkpoints (11, 12) should be visible.
 * Conditional checkpoints only apply when the actual wait exceeded 15 minutes.
 */
export function shouldShowConditional(waitingTimeBand: string | null): boolean {
  return waitingTimeBand === '16-20' || waitingTimeBand === '20+'
}

// ─── Progress computation ────────────────────────────────────────────────────

export interface ProgressStats {
  answered: number
  total:    number
  pct:      number
}

/**
 * Computes how many visible, scoreable checkpoints have a response.
 * Informational checkpoints are excluded from the count.
 * Conditional checkpoints only count when showConditionals is true.
 */
export function computeProgress(
  checkpoints:      DinerCheckpoint[],
  responses:        DinerResponsesMap,
  showConditionals: boolean,
): ProgressStats {
  const visible = checkpoints.filter(cp => {
    if (cp.type === 'informational') return false
    if (cp.is_conditional && !showConditionals) return false
    return true
  })

  const answered = visible.filter(cp => {
    const r = responses[cp.id]
    if (!r) return false
    if (cp.type === 'waiting_time') return r.notes.trim() !== ''
    return r.result !== null
  }).length

  const total = visible.length
  const pct   = total > 0 ? Math.round((answered / total) * 100) : 0

  return { answered, total, pct }
}

// ─── Section grouping ────────────────────────────────────────────────────────

/**
 * Groups checkpoints into an ordered Map keyed by section name.
 * Preserves insertion order so sections appear in protocol order.
 */
export function groupCheckpointsBySection(
  checkpoints: DinerCheckpoint[],
): Map<string, DinerCheckpoint[]> {
  const map = new Map<string, DinerCheckpoint[]>()
  for (const cp of checkpoints) {
    const group = map.get(cp.section) ?? []
    group.push(cp)
    map.set(cp.section, group)
  }
  return map
}

// ─── Waiting time checkpoint lookup ──────────────────────────────────────────

/** Finds the waiting_time checkpoint in the list (there is exactly one). */
export function findWaitingTimeCheckpoint(
  checkpoints: DinerCheckpoint[],
): DinerCheckpoint | undefined {
  return checkpoints.find(cp => cp.type === 'waiting_time')
}

/**
 * Extracts the current waiting time band from the responses map.
 * Returns null if the waiting time question has not been answered.
 */
export function getWaitingTimeBand(
  checkpoints: DinerCheckpoint[],
  responses:   DinerResponsesMap,
): string | null {
  const cp = findWaitingTimeCheckpoint(checkpoints)
  if (!cp) return null
  const band = responses[cp.id]?.notes?.trim()
  return band || null
}
