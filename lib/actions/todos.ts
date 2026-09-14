'use server'

/**
 * lib/actions/todos.ts
 *
 * Server actions for personal To-Do items.
 *
 * Security model
 * ─────────────
 * • User identity always comes from getCurrentUser() — never from the caller.
 * • No caller-supplied user_id is ever used to determine ownership.
 * • createClient() (user session) is used for all DB operations so RLS applies
 *   as a second independent layer of enforcement.
 * • The todos table RLS requires user_id = get_my_app_user_id() on all
 *   SELECT / INSERT / UPDATE. A compromised server action cannot affect
 *   another user's todos — the DB will reject it.
 * • The .eq('user_id', user.id) filter in mutations is belt-and-suspenders:
 *   redundant with RLS but makes intent explicit and prevents accidental
 *   cross-user mutations if RLS were ever misconfigured.
 * • completeRecurringTodo uses createServiceClient() to call the SECURITY
 *   DEFINER RPC, which performs its own ownership check inside the DB.
 */

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { computeFirstOccurrence } from '@/lib/todos/recurrence'
import type { RecurrenceRule } from '@/lib/todos/recurrence'
import type { ActionResult, TaskPriority } from '@/lib/types'

// ---------------------------------------------------------------------------
// createTodo
// ---------------------------------------------------------------------------

/**
 * Creates a new open to-do for the currently authenticated user.
 * Ownership is derived server-side — no user_id from the caller.
 *
 * If recurrenceRule is supplied, scheduled_for is computed server-side in
 * Europe/Copenhagen time and stored on the row.
 */
