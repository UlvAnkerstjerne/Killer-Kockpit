'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createTaskChangeRequest } from '@/lib/actions/change-requests'

export default function ChangeRequestForm({
  taskId,
  currentDueAt,
}: {
  taskId: string
  currentDueAt: string | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [dueAt, setDueAt] = useState(
    currentDueAt ? new Date(currentDueAt).toISOString().slice(0, 16) : ''
  )
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!reason.trim() || isPending) return

    setError(null)

    const proposed: Record<string, unknown> = {}
    if (dueAt && dueAt !== (currentDueAt ? new Date(currentDueAt).toISOString().slice(0, 16) : '')) {
      proposed.due_at = new Date(dueAt).toISOString()
    }

    if (Object.keys(proposed).length === 0) {
      setError('No changes proposed — adjust at least one field.')
      return
    }

    startTransition(async () => {
      const result = await createTaskChangeRequest(taskId, proposed, reason)
      if (result.error) {
        setError(result.error)
      } else {
        setSubmitted(true)
        setReason('')
        router.refresh()
      }
    })
  }

  if (submitted) {
    return (
      <p className="text-sm text-kk-good">
        Change request submitted. The task creator will be notified.
      </p>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-kk-ink mb-1">
          Proposed due date <span className="text-kk-muted font-normal">(optional)</span>
        </label>
        <input
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          disabled={isPending}
          className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-kk-ink mb-1">
          Reason <span className="text-kk-bad">*</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain why this change is needed…"
          rows={2}
          required
          disabled={isPending}
          className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none disabled:opacity-60"
        />
      </div>

      {error && <p className="text-sm text-kk-bad">{error}</p>}

      <button
        type="submit"
        disabled={!reason.trim() || isPending}
        className="px-4 py-2 bg-kk-warn text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {isPending ? 'Submitting…' : 'Submit request'}
      </button>
    </form>
  )
}
