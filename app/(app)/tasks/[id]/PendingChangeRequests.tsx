'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveChangeRequest, rejectChangeRequest } from '@/lib/actions/change-requests'

type ChangeRequest = {
  id: string
  proposed_changes: Record<string, unknown>
  reason: string | null
  created_at: string
  requester: { id: string; display_name: string; email: string } | null
}

function formatField(key: string, value: unknown): string {
  if (key === 'due_at' && typeof value === 'string') {
    return new Date(value).toLocaleString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }
  return String(value ?? '—')
}

function RequestCard({ request }: { request: ChangeRequest }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const requester = Array.isArray(request.requester) ? request.requester[0] : request.requester

  async function handleApprove() {
    setError(null)
    startTransition(async () => {
      const result = await approveChangeRequest(request.id)
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  async function handleReject() {
    setError(null)
    startTransition(async () => {
      const result = await rejectChangeRequest(request.id)
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <div className="border border-kk-line rounded-xl p-4 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-kk-muted">
            {requester?.display_name ?? 'Unknown'} ·{' '}
            {new Date(request.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
          {request.reason && (
            <p className="text-sm text-kk-ink mt-0.5">{request.reason}</p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {Object.entries(request.proposed_changes).map(([key, value]) => (
          <div key={key} className="text-xs">
            <span className="font-medium text-kk-ink capitalize">{key.replace(/_/g, ' ')}: </span>
            <span className="text-kk-muted">{formatField(key, value)}</span>
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-kk-bad">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleApprove}
          disabled={isPending}
          className="text-xs px-3 py-1.5 bg-kk-good text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 font-medium"
        >
          {isPending ? '…' : 'Approve'}
        </button>
        <button
          onClick={handleReject}
          disabled={isPending}
          className="text-xs px-3 py-1.5 border border-kk-line text-kk-muted rounded-lg hover:bg-kk-soft transition-colors disabled:opacity-40"
        >
          Reject
        </button>
      </div>
    </div>
  )
}

export default function PendingChangeRequests({ requests }: { requests: ChangeRequest[] }) {
  return (
    <div className="bg-kk-panel border border-kk-warn rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Pending change requests{' '}
          <span className="ml-1 text-xs font-normal text-kk-warn bg-amber-50 px-1.5 py-0.5 rounded-full">
            {requests.length}
          </span>
        </h2>
      </div>
      <div className="p-4 space-y-3">
        {requests.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
      </div>
    </div>
  )
}
