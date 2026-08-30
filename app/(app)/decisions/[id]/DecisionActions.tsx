'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { approveDecision } from '@/lib/actions/decisions'
import type { DecisionStatus } from '@/lib/types'

export default function DecisionActions({
  decisionId,
  canApprove,
  canEdit,
}: {
  decisionId: string
  canApprove: boolean
  canEdit: boolean
  currentStatus?: DecisionStatus
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="flex gap-2 flex-wrap">
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
        <Link
          href={`/decisions/new?supersedes=${decisionId}`}
          className="text-sm px-4 py-2 border border-kk-line text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Record superseding decision
        </Link>
      )}
      {error && <p className="text-sm text-kk-bad self-center">{error}</p>}
    </div>
  )
}
