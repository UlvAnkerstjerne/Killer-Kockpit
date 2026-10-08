'use client'

import { useState, useTransition } from 'react'
import { addAiCredit } from '@/lib/actions/ai-usage'
import { settleAction } from '@/lib/client/stale-version'

export default function AddCreditForm({ today }: { today: string }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    start(async () => {
      const outcome = await settleAction(() => addAiCredit({ amountUsd: Number(amount), date, note }))
      if (outcome.kind === 'stale') return setError('Kockpit was updated. Refresh the page and try again.')
      if (outcome.kind === 'failed') return setError('Could not save the credit. Please try again.')
      if (outcome.data.error) return setError(outcome.data.error)
      setOpen(false); setAmount(''); setNote('')
    })
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="rounded-lg bg-[#171717] px-3 py-1.5 text-xs font-semibold text-kraft-light [box-shadow:2px_2px_0_#555555]">
        Add credit
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="mt-2 grid gap-2 sm:grid-cols-[110px_150px_1fr_auto] items-end">
      <label className="text-xs text-kk-muted">Amount (USD)
        <input required type="number" step="0.01" min="0.01" value={amount} onChange={e => setAmount(e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-kk-line bg-white px-2 py-1.5 text-sm text-kk-ink" placeholder="100" />
      </label>
      <label className="text-xs text-kk-muted">Date
        <input required type="date" value={date} onChange={e => setDate(e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-kk-line bg-white px-2 py-1.5 text-sm text-kk-ink" />
      </label>
      <label className="text-xs text-kk-muted">Note (optional)
        <input type="text" maxLength={200} value={note} onChange={e => setNote(e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-kk-line bg-white px-2 py-1.5 text-sm text-kk-ink" placeholder="Anthropic credit claimed" />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="rounded-lg bg-[#171717] px-3 py-1.5 text-xs font-semibold text-kraft-light disabled:opacity-50">
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-[#171717]/40 px-3 py-1.5 text-xs text-kk-ink">Cancel</button>
      </div>
      {error && <p role="alert" className="text-xs text-kk-bad sm:col-span-4">{error}</p>}
    </form>
  )
}
