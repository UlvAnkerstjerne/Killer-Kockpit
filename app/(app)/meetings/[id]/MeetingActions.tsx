'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cancelMeeting, reopenMeeting } from '@/lib/actions/meetings'
import type { MeetingStatus } from '@/lib/types'

type Props = {
  meetingId: string
  status:    MeetingStatus
  canEdit:   boolean
}

export default function MeetingActions({ meetingId, status, canEdit }: Props) {
  const router   = useRouter()
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  async function handle(action: () => Promise<{ error?: string }>) {
    setLoading(true)
    setError(null)
    const result = await action()
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.refresh()
      setLoading(false)
    }
  }

  if (!canEdit) return null

  if (status === 'cancelled') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-4">
        <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-3">Actions</div>
        <button
          onClick={() => handle(() => reopenMeeting(meetingId))}
          disabled={loading}
          className="w-full py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
        >
          {loading ? '…' : 'Reopen meeting'}
        </button>
        {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
      </div>
    )
  }

  // Only show the actions card for active meetings that have something to do
  if (status === 'published') return null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-4">
      <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-3">Actions</div>
      <div className="flex flex-col gap-2">

        {/* Review & publish — shown when meeting is in draft */}
        {status === 'draft' && (
          <Link
            href={`/meetings/${meetingId}/publish`}
            className="w-full py-2 bg-kk-good-bg text-kk-good text-sm font-medium rounded-xl hover:opacity-90 transition-opacity text-center block"
          >
            Review &amp; publish
          </Link>
        )}

        {/* Cancel */}
        {(status === 'scheduled' || status === 'open' || status === 'draft') && (
          <button
            onClick={() => handle(() => cancelMeeting(meetingId))}
            disabled={loading}
            className="w-full py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
          >
            Cancel meeting
          </button>
        )}

      </div>
      {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
    </div>
  )
}
