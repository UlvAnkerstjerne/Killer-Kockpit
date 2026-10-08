'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { generatePaidStrategyAnalysis } from '@/lib/actions/marketing/paid-strategy'

export default function PaidStrategyButton() {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState('')
  const router = useRouter()
  return <div className="max-w-sm">
    <button type="button" disabled={pending} onClick={() => startTransition(async () => {
      setMessage('')
      try {
        const result = await generatePaidStrategyAnalysis()
        setMessage(result.ok ? `Analysis complete: ${result.recommendationCount ?? 0} recommendation${result.recommendationCount === 1 ? '' : 's'}.` : result.error ?? 'Generation failed.')
      } catch {
        setMessage('The analysis was interrupted. Reload to check the latest result before retrying.')
      }
      router.refresh()
    })} className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">
      {pending ? 'Analysing…' : 'Generate Paid Strategy'}
    </button>
    <p role="status" aria-live="polite" className="mt-2 text-xs text-kk-muted">{pending ? 'Reading stored Meta Ads data and running the analysis. This can take a minute or two.' : message}</p>
  </div>
}
