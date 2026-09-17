import type { SupabaseClient } from '@supabase/supabase-js'
import { computeFirstOccurrence } from '@/lib/todos/recurrence'
import type { RecurrenceRule } from '@/lib/todos/recurrence'
import type { TaskPriority } from '@/lib/types'

export type TodoCreateInput = {
  title: string
  priority?: number
  notes?: string | null
  scheduled_for?: string | null
  recurrence_rule?: string | null
  recurrence_day?: number | null
}

export type NormalizedTodoCreateInput = {
  title: string
  priority: TaskPriority
  notes: string | null
  scheduled_for: string | null
  recurrence_rule: RecurrenceRule | null
  recurrence_day: number | null
}

type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string }

const RECURRENCE_RULES: RecurrenceRule[] = [
  'daily', 'weekdays', 'weekly', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'monthly',
]

/** Shared validation/normalisation for every server-side personal To-Do creation path. */
export function normalizeTodoCreateInput(
  input: TodoCreateInput,
  now: Date = new Date(),
): ValidationResult<NormalizedTodoCreateInput> {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'Title is required.' }

  const priority = input.priority ?? 2
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    return { ok: false, error: 'Priority must be 1, 2, 3, or 4.' }
  }

  const recurrenceRule = input.recurrence_rule || null
  if (recurrenceRule && !RECURRENCE_RULES.includes(recurrenceRule as RecurrenceRule)) {
    return { ok: false, error: 'Invalid recurrence rule.' }
  }

  const recurrenceDay = recurrenceRule === 'monthly' ? (input.recurrence_day ?? null) : null
  if (recurrenceRule === 'monthly' && (
    !Number.isInteger(recurrenceDay) || recurrenceDay! < 1 || recurrenceDay! > 31
  )) {
    return { ok: false, error: 'Monthly recurrence day must be between 1 and 31.' }
  }

  let scheduledFor = input.scheduled_for?.trim() || null
  if (scheduledFor && !isValidIsoDate(scheduledFor)) {
    return { ok: false, error: 'Scheduled date must use YYYY-MM-DD.' }
  }

  if (recurrenceRule) {
    scheduledFor = computeFirstOccurrence(
      recurrenceRule as RecurrenceRule,
      recurrenceDay,
      now,
    )
  }

  return {
    ok: true,
    data: {
      title,
      priority: priority as TaskPriority,
      notes: input.notes?.trim() || null,
      scheduled_for: scheduledFor,
      recurrence_rule: recurrenceRule as RecurrenceRule | null,
      recurrence_day: recurrenceDay,
    },
  }
}

/** Inserts a personal To-Do for an already authenticated/resolved actor. */
export async function insertTodoForActor(
  client: SupabaseClient,
  actorUserId: string,
  input: NormalizedTodoCreateInput,
): Promise<{ id?: string; error?: unknown }> {
  const payload: Record<string, unknown> = {
    user_id: actorUserId,
    title: input.title,
    priority: input.priority,
  }

  if (input.notes) payload.notes = input.notes
  if (input.scheduled_for) payload.scheduled_for = input.scheduled_for
  if (input.recurrence_rule) {
    payload.recurrence_rule = input.recurrence_rule
    payload.recurrence_day = input.recurrence_day
  }

  const { data, error } = await client
    .from('todos')
    .insert(payload)
    .select('id')
    .single()

  if (error || !data) return { error: error ?? new Error('To-Do insert returned no id.') }
  return { id: data.id as string }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}
