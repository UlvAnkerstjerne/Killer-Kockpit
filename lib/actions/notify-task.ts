'use server'

/**
 * lib/actions/notify-task.ts — N3 notification write helpers
 *
 * Provides createTaskNotification(), a fire-and-forget helper called from
 * task lifecycle server actions (createTask, updateTask, submitTaskForReview,
 * approveTask, sendTaskBack).
 *
 * Security model:
 *   - Uses createServiceClient (service_role) — bypasses RLS to INSERT into
 *     notifications, which has no client-role INSERT policy by design.
 *   - Self-notification guard: actor === recipient → silent no-op.
 *   - Null recipient guard: missing owner_user_id → silent no-op.
 *   - Fire-and-forget: errors are logged but never propagate to the caller.
 *     Notification failure must never fail the task action.
 *
 * entity_type is always 'task' in N3. Future entity types (N4+) will require
 * a separate helper or an extended interface.
 */

import { createServiceClient } from '@/lib/supabase/server'
import type { NotificationType } from '@/lib/actions/notifications'

export interface TaskNotificationInput {
  type:            NotificationType
  taskId:          string
  recipientUserId: string
  actorUserId:     string
}

/**
 * Inserts one notification row via service_role.
 *
 * Silently skips when:
 *   - recipientUserId === actorUserId  (no self-notifications)
 *   - either ID is falsy              (defensive null guard)
 *
 * Never throws — errors are console-logged only.
 */
export async function createTaskNotification(
  input: TaskNotificationInput,
): Promise<void> {
  const { type, taskId, recipientUserId, actorUserId } = input

  // Guard: no self-notifications; no missing IDs
  if (!recipientUserId || !actorUserId || recipientUserId === actorUserId) return

  try {
    const serviceClient = createServiceClient()
    const { error } = await serviceClient.from('notifications').insert({
      type,
      entity_type:      'task',
      entity_id:         taskId,
      recipient_user_id: recipientUserId,
      actor_user_id:     actorUserId,
    })

    if (error) {
      console.error('[createTaskNotification]', type, error.message)
    }
  } catch (err) {
    console.error('[createTaskNotification] unexpected error', err)
  }
}
