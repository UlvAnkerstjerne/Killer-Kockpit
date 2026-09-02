'use server'

/**
 * lib/actions/todos.ts
 *
 * Server actions for personal To-Do items.
 *
 * Security model
 * ─��────────────
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
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import type { ActionResult } from '@/lib/types'

// ---------------------------------------------------------------------------
// createTodo
// ---------------------------------------------------------------------------

/**
 * Creates a new open to-do for the currently authenticated user.
 * Ownership is derived server-side — no user_id from the caller.
 */
export async function createTodo(
  title: string,
  priority: number = 2,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const trimmed = title.trim()
  if (!trimmed) return { error: 'Title is required.' }
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    return { error: 'Priority must be 1, 2, 3, or 4.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('todos')
    .insert({ user_id: user.id, title: trimmed, priority })
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
// completeTodo
// ---------------------------------------------------------------------------

/**
 * Marks a to-do as completed. Clears cancelled_at if previously set.
 * Only the owner may complete their own to-do (enforced by RLS + .eq filter).
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
