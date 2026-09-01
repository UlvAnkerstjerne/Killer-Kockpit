'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { triggerMorningBriefRegen } from '@/lib/actions/marketing/morning-brief'

/**
 * SUPER_ADMIN only. The sole client component on the Morning Brief page.
 * All other content is server-rendered.
 *
 * Calls the server action, then refreshes the page to show the new brief.
 * Does not optimistically update UI — the brief may take 30–60 seconds to generate.
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
    <div className="flex items-center gap-3">
      <button
        onClick={handleClick}
        disabled={state === 'loading'}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-kk-line bg-kk-panel text-xs font-medium text-kk-ink hover:bg-kk-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          className={state === 'loading' ? 'animate-spin' : ''}
          aria-hidden="true"
        >
          <path
            d="M11.5 6.5A5 5 0 1 1 6.5 1.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M6.5 1.5 9 4 6.5 1.5Z"
            fill="currentColor"
          />
          <polyline
            points="6.5,1.5 9,4 4,4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {state === 'loading' ? 'Regenerating…' : 'Regenerate'}
      </button>
      {state === 'error' && errorMsg && (
        <span className="text-xs text-kk-bad">{errorMsg}</span>
      )}
    </div>
  )
}
