'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { startAudit } from '@/lib/actions/audit'
import type { ActiveLocation } from '@/lib/audit/submissions'

interface Props {
  locations: ActiveLocation[]
  onClose: () => void
}

export default function StartAuditModal({ locations, onClose }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [locationId, setLocationId] = useState('')
  const [managerOnDuty, setManagerOnDuty] = useState('')
  const [error, setError] = useState<string | null>(null)
  const modRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!locationId) { setError('Please select a location.'); return }
    if (!managerOnDuty.trim()) { setError('Manager on Duty is required.'); return }

    startTransition(async () => {
      const result = await startAudit(locationId, managerOnDuty)
      if (result.error) {
        setError(result.error)
        return
      }
      router.push(`/kkc/audit/${result.data!.submissionId}`)
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(23,23,23,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={modRef}
        className="bg-kk-panel border border-kk-line rounded-2xl shadow-2xl w-full max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-audit-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
          <h2 id="start-audit-title" className="text-base font-bold text-kk-ink">
            Start Audit
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-kk-muted hover:text-kk-ink transition-colors rounded-lg"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
          {/* Location */}
          <div>
            <label htmlFor="audit-location" className="block text-xs font-semibold text-kk-ink mb-1.5">
              Location
            </label>
            <select
              id="audit-location"
              value={locationId}
              onChange={e => setLocationId(e.target.value)}
              disabled={isPending}
              className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink disabled:opacity-50"
              required
            >
              <option value="">Select a location…</option>
              {locations.map(l => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          {/* Manager on Duty */}
          <div>
            <label htmlFor="audit-mod" className="block text-xs font-semibold text-kk-ink mb-1.5">
              Manager on Duty
            </label>
            <input
              id="audit-mod"
              type="text"
              value={managerOnDuty}
              onChange={e => setManagerOnDuty(e.target.value)}
              placeholder="Full name"
              maxLength={100}
              disabled={isPending}
              className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink placeholder:text-kk-muted disabled:opacity-50"
              required
              autoFocus
            />
          </div>

          {/* Auditor note */}
          <p className="text-xs text-kk-muted">
            Auditor is recorded automatically as you.
          </p>

          {/* Error */}
          {error && (
            <p className="text-xs text-kk-bad">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="flex-1 py-2.5 text-sm border border-kk-line rounded-xl text-kk-muted hover:text-kk-ink hover:border-kk-ink transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !locationId || !managerOnDuty.trim()}
              className="flex-1 py-2.5 text-sm bg-kk-ink text-white font-semibold rounded-xl disabled:opacity-40 hover:opacity-80 transition-opacity"
            >
              {isPending ? 'Starting…' : 'Start audit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
