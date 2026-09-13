'use client'

/**
 * components/kkc/SendOverviewButton.tsx
 *
 * Reusable "Send overview" button + modal for sending combined overview PDFs.
 * Supports location filtering (pass locations=[]) and preset count options.
 *
 * Calls POST /api/reports/send-overview — auth is verified server-side.
 */

import { useState, useTransition } from 'react'

interface Location {
  id:   string
  name: string
}

interface Props {
  system:     'audit' | 'ssp_cph' | 'diner'
  locations?: Location[]   // if omitted, no location filter is shown
}

const COUNT_PRESETS = [4, 10, 20] as const

export default function SendOverviewButton({ system, locations = [] }: Props) {
  const [open, setOpen]               = useState(false)
  const [email, setEmail]             = useState('')
  const [locationId, setLocationId]   = useState('')
  const [count, setCount]             = useState<number>(10)
  const [customCount, setCustomCount] = useState('')
  const [useCustom, setUseCustom]     = useState(false)
  const [status, setStatus]           = useState<'idle' | 'sent' | 'error'>('idle')
  const [errorMsg, setErrorMsg]       = useState('')
  const [isPending, startTransition]  = useTransition()

  function handleClose() {
    setOpen(false)
    setEmail('')
    setLocationId('')
    setCount(10)
    setCustomCount('')
    setUseCustom(false)
    setStatus('idle')
    setErrorMsg('')
  }

  function effectiveCount(): number {
    if (useCustom) {
      const n = parseInt(customCount, 10)
      return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 0
    }
    return count
  }

  function handleSend() {
    const n = effectiveCount()
    if (!email.trim())       { setErrorMsg('Enter an email address.');    return }
    if (n < 1)               { setErrorMsg('Enter a valid report count.'); return }
    setErrorMsg('')

    startTransition(async () => {
      try {
        const body: Record<string, unknown> = { system, email: email.trim(), count: n }
        if (locationId) body.locationId = locationId

        const res = await fetch('/api/reports/send-overview', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        })
        const json = await res.json().catch(() => ({}))

        if (!res.ok || !(json as { ok: boolean }).ok) {
          setStatus('error')
          setErrorMsg((json as { error?: string }).error ?? 'Something went wrong. Please try again.')
        } else {
          setStatus('sent')
        }
      } catch {
        setStatus('error')
        setErrorMsg('Network error. Please try again.')
      }
    })
  }

  const showLocations = locations.length > 0 && system !== 'ssp_cph'

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-kk-ink bg-kk-soft border border-kk-line rounded-lg hover:bg-kk-line transition-colors"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8 2v10M3 7l5 5 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M2 14h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
        Send overview
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(23,23,23,0.35)', backdropFilter: 'blur(3px)' }}
          onClick={handleClose}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
              <p className="font-bold text-kk-ink">Send overview</p>
              <button onClick={handleClose} className="text-kk-muted hover:text-kk-ink transition-colors" aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {status === 'sent' ? (
                <div className="text-center py-4 space-y-2">
                  <div className="text-2xl">✓</div>
                  <p className="text-sm font-semibold text-kk-good">Overview sent</p>
                  <p className="text-xs text-kk-muted">{email}</p>
                </div>
              ) : (
                <>
                  {/* Email */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-1.5">
                      Recipient email
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => { setEmail(e.target.value); setErrorMsg('') }}
                      placeholder="name@company.com"
                      disabled={isPending}
                      className="w-full px-3 py-2.5 text-sm border border-kk-line rounded-xl bg-white text-kk-ink placeholder-kk-muted/50 focus:outline-none focus:ring-2 focus:ring-kk-ink/20 focus:border-kk-ink/40 disabled:opacity-40"
                    />
                  </div>

                  {/* Location filter */}
                  {showLocations && (
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-1.5">
                        Location
                      </label>
                      <select
                        value={locationId}
                        onChange={e => { setLocationId(e.target.value); setErrorMsg('') }}
                        disabled={isPending}
                        className="w-full px-3 py-2.5 text-sm border border-kk-line rounded-xl bg-white text-kk-ink focus:outline-none focus:ring-2 focus:ring-kk-ink/20 disabled:opacity-40"
                      >
                        <option value="">All locations</option>
                        {locations.map(l => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Report count */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-1.5">
                      Number of reports
                    </label>
                    <div className="flex gap-1.5 flex-wrap">
                      {COUNT_PRESETS.map(n => (
                        <button
                          key={n}
                          onClick={() => { setCount(n); setUseCustom(false); setErrorMsg('') }}
                          disabled={isPending}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                            !useCustom && count === n
                              ? 'bg-kk-ink text-white border-kk-ink'
                              : 'bg-kk-soft text-kk-ink border-kk-line hover:bg-kk-line'
                          }`}
                        >
                          Last {n}
                        </button>
                      ))}
                      <button
                        onClick={() => { setUseCustom(true); setErrorMsg('') }}
                        disabled={isPending}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                          useCustom
                            ? 'bg-kk-ink text-white border-kk-ink'
                            : 'bg-kk-soft text-kk-ink border-kk-line hover:bg-kk-line'
                        }`}
                      >
                        Custom
                      </button>
                    </div>
                    {useCustom && (
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={customCount}
                        onChange={e => { setCustomCount(e.target.value); setErrorMsg('') }}
                        placeholder="e.g. 15 (max 50)"
                        disabled={isPending}
                        className="mt-2 w-full px-3 py-2.5 text-sm border border-kk-line rounded-xl bg-white text-kk-ink placeholder-kk-muted/50 focus:outline-none focus:ring-2 focus:ring-kk-ink/20 disabled:opacity-40"
                      />
                    )}
                  </div>

                  {errorMsg && (
                    <p className="text-xs text-kk-bad">{errorMsg}</p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleClose}
                      className="flex-1 px-3 py-2 text-sm font-medium text-kk-muted bg-kk-soft border border-kk-line rounded-xl hover:bg-kk-line transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSend}
                      disabled={isPending || !email.trim() || effectiveCount() < 1}
                      className="flex-1 px-3 py-2 text-sm font-bold text-white bg-kk-ink rounded-xl hover:opacity-80 transition-opacity disabled:opacity-40"
                    >
                      {isPending ? 'Sending…' : 'Send overview'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
