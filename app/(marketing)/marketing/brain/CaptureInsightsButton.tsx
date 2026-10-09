'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { captureMarketingInsights } from '@/lib/actions/marketing/insights'

/** SUPER_ADMIN only (the action re-checks). Replays saved runs so insights from before this feature appear; safe to repeat. */
export default function CaptureInsightsButton({ label = 'Capture insights from saved runs' }: { label?: string }) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState('')
  const router = useRouter()
  return <div className="max-w-sm">
    <button type="button" disabled={pending} onClick={() => startTransition(async () => {
      setMessage('')
      try {
        const result = await captureMarketingInsights()
        setMessage(result.ok ? result.message : result.error)
      } catch {
        setMessage('Capturing was interrupted. Reload to check, then try again.')
      }
      router.refresh()
    })} className="rounded-xl border border-kk-line bg-kk-panel px-4 py-2 text-sm font-medium disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">
      {pending ? 'Capturing…' : label}
    </button>
    <p role="status" aria-live="polite" className="mt-2 text-xs text-kk-muted">{message}</p>
  </div>
}
