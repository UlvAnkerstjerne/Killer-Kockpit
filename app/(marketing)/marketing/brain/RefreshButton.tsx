'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { refreshCreativeIntelligence } from '@/lib/actions/marketing/creative-intelligence'

export default function RefreshButton() {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState('')
  const router = useRouter()
  return <div className="max-w-sm">
    <button type="button" disabled={pending} onClick={() => startTransition(async () => {
      setMessage('')
      try {
        const result = await refreshCreativeIntelligence()
        setMessage(result.ok ? `${result.counts?.classified ?? 0} newly classified · ${result.counts?.skipped ?? 0} unchanged.${result.partial ? ' Partial result; see details below.' : ''}` : result.error ?? 'Refresh failed.')
      } catch {
        setMessage('The refresh was interrupted. Reload to check the latest result before retrying.')
      }
      router.refresh()
    })} className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">
      {pending ? 'Refreshing…' : 'Refresh Creative Intelligence'}
    </button>
    <p role="status" aria-live="polite" className="mt-2 text-xs text-kk-muted">{pending ? 'Classifying new content and checking the evidence. This may take a few minutes.' : message}</p>
  </div>
}
