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
import type { ActionResult } from '@/lib/types'

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
 * Marks a non-recurring to-do as completed. Clears cancelled_at if previously set.
 * Only the owner may complete their own to-do (enforced by RLS + .eq filter).
 *
 * For recurring to-dos, call completeRecurringTodo instead — it uses the
 * SECURITY DEFINER RPC that atomically marks completion and spawns the next
 * occurrence.
 */
export async function completeTodo(id: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const now = new Date().toISOString()
  const supabase = await createClient()
  const { error } = await supabase
    .from('todos')
    .update({ completed_at: now, cancelled_at: null, updated_at: now })
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
 * Calls the complete_recurring_todo SECURITY DEFINER RPC via the service-role
 * client. The RPC performs its own SELECT FOR UPDATE lock, ownership check,
 * idempotency guard, and next-occurrence catch-up loop in a single transaction.
 */
export async function completeRecurringTodo(id: string): Promise<ActionResult<{ nextId: string | null }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient.rpc('complete_recurring_todo', {
    p_todo_id:  id,
    p_actor_id: user.id,
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
