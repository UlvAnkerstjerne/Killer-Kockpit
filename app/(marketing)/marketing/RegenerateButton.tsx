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
          {state === 'loading' ? 'Regenerating\u2026' : 'Regenerate'}
        </span>
      </button>
      {state === 'error' && errorMsg && (
        <span className="text-xs text-kk-bad">{errorMsg}</span>
      )}
    </div>
  )
}
