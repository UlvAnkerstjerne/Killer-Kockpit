import type { WeeklyImpactBrief, WeeklyImpactEvidence } from './types'
import { isOperationalEvidence } from './activity-clusters'

export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
export function briefWordCount(brief: WeeklyImpactBrief): number {
  return countWords([brief.openingSynthesis, ...brief.themes.flatMap(theme => [theme.heading, theme.synthesis]), ...brief.whatMoved.map(bullet => bullet.text), ...brief.goingIntoNextWeek.map(bullet => bullet.text)].join(' '))
}

/** Source boundaries only. Wording and interpretation belong to the prompt and human review. */
export function validateWeeklyImpactBrief(brief: WeeklyImpactBrief, evidence: WeeklyImpactEvidence) {
  const weekIds = new Set([...evidence.completedTodos, ...evidence.completedTasks, ...evidence.movedProjects,
    ...evidence.resolvedWaitingOns, ...evidence.decisions, ...evidence.authoredUpdates, ...evidence.meetings].filter(isOperationalEvidence).map(item => item.id))
  const nextIds = new Set(evidence.nextWeek.map(item => item.id))
  for (const [entries, allowed] of [[ [...brief.themes, ...brief.whatMoved], weekIds ], [brief.goingIntoNextWeek, nextIds]] as const) {
    for (const entry of entries) {
      if (entry.evidenceIds.some(id => !allowed.has(id))) throw new Error('Brief cited evidence outside the allowed reporting section.')
    }
  }
}