export async function createTodo(
  title: string,
  priority: number = 2,
  notes?: string | null,
  recurrenceRule?: string | null,
  recurrenceDay?: number | null,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const trimmed = title.trim()
  if (!trimmed) return { error: 'Title is required.' }
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    return { error: 'Priority must be 1, 2, 3, or 4.' }
  }

  const payload: Record<string, unknown> = {
    user_id: user.id,
    title:   trimmed,
    priority,
  }

  // Normalise notes: whitespace-only → null
  const normalizedNotes = notes?.trim() || null
  if (normalizedNotes) payload.notes = normalizedNotes

  // Recurrence
  if (recurrenceRule) {
    payload.recurrence_rule = recurrenceRule
    // recurrence_day is only meaningful for 'monthly'
    payload.recurrence_day = recurrenceRule === 'monthly' ? (recurrenceDay ?? null) : null
    // Compute first occurrence anchor in Copenhagen time
    payload.scheduled_for = computeFirstOccurrence(
      recurrenceRule as RecurrenceRule,
      recurrenceRule === 'monthly' ? (recurrenceDay ?? null) : null,
      new Date(),
    )
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('todos')
    .insert(payload)
    .select('id')
    .single()

  if (error || !data) {
    console.error('[createTodo]', error)
    return { error: 'Failed to create to-do. Please try again.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  return { data: { id: data.id as string } }
}

// ---------------------------------------------------------------------------
// completeTodo  (non-recurring path)
// ---------------------------------------------------------------------------

/**
 * Marks a non-recurring to-do as completed.
 *
 * A non-blank completion context is required — it is stored alongside
 * completed_at and completed_by_user_id for history and Brain context.
 *
 * For recurring to-dos, call completeRecurringTodo instead.
 */
export async function completeTodo(id: string, context: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const trimmedContext = context.trim()
  if (!trimmedContext) return { error: 'Please add context before marking as done.' }

  const now = new Date().toISOString()
  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update({
      completed_at:         now,
      cancelled_at:         null,
      updated_at:           now,
      completion_context:   trimmedContext,
      completed_by_user_id: user.id,
    })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[completeTodo]', error)
    return { error: 'Failed to complete to-do. Please try again.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  return {}
}

// ---------------------------------------------------------------------------
// completeRecurringTodo  (recurring path — calls SECURITY DEFINER RPC)
// ---------------------------------------------------------------------------

/**
 * Atomically completes a recurring to-do and spawns the next occurrence.
 *
 * A non-blank completion context is required — stored on the completed row
 * for history and Brain context.
 *
 * Calls the complete_recurring_todo SECURITY DEFINER RPC, which performs its
 * own SELECT FOR UPDATE lock, ownership check, idempotency guard, catch-up
 * loop, and next-occurrence insert — all in a single transaction. Completion
 * context and completed_by_user_id are written inside the same transaction,
 * so either everything succeeds or everything fails together.
 */
export async function completeRecurringTodo(id: string, context: string): Promise<ActionResult<{ nextId: string | null }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const trimmedContext = context.trim()
  if (!trimmedContext) return { error: 'Please add context before marking as done.' }

  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient.rpc('complete_recurring_todo', {
    p_todo_id:              id,
    p_actor_id:             user.id,
    p_completion_context:   trimmedContext,
    p_completed_by_user_id: user.id,
  })

  if (error) {
    console.error('[completeRecurringTodo]', error)
    return { error: 'Failed to complete to-do. Please try again.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  return { data: { nextId: data as string | null } }
}

// ---------------------------------------------------------------------------
// cancelTodo
// ---------------------------------------------------------------------------

/**
 * Marks a to-do as cancelled. Clears completed_at if previously set.
 * Only the owner may cancel their own to-do.
 */
export async function cancelTodo(id: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const now = new Date().toISOString()
  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update({ cancelled_at: now, completed_at: null, updated_at: now })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[cancelTodo]', error)
    return { error: 'Failed to cancel to-do. Please try again.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  return {}
}

// ---------------------------------------------------------------------------
// reopenTodo
// ---------------------------------------------------------------------------

/**
 * Reopens a completed or cancelled to-do. Clears both terminal timestamps.
 * Only the owner may reopen their own to-do.
 */
export async function reopenTodo(id: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const now = new Date().toISOString()
  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update({ completed_at: null, cancelled_at: null, updated_at: now })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[reopenTodo]', error)
    return { error: 'Failed to reopen to-do. Please try again.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  return {}
}

// ---------------------------------------------------------------------------
// updateTodoNotes
// ---------------------------------------------------------------------------

/**
 * Updates the notes on a to-do.
 * Whitespace-only notes are normalised to NULL.
 * Only the owner may update their own to-do's notes.
 */
export async function updateTodoNotes(id: string, notes: string | null): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const normalized = notes?.trim() || null
  const now = new Date().toISOString()

  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update({ notes: normalized, updated_at: now })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[updateTodoNotes]', error)
    return { error: 'Failed to update notes.' }
  }

  revalidatePath('/todos')
  return {}
}

// ---------------------------------------------------------------------------
// updateTodo
// ---------------------------------------------------------------------------

/**
 * Updates editable scalar fields on an open to-do: title, priority, scheduled_for.
 * Only the owner may update their own to-do (enforced by RLS + .eq filter).
 *
 * For recurring todos the recurrence system owns scheduled_for — callers should
 * use updateTodoRecurrence to change the rule and let it recompute scheduled_for.
 * Non-recurring todos may have scheduled_for set freely via this action.
 */
export async function updateTodo(
  id: string,
  input: { title?: string; priority?: number; scheduled_for?: string | null },
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (input.title !== undefined) {
    const trimmed = input.title.trim()
    if (!trimmed) return { error: 'Title is required.' }
    patch.title = trimmed
  }

  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 4) {
      return { error: 'Priority must be 1, 2, 3, or 4.' }
    }
    patch.priority = input.priority
  }

  if ('scheduled_for' in input) {
    patch.scheduled_for = input.scheduled_for ?? null
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[updateTodo]', error)
    return { error: 'Failed to update to-do.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  return {}
}

// ---------------------------------------------------------------------------
// updateTodoRecurrence
// ---------------------------------------------------------------------------

/**
 * Updates the recurrence rule on an existing to-do.
 * Recomputes scheduled_for when a rule is set; clears it when rule is removed.
 * Only the owner may update their own to-do's recurrence.
 */
export async function updateTodoRecurrence(
  id: string,
  rule: string | null,
  day: number | null,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const now = new Date().toISOString()

  let scheduled_for: string | null = null
  if (rule) {
    scheduled_for = computeFirstOccurrence(rule as RecurrenceRule, day, new Date())
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update({
      recurrence_rule: rule,
      recurrence_day:  rule === 'monthly' ? day : null,
      scheduled_for,
      updated_at: now,
    })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[updateTodoRecurrence]', error)
    return { error: 'Failed to update recurrence.' }
  }

  revalidatePath('/todos')
  revalidatePath('/today')
  return {}
}

// ---------------------------------------------------------------------------
// upgradeTodoToTask
// ---------------------------------------------------------------------------

/**
 * Promotes an active to-do into a proper Task.
 *
 * Security model
 * ─────────────
 * • User identity comes from getCurrentUser() — never from the caller.
 * • Ownership of the to-do is verified via createClient() (user JWT + RLS)
 *   before the service client is used for task creation.
 * • The final todo update is scoped by .eq('user_id', user.id) as belt-and-
 *   suspenders even though we use the service client.
 *
 * Side effects
 * ───────────
 * • Creates a task via the audited create_task_and_audit RPC.
 * • Sets tasks.source_todo_id = todoId (provenance on the task side).
 * • Sets todos.upgraded_to_task_id = taskId and todos.upgraded_at = now
 *   (provenance + removal from active list on the to-do side).
 */
export async function upgradeTodoToTask(
  todoId: string,
  input: {
    title: string
    description?: string | null
    owner_user_id: string
    project_id?: string | null
    priority: TaskPriority
    due_at?: string | null
  },
): Promise<ActionResult<{ taskId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const trimmed = input.title.trim()
  if (!trimmed) return { error: 'Title is required.' }

  // Verify the todo exists, belongs to this user, and is upgradeable.
  const supabase = await createClient()
  const { data: todo, error: fetchError } = await supabase
    .from('todos')
    .select('id, user_id, completed_at, cancelled_at, upgraded_to_task_id')
    .eq('id', todoId)
    .eq('user_id', user.id)
    .single()

  if (fetchError || !todo) return { error: 'To-do not found.' }
  if (todo.completed_at) return { error: 'Completed to-dos cannot be upgraded.' }
  if (todo.cancelled_at) return { error: 'Cancelled to-dos cannot be upgraded.' }
  if (todo.upgraded_to_task_id) return { error: 'This to-do has already been upgraded to a task.' }

  const serviceClient = createServiceClient()

  // 1. Create the task via the audited RPC.
  const { data: taskId, error: createError } = await serviceClient.rpc('create_task_and_audit', {
    p_title:              trimmed,
    p_description:        input.description?.trim() || null,
    p_owner_user_id:      input.owner_user_id || user.id,
    p_project_id:         input.project_id || null,
    p_status:             'open',
    p_priority:           input.priority || 2,
    p_due_at:             input.due_at || null,
    p_created_by_user_id: user.id,
    p_actor_user_id:      user.id,
  })

  if (createError || !taskId) {
    console.error('[upgradeTodoToTask:create]', createError)
    return { error: 'Failed to create task. Please try again.' }
  }

  // 2. Record source provenance on the task.
  const { error: taskPatchError } = await serviceClient
    .from('tasks')
    .update({ source_todo_id: todoId })
    .eq('id', taskId as string)

  if (taskPatchError) {
    console.error('[upgradeTodoToTask:taskPatch]', taskPatchError)
    // Non-fatal: task was created; provenance missing but data intact.
  }

  // 3. Mark the to-do as upgraded (removes it from the active list).
  const now = new Date().toISOString()
  const { error: todoUpdateError } = await serviceClient
    .from('todos')
    .update({ upgraded_to_task_id: taskId, upgraded_at: now, updated_at: now })
    .eq('id', todoId)
    .eq('user_id', user.id)

  if (todoUpdateError) {
    console.error('[upgradeTodoToTask:todoUpdate]', todoUpdateError)
    return { error: 'Task created but could not update the to-do. Please refresh.' }
  }

  revalidatePath('/today')
  revalidatePath('/todos')
  revalidatePath('/tasks')

  return { data: { taskId: taskId as string } }
}
