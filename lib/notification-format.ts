/**
 * lib/notification-format.ts — pure, client-safe notification helpers
 *
 * Separated from lib/actions/notifications.ts ('use server') so that
 * client components can import the presentation logic without violating
 * Next.js's rule that all exports from 'use server' files must be async.
 */

export type NotificationType =
  | 'task.assigned'
  | 'task.submitted_for_review'
  | 'task.sent_back'
  | 'task.approved'

/**
 * Derives a concise human-readable notification message.
 *
 * actor  — display name of the actor, or a fallback when unknown
 * title  — current task title, or a fallback when unavailable
 *
 * Examples:
 *   task.assigned             → "Adam assigned you "Film videos for SSP""
 *   task.submitted_for_review → "Adam submitted "Film videos for SSP" for your review"
 *   task.sent_back            → "Ulv sent "Film videos for SSP" back to you"
 *   task.approved             → "Ulv approved "Film videos for SSP""
 */
export function formatNotificationMessage(
  type:      NotificationType,
  actorName: string | null,
  taskTitle: string | null,
): string {
  const actor = actorName ?? 'Someone'
  const title = taskTitle ?? 'a task'

  switch (type) {
    case 'task.assigned':             return `${actor} assigned you "${title}"`
    case 'task.submitted_for_review': return `${actor} submitted "${title}" for your review`
    case 'task.sent_back':            return `${actor} sent "${title}" back to you`
    case 'task.approved':             return `${actor} approved "${title}"`
  }
}
