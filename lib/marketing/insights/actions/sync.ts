import type { ActionStore } from './store'
import type { ActionOutcome } from './types'
import type { InsightRow } from '../types'

export interface TaskState { id: string; status: string; completed_at: string | null; approved_at: string | null; updated_at: string | null }
export interface ImplementationState { strategy_run_id: string; recommendation_index: number; status: string; completed_at: string | null; updated_at: string | null }
export interface SyncDeps {
  store: ActionStore
  readTasks: (ids: string[]) => Promise<TaskState[]>
  readImplementations: (keys: { runId: string; index: number }[]) => Promise<ImplementationState[]>
  readInsights: (ids: string[]) => Promise<Pick<InsightRow, 'id' | 'strength' | 'trend' | 'times_observed' | 'last_supported_at'>[]>
}

/** Implementation statuses that mean it is over. in_motion / started are LIVE (still running or being monitored), so not final. */
const IMPLEMENTATION_DONE = new Set(['completed'])
const IMPLEMENTATION_STOPPED = new Set(['rejected', 'cancelled', 'failed'])

/**
 * Records how chosen actions ended, once, so a later analysis can see what people did about an insight and what the insight looked
 * like when they finished. The state is read from the existing task and implementation rows: nothing is duplicated, and nothing
 * here changes either. Idempotent: only a 'chosen' action can move to a final status.
 */
export async function syncActionResults(deps: SyncDeps): Promise<{ completed: number; abandoned: number }> {
  const open = await deps.store.listOpen()
  if (!open.length) return { completed: 0, abandoned: 0 }
  const tasks = new Map((await deps.readTasks(open.flatMap(a => (a.linked_task_id ? [a.linked_task_id] : [])))).map(t => [t.id, t]))
  const impls = await deps.readImplementations(open.flatMap(a => (a.target_run_id !== null && a.target_index !== null ? [{ runId: a.target_run_id, index: a.target_index }] : [])))
  const implByKey = new Map(impls.map(i => [`${i.strategy_run_id}:${i.recommendation_index}`, i]))
  const insights = new Map((await deps.readInsights([...new Set(open.map(a => a.insight_id))])).map(i => [i.id, i]))
  const out = { completed: 0, abandoned: 0 }

  for (const action of open) {
    let source: ActionOutcome['source'] | null = null
    let finalStatus: string | null = null
    let finishedAt: string | null = null
    let result: 'completed' | 'abandoned' | null = null
    if (action.linked_task_id) {
      const task = tasks.get(action.linked_task_id)
      if (task?.status === 'done') { source = 'task'; finalStatus = 'done'; result = 'completed'; finishedAt = task.completed_at ?? task.approved_at ?? task.updated_at }
      else if (task?.status === 'cancelled') { source = 'task'; finalStatus = 'cancelled'; result = 'abandoned'; finishedAt = task.updated_at }
    } else if (action.target_run_id !== null && action.target_index !== null) {
      const impl = implByKey.get(`${action.target_run_id}:${action.target_index}`)
      if (impl && IMPLEMENTATION_DONE.has(impl.status)) { source = 'implementation'; finalStatus = impl.status; result = 'completed'; finishedAt = impl.completed_at ?? impl.updated_at }
      else if (impl && IMPLEMENTATION_STOPPED.has(impl.status)) { source = 'implementation'; finalStatus = impl.status; result = 'abandoned'; finishedAt = impl.updated_at }
    }
    if (!result || !source || !finalStatus) continue
    const insight = insights.get(action.insight_id)
    await deps.store.recordOutcome(action.id, {
      status: result, completed_at: finishedAt,
      outcome: { source, final_status: finalStatus, finished_at: finishedAt, insight: { strength: insight?.strength ?? 'unknown', trend: insight?.trend ?? 'unknown', times_observed: insight?.times_observed ?? 0, last_supported_at: insight?.last_supported_at ?? '' } },
    })
    out[result === 'completed' ? 'completed' : 'abandoned']++
  }
  return out
}
