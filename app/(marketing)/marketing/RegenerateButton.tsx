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
        title={state === 'loading' ? 'Regenerating…' : 'Regenerate Morning Brief'}
        className="group relative disabled:cursor-not-allowed"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/kk-regenerate.png"
          alt="Regenerate"
          className={`h-44 w-auto mix-blend-multiply transition-transform group-hover:scale-110 group-active:scale-95 ${state === 'loading' ? 'animate-pulse opacity-60' : ''}`}
        />
      </button>
      {state === 'error' && errorMsg && (
        <span className="text-xs text-kk-bad">{errorMsg}</span>
      )}
    </div>
  )
}
