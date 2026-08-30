'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canRequestTaskChange, canReviewChangeRequest } from '@/lib/permissions'
import type { ActionResult } from '@/lib/types'

/**
 * Submit a change request for task commitment terms.
 * Permitted when the user can see the task but cannot edit its terms directly —
 * i.e., is the assignee or a management-role user.
 */
export async function createTaskChangeRequest(
  taskId: string,
  proposedChanges: Record<string, unknown>,
  reason: string
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  if (!reason.trim()) return { error: 'A reason is required.' }
  if (Object.keys(proposedChanges).length === 0) return { error: 'No changes proposed.' }

  const supabase = await createClient()
  const { data: task, error: fetchError } = await supabase
    .from('tasks')
    .select('id, created_by_user_id, owner_user_id, status')
    .eq('id', taskId)
    .single()

  if (fetchError || !task) return { error: 'Task not found.' }

  if (task.status === 'done' || task.status === 'cancelled') {
    return { error: 'Cannot request changes on a completed or cancelled task.' }
  }

  if (!canRequestTaskChange(user.role, task.created_by_user_id, task.owner_user_id, user.id)) {
    return { error: 'You do not have permission to request changes on this task.' }
  }

  const serviceClient = createServiceClient()
  const { data: requestId, error } = await serviceClient.rpc('create_change_request_and_audit', {
    p_entity_type:      'task',
    p_entity_id:        taskId,
    p_requester_id:     user.id,
    p_proposed_changes: proposedChanges,
    p_reason:           reason.trim(),
  })

  if (error) {
    console.error('[createTaskChangeRequest]', error)
    return { error: 'Failed to submit change request. Please try again.' }
  }

  revalidatePath(`/tasks/${taskId}`)
  return { data: { id: requestId as string } }
}

/**
 * Approve a pending change request.
 * Applies the proposed changes to the task atomically.
 * Only the task creator or SUPER_ADMIN may approve.
 */
export async function approveChangeRequest(
  changeRequestId: string,
  reviewNote?: string
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: cr, error: fetchError } = await supabase
    .from('change_requests')
    .select('*, task:entity_id (created_by_user_id)')
    .eq('id', changeRequestId)
    .eq('status', 'pending')
    .single()

  if (fetchError || !cr) return { error: 'Change request not found or already reviewed.' }

  const taskRow = Array.isArray(cr.task) ? cr.task[0] : cr.task
  const creatorId = taskRow?.created_by_user_id ?? null

  if (!canReviewChangeRequest(user.role, creatorId, user.id)) {
    return { error: 'You do not have permission to approve this change request.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('approve_change_request_and_audit', {
    p_change_request_id: changeRequestId,
    p_reviewer_id:       user.id,
    p_review_note:       reviewNote?.trim() || null,
  })

  if (error) {
    console.error('[approveChangeRequest]', error)
    return { error: 'Failed to approve change request.' }
  }

  revalidatePath(`/tasks/${cr.entity_id}`)
  revalidatePath('/tasks')
  revalidatePath('/today')
  return {}
}

/**
 * Reject a pending change request.
 * Only the task creator or SUPER_ADMIN may reject.
 * The request record is retained in history.
 */
export async function rejectChangeRequest(
  changeRequestId: string,
  reviewNote?: string
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const supabase = await createClient()
  const { data: cr, error: fetchError } = await supabase
    .from('change_requests')
    .select('*, task:entity_id (created_by_user_id)')
    .eq('id', changeRequestId)
    .eq('status', 'pending')
    .single()

  if (fetchError || !cr) return { error: 'Change request not found or already reviewed.' }

  const taskRow = Array.isArray(cr.task) ? cr.task[0] : cr.task
  const creatorId = taskRow?.created_by_user_id ?? null

  if (!canReviewChangeRequest(user.role, creatorId, user.id)) {
    return { error: 'You do not have permission to reject this change request.' }
  }

  const serviceClient = createServiceClient()
  const { error } = await serviceClient.rpc('reject_change_request_and_audit', {
    p_change_request_id: changeRequestId,
    p_reviewer_id:       user.id,
    p_review_note:       reviewNote?.trim() || null,
  })

  if (error) {
    console.error('[rejectChangeRequest]', error)
    return { error: 'Failed to reject change request.' }
  }

  revalidatePath(`/tasks/${cr.entity_id}`)
  return {}
}
