import type { DecisionStatus } from '@/lib/types'

const STYLES: Record<DecisionStatus, string> = {
  proposed:   'bg-kk-soft text-kk-muted',
  approved:   'bg-kk-good-bg text-kk-good',
  superseded: 'bg-kk-soft text-kk-muted',
}

const LABELS: Record<DecisionStatus, string> = {
  proposed:   'Proposed',
  approved:   'Approved',
  superseded: 'Superseded',
}

export function DecisionStatusBadge({ status }: { status: DecisionStatus }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  )
}
