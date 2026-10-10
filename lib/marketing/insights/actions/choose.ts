import type { ImplementRoute } from './eligibility'
import type { ActionStore } from './store'
import { buildTaskFromAction } from './task-text'
import type { ActionRow } from './types'
import type { InsightView } from '../view'

export const DEFAULT_DUE_DAYS = 7
export const MAX_DUE_DAYS = 366

export interface ChooseDeps {
  store: ActionStore
  /** The existing audited task creation (normalizeTaskCreateInput + insertTaskWithAudit). Returns the task id, or null on failure. */
  createTask: (input: { title: string; description: string; ownerUserId: string; dueAt: string }) => Promise<string | null>
  isActiveUser: (userId: string) => Promise<boolean>
  /** Re-checked at the moment of choice: is the recommendation still the latest one and not settled? */
  routeStillValid: (runId: string, index: number) => Promise<ImplementRoute | null>
  now: () => Date
}
export type ChooseResult = { ok: true; action: ActionRow } | { ok: false; error: string }

const copenhagenDay = (now: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(now)
/** A real calendar day, not just something shaped like one (2026-13-40 sorts inside any range as a string). */
const isRealDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/**
 * Chooses ONE drafted option. The claim is atomic, so a double click or two people cannot both choose.
 *   implement_recommendation: records the choice only. Nothing is executed or prepared here: the existing Approve & implement
 *     flow does that, with its own permission, preview, confirmation and budget rules.
 *   manual_task / content_brief: creates one task through the existing audited task creation, for the owner chosen here.
 * Any failure after the claim puts the option back, so it can be chosen again.
 */
export async function chooseAction(deps: ChooseDeps, args: { actionId: string; actorId: string; insight: InsightView; ownerUserId?: string | null; dueOn?: string | null }): Promise<ChooseResult> {
  const found = await deps.store.get(args.actionId)
  if (!found || found.insight_id !== args.insight.id) return { ok: false, error: 'That option no longer exists.' }
  if (found.status !== 'proposed') return { ok: false, error: found.status === 'chosen' || found.status === 'completed' || found.status === 'abandoned' ? 'An option has already been chosen.' : 'That option is out of date. Draft new options.' }

  const today = copenhagenDay(deps.now())
  let ownerId: string | null = null
  let dueOn: string | null = null
  if (found.kind !== 'implement_recommendation') {
    ownerId = args.ownerUserId || args.actorId
    dueOn = args.dueOn || addDays(today, DEFAULT_DUE_DAYS)
    if (!isRealDate(dueOn) || dueOn < today || dueOn > addDays(today, MAX_DUE_DAYS)) return { ok: false, error: 'Choose a due date from today up to a year ahead.' }
    if (!(await deps.isActiveUser(ownerId))) return { ok: false, error: 'The chosen owner is not an active user.' }
  } else if (found.target_run_id === null || found.target_index === null || !(await deps.routeStillValid(found.target_run_id, found.target_index))) {
    return { ok: false, error: 'This recommendation has been superseded or already settled. Draft new options.' }
  }

  const claimed = await deps.store.claimProposed(found.id, args.actorId, deps.now().toISOString())
  if (!claimed) return { ok: false, error: 'An option has already been chosen.' }

  if (found.kind === 'implement_recommendation') {
    await deps.store.markSiblingsNotChosen(found.batch_id, found.id)
    return { ok: true, action: claimed }
  }
  try {
    const { title, description } = buildTaskFromAction(found, args.insight)
    const taskId = await deps.createTask({ title, description, ownerUserId: ownerId!, dueAt: new Date(`${dueOn}T12:00:00Z`).toISOString() })
    if (!taskId) throw new Error('task_failed')
    await deps.store.finishChoice(found.id, { linked_task_id: taskId, owner_user_id: ownerId, due_on: dueOn })
    await deps.store.markSiblingsNotChosen(found.batch_id, found.id)
    return { ok: true, action: { ...claimed, linked_task_id: taskId, owner_user_id: ownerId, due_on: dueOn } }
  } catch {
    await deps.store.release(found.id)
    return { ok: false, error: 'The task could not be created. Nothing was changed; you can choose again.' }
  }
}
