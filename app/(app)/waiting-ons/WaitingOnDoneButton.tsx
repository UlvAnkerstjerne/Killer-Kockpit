'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fulfillWaitingOn } from '@/lib/actions/waiting-ons'

export function WaitingOnDoneButton({ id }: { id: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDone(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setLoading(true)
    const result = await fulfillWaitingOn(id)
    if (!result.error) {
      router.refresh()
    } else {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleDone}
      disabled={loading}
      title="Mark as fulfilled"
      className="shrink-0 text-xs px-2.5 py-1 rounded-lg border border-kk-line text-kk-muted hover:border-kk-good hover:text-kk-good hover:bg-emerald-50 transition-colors disabled:opacity-40"
    >
      {loading ? '…' : 'Done'}
    </button>
  )
}
