import type { ActionRow } from './types'
import type { InsightView } from '../view'

const MAX_TITLE = 160

/**
 * The task a chosen manual option becomes. Tasks have no provenance field, so the description says where it came from and the
 * action row (marketing_insight_actions.linked_task_id) is the real link. A content brief is a task whose description holds the
 * brief, and says in plain words that a person produces it: Kockpit does not film, publish or schedule content.
 */
export function buildTaskFromAction(action: Pick<ActionRow, 'kind' | 'title' | 'why' | 'steps' | 'success_signal' | 'brief'>, insight: Pick<InsightView, 'title' | 'statement' | 'evidence_text' | 'limitations' | 'strength'>): { title: string; description: string } {
  const lines: string[] = []
  lines.push(`**Why**\n${action.why}`)
  lines.push(`**Steps**\n${action.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  if (action.kind === 'content_brief' && action.brief) {
    lines.push([
      '**Content brief** (for a person to produce; Kockpit does not film, publish or schedule content)',
      `Concept: ${action.brief.concept}`, `Opening hook: ${action.brief.hook}`,
      `Key points:\n${action.brief.key_points.map(p => `- ${p}`).join('\n')}`, `Evidence basis: ${action.brief.evidence_basis}`,
    ].join('\n'))
  }
  if (action.success_signal) lines.push(`**What to look at afterwards**\n${action.success_signal}`)
  const evidence = [`Insight: ${insight.title}`, insight.statement, insight.evidence_text ? `Evidence: ${insight.evidence_text}` : null, insight.limitations ? `What we do not know: ${insight.limitations}` : null].filter(Boolean).join('\n')
  lines.push(`**The insight behind this**\n${evidence}`)
  lines.push('_Created from a CMO insight (Marketing → CMO). The result is tracked against that insight._')
  return { title: action.title.trim().slice(0, MAX_TITLE), description: lines.join('\n\n') }
}
