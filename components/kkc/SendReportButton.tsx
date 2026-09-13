'use client'

/**
 * components/kkc/SendReportButton.tsx
 *
 * Reusable "Send report" button + inline modal for single completed reports.
 * Used on the Audit detail page, Mystery Diner result page, and SSP/CPH detail panel.
 *
 * Calls POST /api/reports/send-single — auth is verified server-side.
 */

import { useState, useTransition } from 'react'

interface Props {
  system:       'audit' | 'ssp_cph' | 'diner'
  submissionId: string
  /** Optional label override; defaults to "Send report" */
  label?:       string
}

export default function SendReportButton({ system, submissionId, label = 'Send report' }: Props) {
  const [open, setOpen]             = useState(false)
  const [email, setEmail]           = useState('')
  const [status, setStatus]         = useState<'idle' | 'sent' | 'error'>('idle')
  const [errorMsg, setErrorMsg]     = useState('')
  const [isPending, startTransition] = useTransition()

  function handleClose() {
    setOpen(false)
    setEmail('')
    setStatus('idle')
    setErrorMsg('')
  }

  function handleSend() {
    if (!email.trim()) { setErrorMsg('Enter an email address.'); return }
    setErrorMsg('')

    startTransition(async () => {
      try {
        const res = await fetch('/api/reports/send-single', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ system, submissionId, email: email.trim() }),
        })
        const json = await res.json().catch(() => ({}))

        if (!res.ok || !json.ok) {
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

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-kk-ink bg-kk-soft border border-kk-line rounded-lg hover:bg-kk-line transition-colors"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M2 4l6 4 6-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          <rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
        </svg>
        {label}
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
              <p className="font-bold text-kk-ink">Send report</p>
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
                  <p className="text-sm font-semibold text-kk-good">Report sent</p>
                  <p className="text-xs text-kk-muted">{email}</p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-[0.08em] text-kk-muted mb-1.5">
                      Recipient email
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => { setEmail(e.target.value); setErrorMsg('') }}
                      onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
                      placeholder="name@company.com"
                      disabled={isPending}
                      className="w-full px-3 py-2.5 text-sm border border-kk-line rounded-xl bg-white text-kk-ink placeholder-kk-muted/50 focus:outline-none focus:ring-2 focus:ring-kk-ink/20 focus:border-kk-ink/40 disabled:opacity-40"
                    />
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
                      disabled={isPending || !email.trim()}
                      className="flex-1 px-3 py-2 text-sm font-bold text-white bg-kk-ink rounded-xl hover:opacity-80 transition-opacity disabled:opacity-40"
                    >
                      {isPending ? 'Sending…' : 'Send report'}
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
