import type { WaitingStatus } from '@/lib/types'

const STYLES: Record<WaitingStatus, string> = {
  open:      'bg-blue-50 text-blue-700',
  fulfilled: 'bg-kk-good-bg text-kk-good',
  overdue:   'bg-kk-bad-bg text-kk-bad',
  cancelled: 'bg-kk-soft text-kk-muted',
}

const LABELS: Record<WaitingStatus, string> = {
  open:      'Open',
  fulfilled: 'Fulfilled',
  overdue:   'Overdue',
  cancelled: 'Cancelled',
}

export function WaitingOnStatusBadge({ status }: { status: WaitingStatus }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  )
}
