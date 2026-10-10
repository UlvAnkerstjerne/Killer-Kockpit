import type { ActionInsert, ActionOutcome, ActionRow, ActionStatus } from './types'

/** Persistence for actions. Implemented over Supabase (service role, after the caller authorized) and in memory for tests. */
export interface ActionStore {
  listForInsight(insightId: string): Promise<ActionRow[]>
  get(id: string): Promise<ActionRow | null>
  insertBatch(rows: ActionInsert[]): Promise<ActionRow[]>
  /** Only touches rows still 'proposed'. */
  supersedeProposed(insightId: string): Promise<void>
  /** Atomic: succeeds for exactly one caller while the row is still 'proposed'. Returns null when it was not. */
  claimProposed(id: string, actorId: string, at: string): Promise<ActionRow | null>
  /** Undo a claim whose follow-up failed, so the option can be chosen again. Only from 'chosen' without a task. */
  release(id: string): Promise<void>
  finishChoice(id: string, patch: { linked_task_id: string | null; owner_user_id: string | null; due_on: string | null }): Promise<void>
  markSiblingsNotChosen(batchId: string, exceptId: string): Promise<void>
  /** Chosen actions that have not finished. */
  listOpen(): Promise<ActionRow[]>
  /** Only moves a 'chosen' row to a final status, once. */
  recordOutcome(id: string, patch: { status: Extract<ActionStatus, 'completed' | 'abandoned'>; completed_at: string | null; outcome: ActionOutcome }): Promise<void>
}
