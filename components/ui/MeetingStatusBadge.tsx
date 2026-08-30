import type { MeetingStatus } from '@/lib/types'

const STYLES: Record<MeetingStatus, string> = {
  scheduled: 'bg-blue-50 text-blue-700',
  open:      'bg-kk-warn-bg text-kk-warn',
  draft:     'bg-purple-50 text-purple-700',
  published: 'bg-kk-good-bg text-kk-good',
  cancelled: 'bg-kk-soft text-kk-muted',
}

const LABELS: Record<MeetingStatus, string> = {
  scheduled: 'Scheduled',
  open:      'In Progress',
  draft:     'Draft',
  published: 'Published',
  cancelled: 'Cancelled',
}

export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  )
}
