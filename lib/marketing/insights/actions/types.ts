/**
 * "Do something about it": turning a durable insight into a chosen action, without a second execution workflow.
 *
 * There are exactly three kinds, and only one of them executes anything:
 *   implement_recommendation  the insight came from a live recommendation of the LATEST Paid Strategy. Choosing it hands over to
 *                             that recommendation's existing Approve & implement flow (its permissions, previews, confirmations
 *                             and budget rules are untouched). Decided by code, never by the model.
 *   manual_task               a person does something. Becomes a task through the existing audited task creation.
 *   content_brief             a brief for a person to produce content. Becomes a task whose description is the brief. Kockpit
 *                             cannot film, publish or schedule content, and nothing here implies it can.
 *
 * Drafting happens only when asked, and nothing is created or run until one option is chosen.
 */

export const ACTION_KINDS = ['implement_recommendation', 'manual_task', 'content_brief'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
export type DraftedKind = Exclude<ActionKind, 'implement_recommendation'>

/**
 * proposed     drafted, waiting for a choice
 * superseded   drafted earlier, replaced by a newer draft
 * not_chosen   a sibling of the option that was chosen
 * chosen       chosen, work in progress (task open, or the implementation under way)
 * completed    the linked task is done / the implementation completed
 * abandoned    the linked task was cancelled / the implementation was rejected, cancelled or failed
 */
export const ACTION_STATUSES = ['proposed', 'superseded', 'not_chosen', 'chosen', 'completed', 'abandoned'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export interface ActionBrief { concept: string; hook: string; key_points: string[]; evidence_basis: string }

/** What the insight looked like when the action finished. Later runs are compared against it; it is observation, never proof of cause. */
export interface ActionOutcome {
  source: 'task' | 'implementation'
  final_status: string
  finished_at: string | null
  insight: { strength: string; trend: string; times_observed: number; last_supported_at: string }
}

export interface ActionRow {
  id: string
  insight_id: string
  batch_id: string
  kind: ActionKind
  status: ActionStatus
  title: string
  why: string
  steps: string[]
  success_signal: string | null
  brief: ActionBrief | null
  target_run_id: string | null
  target_index: number | null
  linked_task_id: string | null
  owner_user_id: string | null
  due_on: string | null
  model: string | null
  prompt_version: string | null
  proposed_by_user_id: string | null
  proposed_at: string
  chosen_by_user_id: string | null
  chosen_at: string | null
  completed_at: string | null
  outcome: ActionOutcome | null
  created_at: string
  updated_at: string
}

export type ActionInsert = Omit<ActionRow, 'id' | 'created_at' | 'updated_at'>

/** What a person sees for an option or action: the row plus the live state of whatever it is linked to. */
export type LiveState =
  | { source: 'task'; status: string; dueAt: string | null; completedAt: string | null }
  | { source: 'implementation'; label: string }
  | null
export interface ActionView extends ActionRow { live: LiveState }

export const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  implement_recommendation: 'Kockpit runs it — you approve', manual_task: 'Task for a person', content_brief: 'Content brief for a person',
}
export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  proposed: 'Waiting for a choice', superseded: 'Replaced', not_chosen: 'Not chosen', chosen: 'In progress', completed: 'Done', abandoned: 'Stopped',
}
