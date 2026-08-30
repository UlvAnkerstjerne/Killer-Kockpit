'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { openMeeting, closeMeeting, cancelMeeting } from '@/lib/actions/meetings'
import type { MeetingStatus } from '@/lib/types'

type Props = {
  meetingId: string
  status: MeetingStatus
  canEdit: boolean
}

export default function MeetingActions({ meetingId, status, canEdit }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-4">
      <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-3">Actions</div>
      <div className="flex flex-col gap-2">
        {status === 'scheduled' && (
          <button
            onClick={() => handle(() => openMeeting(meetingId))}
            disabled={loading}
            className="w-full py-2 bg-kk-warn-bg text-kk-warn text-sm font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Start meeting
          </button>
        )}

        {status === 'open' && (
          <button
            onClick={() => handle(() => closeMeeting(meetingId))}
            disabled={loading}
            className="w-full py-2 bg-purple-50 text-purple-700 text-sm font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Close to draft
          </button>
        )}

        {status === 'draft' && (
          <Link
            href={`/meetings/${meetingId}/publish`}
            className="w-full py-2 bg-kk-good-bg text-kk-good text-sm font-medium rounded-xl hover:opacity-90 transition-opacity text-center block"
          >
            Review & publish
          </Link>
        )}

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
