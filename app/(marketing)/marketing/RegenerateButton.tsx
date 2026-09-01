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
        className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {state === 'loading' ? 'Regenerating…' : 'Regenerate'}
      </button>
      {state === 'error' && errorMsg && (
        <span className="text-xs text-kk-bad">{errorMsg}</span>
      )}
    </div>
  )
}
