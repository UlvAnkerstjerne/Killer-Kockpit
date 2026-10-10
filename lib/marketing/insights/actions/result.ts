import { STRENGTH_RANK, type InsightStrength } from '../types'
import type { ActionOutcome } from './types'

export type InsightSince = 'strengthened' | 'weakened' | 'unchanged' | 'not_yet_reobserved'

/**
 * How the insight looks NOW compared with the moment the action finished. Observation, never proof that the action caused it:
 * a later analysis may differ for many reasons. Null when the action has not finished.
 */
export function insightSinceAction(outcome: ActionOutcome | null | undefined, current: { strength: string; times_observed: number }): InsightSince | null {
  if (!outcome) return null
  if (current.times_observed <= outcome.insight.times_observed) return 'not_yet_reobserved'
  const rank = (s: string) => STRENGTH_RANK[s as InsightStrength] ?? 0
  const then = rank(outcome.insight.strength); const now = rank(current.strength)
  return now > then ? 'strengthened' : now < then ? 'weakened' : 'unchanged'
}

export const SINCE_LABEL: Record<InsightSince, string> = {
  strengthened: 'the insight looks stronger in later analyses', weakened: 'the insight looks weaker in later analyses',
  unchanged: 'the insight looks about the same in later analyses', not_yet_reobserved: 'no later analysis has looked at it yet',
}
