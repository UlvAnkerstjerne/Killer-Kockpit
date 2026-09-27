'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { generateAndSavePaidRecommendations } from '@/lib/actions/marketing/paid-recommendations'

/**
 * SUPER_ADMIN only. Triggers the production Paid Recommendations generation pipeline.
 * Same visual pattern as the Morning Brief RegenerateButton.
 */
export default function RegenerateRecsButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function handleClick() {
    setState('loading')
    setMessage(null)
    const result = await generateAndSavePaidRecommendations()
    if (!result.ok) {
      setState('error')
      setMessage(result.error ?? 'Generation failed.')
    } else if (result.skipped) {
      setState('done')
      setMessage(result.signalCount
        ? `${result.signalCount} signal(s) suppressed \u2014 campaigns already have active recommendations.`
        : 'No material signals detected.')
    } else {
      setState('done')
      setMessage(`Generated ${result.recommendationCount} recommendation(s) from ${result.signalCount} signal(s).`)
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <button
        onClick={handleClick}
        disabled={state === 'loading'}
        className="group flex flex-col items-center gap-1 cursor-pointer disabled:cursor-not-allowed"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/kk-regenerate.png"
          alt=""
          className={`h-44 w-auto mix-blend-multiply transition-transform group-hover:scale-110 group-active:scale-95 ${state === 'loading' ? 'animate-spin-slow opacity-60' : ''}`}
        />
        <span className={`text-xs font-semibold ${state === 'loading' ? 'text-kk-muted' : 'text-kk-brand group-hover:underline'}`}>
          {state === 'loading' ? 'Regenerating\u2026' : 'Regenerate recommendations'}
        </span>
      </button>
      {message && (
        <span className={`text-xs ${state === 'error' ? 'text-kk-bad' : 'text-kk-muted'}`}>{message}</span>
      )}
    </div>
  )
}
