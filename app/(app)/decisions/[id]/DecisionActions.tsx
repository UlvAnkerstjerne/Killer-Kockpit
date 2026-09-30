'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { approveDecision, notifyDecisionMembers } from '@/lib/actions/decisions'
import type { DecisionStatus } from '@/lib/types'

export default function DecisionActions({
  decisionId,
  canApprove,
  canEdit,
  canNotify,
}: {
  decisionId: string
  canApprove: boolean
  canEdit: boolean
  canNotify: boolean
  currentStatus?: DecisionStatus
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notifyStatus, setNotifyStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null)

  async function handleApprove() {
    setLoading(true)
    setError(null)
    const result = await approveDecision(decisionId)
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.refresh()
    }
  }

  async function handleNotify() {
    if (notifyStatus === 'sending') return
    setNotifyStatus('sending')
    setNotifyMessage(null)
    setError(null)

    const result = await notifyDecisionMembers(decisionId)

    if (result.error) {
      setError(result.error)
      setNotifyStatus('idle')
      return
    }

    const { sent, skipped } = result.data!
    setNotifyStatus('sent')
    setNotifyMessage(
      sent > 0
        ? `Notified ${sent} member${sent === 1 ? '' : 's'}`
        : skipped > 0
          ? 'All members were already notified'
          : 'No other active members to notify'
    )
    router.refresh()
  }

  return (
    <div className="flex gap-2 flex-wrap items-center">
      {canApprove && (
        <button
          onClick={handleApprove}
          disabled={loading}
          className="text-sm px-4 py-2 bg-kk-good text-white rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 font-medium"
        >
          Approve
        </button>
      )}
      {canEdit && (
        <>
          <Link
            href={`/decisions/${decisionId}/edit`}
            className="text-sm px-4 py-2 bg-kk-ink text-white rounded-xl hover:opacity-90 transition-opacity font-medium"
          >
            Edit
          </Link>
          <Link
            href={`/decisions/new?supersedes=${decisionId}`}
            className="text-sm px-4 py-2 border border-kk-line text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
          >
            Record superseding decision
          </Link>
        </>
      )}
      {canNotify && (
        <button
          onClick={handleNotify}
          disabled={notifyStatus === 'sending'}
          className="text-sm px-4 py-2 border border-kk-line text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
        >
          {notifyStatus === 'sending' ? 'Sending…' : 'Notify all members'}
        </button>
      )}
      {error && <p className="text-sm text-kk-bad self-center">{error}</p>}
      {notifyMessage && <p className="text-sm text-kk-good self-center">{notifyMessage}</p>}
    </div>
  )
}
