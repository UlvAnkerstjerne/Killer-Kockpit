import type { ProjectStatus, TaskStatus } from '@/lib/types'

const PROJECT_STATUS_STYLES: Record<ProjectStatus, string> = {
  planned:   'bg-kk-soft text-kk-muted',
  active:    'bg-kk-good-bg text-kk-good',
  at_risk:   'bg-kk-warn-bg text-kk-warn',
  blocked:   'bg-kk-bad-bg text-kk-bad',
  completed: 'bg-kk-good-bg text-kk-good',
  archived:  'bg-kk-soft text-kk-muted',
}

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned:   'Planned',
  active:    'Active',
  at_risk:   'At risk',
  blocked:   'Blocked',
  completed: 'Completed',
  archived:  'Archived',
}

const TASK_STATUS_STYLES: Record<TaskStatus, string> = {
  proposed:    'bg-kk-soft text-kk-muted',
  open:        'bg-blue-50 text-blue-700',
  in_progress: 'bg-kk-warn-bg text-kk-warn',
  blocked:     'bg-kk-bad-bg text-kk-bad',
  done:        'bg-kk-good-bg text-kk-good',
  cancelled:   'bg-kk-soft text-kk-muted',
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  proposed:    'Proposed',
  open:        'Open',
  in_progress: 'In progress',
  blocked:     'Blocked',
  done:        'Done',
  cancelled:   'Cancelled',
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${PROJECT_STATUS_STYLES[status]}`}>
      {PROJECT_STATUS_LABELS[status]}
    </span>
  )
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${TASK_STATUS_STYLES[status]}`}>
      {TASK_STATUS_LABELS[status]}
    </span>
  )
}

const PRIORITY_LABELS: Record<number, string> = { 1: 'Critical', 2: 'Normal', 3: 'Low', 4: 'Background' }
const PRIORITY_STYLES: Record<number, string> = {
  1: 'bg-kk-bad-bg text-kk-bad',
  2: 'bg-kk-soft text-kk-muted',
  3: 'bg-kk-soft text-kk-muted',
  4: 'bg-kk-soft text-kk-muted',
}

export function PriorityBadge({ priority }: { priority: number }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_STYLES[priority] || PRIORITY_STYLES[2]}`}>
      {PRIORITY_LABELS[priority] || 'Normal'}
    </span>
  )
}
