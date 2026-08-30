'use client'

import { useState } from 'react'
import { fulfillWaitingOn, cancelWaitingOn } from '@/lib/actions/waiting-ons'
import { useRouter } from 'next/navigation'

export default function WaitingOnActions({ waitingOnId }: { waitingOnId: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handle(action: 'fulfill' | 'cancel') {
    setLoading(true)
    setError(null)
    const result = action === 'fulfill'
      ? await fulfillWaitingOn(waitingOnId)
      : await cancelWaitingOn(waitingOnId)
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.refresh()
    }
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => handle('fulfill')}
        disabled={loading}
        className="text-sm px-4 py-2 bg-kk-good text-white rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 font-medium"
      >
        Mark as fulfilled
      </button>
      <button
        onClick={() => handle('cancel')}
        disabled={loading}
        className="text-sm px-4 py-2 border border-kk-line text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
      >
        Cancel
      </button>
      {error && <p className="text-sm text-kk-bad self-center">{error}</p>}
    </div>
  )
}
