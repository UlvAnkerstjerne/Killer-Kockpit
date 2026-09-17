import { normalizeTaskCreateInput, type NormalizedTaskCreateInput } from '@/lib/domain/task-creation'
import { normalizeTodoCreateInput, type NormalizedTodoCreateInput } from '@/lib/domain/todo-creation'

export type KockpitAction =
  | { action: 'create_task'; input: NormalizedTaskCreateInput }
  | { action: 'create_todo'; input: NormalizedTodoCreateInput }

export type ValidationError = {
  code: 'invalid_payload' | 'unsupported_action' | 'forbidden_actor'
  message: string
  status: number
}

const TASK_FIELDS = new Set([
  'action', 'request_id', 'title', 'description', 'owner_user_id', 'project_id', 'priority', 'due_at',
])
const TODO_FIELDS = new Set([
  'action', 'request_id', 'title', 'notes', 'priority', 'scheduled_for',
])
const ACTOR_FIELDS = new Set(['actor_user_id', 'created_by_user_id', 'user_id'])

export function parseKockpitAction(
  payload: unknown,
  actorUserId: string,
): { data?: KockpitAction; error?: ValidationError } {
  if (!isRecord(payload)) return invalid('Request body must be a JSON object.')

  if (payload.request_id !== undefined && (
    typeof payload.request_id !== 'string' || !payload.request_id.trim()
  )) {
    return invalid('request_id must be a non-empty string when supplied.')
  }

  const actorField = Object.keys(payload).find((key) => ACTOR_FIELDS.has(key))
  if (actorField) {
    return {
      error: {
        code: 'forbidden_actor',
        message: `${actorField} cannot be supplied by the caller.`,
        status: 403,
      },
    }
  }

  if (payload.action !== 'create_task' && payload.action !== 'create_todo') {
    return {
      error: { code: 'unsupported_action', message: 'Unsupported action.', status: 400 },
    }
  }

  const allowed = payload.action === 'create_task' ? TASK_FIELDS : TODO_FIELDS
  const unknownField = Object.keys(payload).find((key) => !allowed.has(key))
  if (unknownField) return invalid(`Unsupported field: ${unknownField}.`)

  if (typeof payload.title !== 'string') return invalid('Title must be a string.')
  if (payload.priority !== undefined && typeof payload.priority !== 'number') {
    return invalid('Priority must be a number.')
  }

  if (payload.action === 'create_task') {
    for (const key of ['description', 'owner_user_id', 'project_id', 'due_at'] as const) {
      if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string') {
        return invalid(`${key} must be a string or null.`)
      }
    }
    if (typeof payload.owner_user_id === 'string' && !payload.owner_user_id.trim()) {
      return invalid('owner_user_id cannot be empty.')
    }
    if (typeof payload.project_id === 'string' && !payload.project_id.trim()) {
      return invalid('project_id cannot be empty.')
    }

    const normalized = normalizeTaskCreateInput({
      title: payload.title,
      description: payload.description as string | null | undefined,
      owner_user_id: payload.owner_user_id as string | null | undefined,
      project_id: payload.project_id as string | null | undefined,
      priority: payload.priority,
      due_at: payload.due_at as string | null | undefined,
    }, actorUserId)
    if (!normalized.ok) return invalid(normalized.error)
    return { data: { action: 'create_task', input: normalized.data } }
  }

  for (const key of ['notes', 'scheduled_for'] as const) {
    if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string') {
      return invalid(`${key} must be a string or null.`)
    }
  }

  const normalized = normalizeTodoCreateInput({
    title: payload.title,
    notes: payload.notes as string | null | undefined,
    priority: payload.priority,
    scheduled_for: payload.scheduled_for as string | null | undefined,
  })
  if (!normalized.ok) return invalid(normalized.error)
  return { data: { action: 'create_todo', input: normalized.data } }
}

function invalid(message: string): { error: ValidationError } {
  return { error: { code: 'invalid_payload', message, status: 400 } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
