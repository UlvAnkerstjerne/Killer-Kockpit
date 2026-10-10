import type { InsightActionContext, InsightActionOptionsResult } from '@/lib/ai/insight-actions'
import { INSIGHT_ACTIONS_PROMPT_VERSION } from '@/lib/ai/insight-actions'
import type { ImplementRoute } from './eligibility'
import type { ActionStore } from './store'
import type { ActionInsert, ActionRow, DraftedKind } from './types'
import type { InsightView } from '../view'

export interface ProposeDeps {
  store: ActionStore
  call: (context: InsightActionContext, grounding: string) => Promise<InsightActionOptionsResult>
  newId: () => string
  now: () => Date
}
export type ProposeResult = { ok: true; actions: ActionRow[]; reused: boolean } | { ok: false; error: string }

const CONTENT_DOMAINS = new Set(['organic', 'creative'])
export const COUNT_WITH_ROUTE = { min: 1, max: 2 } as const     // plus the one deterministic route = 2-3 in total
export const COUNT_WITHOUT_ROUTE = { min: 2, max: 3 } as const

/**
 * Drafts 2-3 options for ONE insight, only when asked. Nothing is created, assigned or run: it stores the drafts so that the one
 * the person chooses is the text the server drafted, not text a browser sends back. Existing drafts are reused (no second model
 * call) unless a fresh draft is requested.
 */
export async function proposeActions(deps: ProposeDeps, args: { insight: InsightView; actorId: string; route: ImplementRoute | null; redraft?: boolean }): Promise<ProposeResult> {
  const { insight, actorId, route } = args
  const existing = await deps.store.listForInsight(insight.id)
  const open = existing.filter(a => a.status === 'proposed')
  if (open.length && !args.redraft) return { ok: true, actions: open, reused: true }

  const allowedKinds: DraftedKind[] = CONTENT_DOMAINS.has(insight.domain) ? ['manual_task', 'content_brief'] : ['manual_task']
  const count = route ? COUNT_WITH_ROUTE : COUNT_WITHOUT_ROUTE
  const tried = existing.filter(a => a.status === 'chosen' || a.status === 'completed' || a.status === 'abandoned').slice(0, 4)
  const grounding = [insight.title, insight.statement, insight.evidence_text, insight.limitations, insight.suggestion, route?.title, route?.test, route?.successMetric, ...tried.map(a => a.title)].filter(Boolean).join('\n')
  const result = await deps.call({
    insight: { kind: insight.kind, domain: insight.domain, strength: insight.strength, trend: insight.trend, seen_in_runs: insight.times_observed,
      title: insight.title, statement: insight.statement, evidence: insight.evidence_text, limitations: insight.limitations, suggestion: insight.suggestion },
    allowedKinds, count, alreadyTried: tried.map(a => ({ what: a.title, status: a.status })),
    existingRecommendation: route ? { title: route.title, test: route.test } : null,
  }, grounding)
  if (!result.ok) return { ok: false, error: result.error }

  const batch = deps.newId()
  const at = deps.now().toISOString()
  const base = { insight_id: insight.id, batch_id: batch, status: 'proposed' as const, target_run_id: null, target_index: null, linked_task_id: null, owner_user_id: null, due_on: null,
    proposed_by_user_id: actorId, proposed_at: at, chosen_by_user_id: null, chosen_at: null, completed_at: null, outcome: null }
  const rows: ActionInsert[] = []
  if (route) {
    rows.push({
      ...base, kind: 'implement_recommendation', title: route.title, target_run_id: route.runId, target_index: route.index,
      why: `This insight comes from recommendation ${route.index + 1} of the latest Paid Strategy. Choosing this opens that recommendation’s own Approve & implement flow. You still preview and confirm there, and nothing runs until you do.`,
      steps: ['Review the preview Kockpit prepares for this recommendation', 'Confirm it in the Approve & implement panel, or reject it'],
      success_signal: route.successMetric, brief: null, model: null, prompt_version: null,
    })
  }
  for (const o of result.options) {
    rows.push({ ...base, kind: o.kind, title: o.title, why: o.why, steps: o.steps, success_signal: o.success_signal, brief: o.brief, model: result.model, prompt_version: INSIGHT_ACTIONS_PROMPT_VERSION })
  }
  await deps.store.supersedeProposed(insight.id) // only after a successful draft: a failed request leaves earlier drafts alone
  return { ok: true, actions: await deps.store.insertBatch(rows), reused: false }
}
