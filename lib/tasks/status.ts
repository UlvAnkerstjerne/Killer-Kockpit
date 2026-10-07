// lib/tasks/status.ts
//
// Task status metadata shared by the badge, the edit form and updateTask.
// Pure — safe for client components and unit tests.

import type { TaskStatus } from '@/lib/types'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  proposed:       'Proposed',
  open:           'Open',
  in_progress:    'In progress',
  blocked:        'Blocked',
  pending_review: 'Pending review',
  done:           'Done',
  cancelled:      'Cancelled',
}

/** Statuses a requester may set directly from the edit form. */
export const EDITABLE_TASK_STATUSES = ['proposed', 'open', 'in_progress', 'blocked'] as const satisfies readonly TaskStatus[]

/**
 * Statuses owned by the review/completion workflow. They are entered and left
 * only through submit / approve / send back / complete / cancel / reopen, so the
 * edit form must neither offer them as targets nor let a generic save leave them.
 */
export function isWorkflowManagedStatus(status: TaskStatus | null | undefined): boolean {
  return status === 'pending_review' || status === 'done' || status === 'cancelled'
}

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status as TaskStatus] ?? status.replace(/_/g, ' ')
}
