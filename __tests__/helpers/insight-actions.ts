import type { ActionStore } from '@/lib/marketing/insights/actions/store'
import type { ActionInsert, ActionRow } from '@/lib/marketing/insights/actions/types'

export const stamp = (n: number) => new Date(Date.UTC(2026, 9, n, 9, 0, 0)).toISOString()

export function actionRow(over: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 'act-1', insight_id: 'ins-1', batch_id: 'batch-1', kind: 'manual_task', status: 'proposed', title: 'Add two more ads to the catering ad set',
    why: 'The insight says the catering ad set runs on a single ad.', steps: ['Open the ad set in Ads Manager', 'Add two ads with different openings'],
    success_signal: 'Whether the next analysis still flags the ad set.', brief: null, target_run_id: null, target_index: null, linked_task_id: null, owner_user_id: null,
    due_on: null, model: 'synthetic-model', prompt_version: '2026-10-14-v1', proposed_by_user_id: 'u1', proposed_at: stamp(1), chosen_by_user_id: null, chosen_at: null,
    completed_at: null, outcome: null, created_at: stamp(1), updated_at: stamp(1), ...over,
  }
}

/** In-memory ActionStore with the same atomic claim the database gives. */
export function memoryActionStore(seed: ActionRow[] = []) {
  const rows = new Map<string, ActionRow>(seed.map(r => [r.id, r]))
  let seq = 0
  const failOn = new Set<string>()
  const guard = (op: string) => { if (failOn.has(op)) { failOn.delete(op); throw new Error(`boom:${op}`) } }
  const store: ActionStore = {
    async listForInsight(id) { return [...rows.values()].filter(r => r.insight_id === id).map(r => ({ ...r })) },
    async get(id) { const r = rows.get(id); return r ? { ...r } : null },
    async insertBatch(inserts: ActionInsert[]) {
      guard('insertBatch')
      return inserts.map(i => { const row = { ...i, id: `act-new-${++seq}`, created_at: i.proposed_at, updated_at: i.proposed_at } as ActionRow; rows.set(row.id, row); return { ...row } })
    },
    async supersedeProposed(insightId) { for (const r of rows.values()) if (r.insight_id === insightId && r.status === 'proposed') r.status = 'superseded' },
    async claimProposed(id, actorId, at) {
      const r = rows.get(id)
      if (!r || r.status !== 'proposed') return null
      // marketing_insight_actions_one_choice_idx: one chosen / finished option per draft
      if ([...rows.values()].some(o => o.batch_id === r.batch_id && o.id !== r.id && ['chosen', 'completed', 'abandoned'].includes(o.status))) return null
      r.status = 'chosen'; r.chosen_by_user_id = actorId; r.chosen_at = at
      return { ...r }
    },
    async release(id) { const r = rows.get(id); if (r && r.status === 'chosen' && !r.linked_task_id) { r.status = 'proposed'; r.chosen_by_user_id = null; r.chosen_at = null } },
    async finishChoice(id, patch) { guard('finishChoice'); Object.assign(rows.get(id)!, patch) },
    async markSiblingsNotChosen(batchId, exceptId) { for (const r of rows.values()) if (r.batch_id === batchId && r.id !== exceptId && r.status === 'proposed') r.status = 'not_chosen' },
    async listOpen() { return [...rows.values()].filter(r => r.status === 'chosen').map(r => ({ ...r })) },
    async recordOutcome(id, patch) { const r = rows.get(id); if (r && r.status === 'chosen') Object.assign(r, patch) },
  }
  return { store, rows, failOn, all: () => [...rows.values()] }
}
