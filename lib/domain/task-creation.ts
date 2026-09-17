import type { SupabaseClient } from '@supabase/supabase-js'
import type { TaskPriority, TaskStatus } from '@/lib/types'

export type TaskCreateInput = {
  title: string
  description?: string | null
  owner_user_id?: string | null
  project_id?: string | null
  meeting_id?: string | null
  status?: TaskStatus
  priority?: TaskPriority | number
  due_at?: string | null
}

export type NormalizedTaskCreateInput = {
  title: string
  description: string | null
  owner_user_id: string
  project_id: string | null
  meeting_id: string | null
  status: TaskStatus
  priority: TaskPriority
  due_at: string | null
}

type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string }

const TASK_STATUSES: TaskStatus[] = [
  'proposed', 'open', 'in_progress', 'blocked', 'pending_review', 'done', 'cancelled',
]

/** Shared validation/normalisation for every server-side task creation path. */
export function normalizeTaskCreateInput(
  input: TaskCreateInput,
  actorUserId: string,
): ValidationResult<NormalizedTaskCreateInput> {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'Title is required.' }

  const priority = input.priority ?? 2
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    return { ok: false, error: 'Priority must be 1, 2, 3, or 4.' }
  }

  const status = input.status ?? 'open'
  if (!TASK_STATUSES.includes(status)) return { ok: false, error: 'Invalid task status.' }

  const dueAt = input.due_at?.trim() || null
  if (dueAt && !isValidDateTime(dueAt)) return { ok: false, error: 'Due date is malformed.' }

  return {
    ok: true,
    data: {
      title,
      description: input.description?.trim() || null,
      owner_user_id: input.owner_user_id || actorUserId,
      project_id: input.project_id || null,
      meeting_id: input.meeting_id || null,
      status,
      priority: priority as TaskPriority,
      due_at: dueAt,
    },
  }
}

/** Uses the existing audited RPC; callers must supply a server-resolved actor. */
export async function insertTaskWithAudit(
  client: SupabaseClient,
  actorUserId: string,
  input: NormalizedTaskCreateInput,
): Promise<{ id?: string; error?: unknown }> {
  const { data, error } = await client.rpc('create_task_and_audit', {
    p_title: input.title,
    p_description: input.description,
    p_owner_user_id: input.owner_user_id,
    p_project_id: input.project_id,
    p_status: input.status,
    p_priority: input.priority,
    p_due_at: input.due_at,
    p_created_by_user_id: actorUserId,
    p_actor_user_id: actorUserId,
    p_meeting_id: input.meeting_id,
  })

  if (error || !data) return { error: error ?? new Error('Task RPC returned no id.') }
  return { id: data as string }
}

function isValidDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}
