'use client'

import { useState } from 'react'
import { fulfillWaitingOn, cancelWaitingOn, reopenWaitingOn } from '@/lib/actions/waiting-ons'
import { useRouter } from 'next/navigation'
import type { WaitingStatus } from '@/lib/types'

export default function WaitingOnActions({
  waitingOnId,
  status,
}: {
  waitingOnId: string
  status: WaitingStatus
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isTerminal = status === 'fulfilled' || status === 'cancelled'

  async function handle(action: () => Promise<{ error?: string }>) {
    setLoading(true)
    setError(null)
    const result = await action()
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.refresh()
    }
  }

  if (isTerminal) {
    return (
      <div className="flex gap-2">
        <button
          onClick={() => handle(() => reopenWaitingOn(waitingOnId))}
          disabled={loading}
          className="text-sm px-4 py-2 border border-kk-line text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
        >
          {loading ? '…' : 'Reopen'}
        </button>
        {error && <p className="text-sm text-kk-bad self-center">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => handle(() => fulfillWaitingOn(waitingOnId))}
        disabled={loading}
        className="text-sm px-4 py-2 bg-kk-good text-white rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 font-medium"
      >
        Mark as fulfilled
      </button>
      <button
        onClick={() => handle(() => cancelWaitingOn(waitingOnId))}
        disabled={loading}
        className="text-sm px-4 py-2 border border-kk-line text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
      >
        Cancel
      </button>
      {error && <p className="text-sm text-kk-bad self-center">{error}</p>}
    </div>
  )
}
