'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { submitAudit } from '@/lib/actions/audit'

type Phase = 'idle' | 'preparing' | 'confirming' | 'submitting'

export default function AuditSubmitBar({ submissionId }: { submissionId: string }) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setError(null)
    setPhase('preparing')

    // Flush any active textarea/input — triggers blur-save on focused fields
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }

    // Check for partially-filled Top Action rows before debounce window closes
    const sentinel = document.getElementById('audit-partial-action-sentinel')
    if (sentinel?.dataset.partial === 'true') {
      setError(
        'One or more Top Actions are incomplete. Fill in all three fields or remove the incomplete action before submitting.',
      )
      setPhase('idle')
      return
    }

    // Allow the 800 ms debounce + a network round-trip to settle
    await new Promise<void>(r => setTimeout(r, 1200))

    setPhase('confirming')
  }

  async function handleConfirm() {
    setPhase('submitting')
    setError(null)
    const res = await submitAudit(submissionId)
    if (res.error) {
      setError(res.error)
      setPhase('idle')
      return
    }
    router.refresh()
  }

  return (
    <div className="max-w-2xl mx-auto pb-16">
      {error && (
        <div className="mb-4 px-4 py-3 bg-kk-bad-bg border border-kk-bad/30 rounded-xl">
          <p className="text-sm text-kk-bad font-medium">{error}</p>
        </div>
      )}

      {phase === 'confirming' ? (
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-5 py-5">
          <h2 className="text-sm font-bold text-kk-ink mb-1">Submit this audit?</h2>
          <p className="text-sm text-kk-muted mb-4">
            Once submitted, all answers, comments, and actions are locked permanently. This cannot be undone.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleConfirm}
              className="px-5 py-2 bg-kk-ink text-white text-sm font-bold rounded-xl hover:opacity-80 transition-opacity"
            >
              Confirm submission
            </button>
            <button
              type="button"
              onClick={() => { setPhase('idle'); setError(null) }}
              className="px-5 py-2 border border-kk-line text-sm font-semibold text-kk-muted rounded-xl hover:border-kk-ink hover:text-kk-ink transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={phase !== 'idle'}
          className="w-full py-3 bg-kk-ink text-white text-sm font-bold rounded-xl hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase === 'preparing'
            ? 'Checking…'
            : phase === 'submitting'
            ? 'Submitting…'
            : 'Submit audit'}
        </button>
      )}
    </div>
  )
}
