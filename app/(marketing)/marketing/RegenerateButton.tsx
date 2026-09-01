'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { triggerMorningBriefRegen } from '@/lib/actions/marketing/morning-brief'

/**
 * SUPER_ADMIN only. The sole client component on the Morning Brief page.
 * Calls the server action then refreshes to show updated state.
 */
export default function RegenerateButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleClick() {
    setState('loading')
    setErrorMsg(null)
    const result = await triggerMorningBriefRegen()
    if (result.error) {
      setState('error')
      setErrorMsg(result.error)
    } else {
      setState('idle')
      router.refresh()
    }
  }

  return (
    <div className="flex items-center gap-3 shrink-0">
      <button
        onClick={handleClick}
        disabled={state === 'loading'}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-kk-line bg-kk-panel text-sm text-kk-ink hover:bg-kk-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {state === 'loading' ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="animate-spin shrink-0" aria-hidden="true">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="22 10"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0" aria-hidden="true">
            <path d="M12 7a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
            <path d="M10.5 3.5H13v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
        )}
        {state === 'loading' ? 'Regenerating…' : 'Regenerate'}
      </button>
      {state === 'error' && errorMsg && (
        <span className="text-xs text-kk-bad">{errorMsg}</span>
      )}
    </div>
  )
}
