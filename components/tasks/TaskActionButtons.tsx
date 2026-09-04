'use client'

import { useState, useTransition } from 'react'
import {
  completeTask,
  cancelTask,
  reopenTask,
  updateTask,
  submitTaskForReview,
  approveTask,
  sendTaskBack,
} from '@/lib/actions/tasks'
import type { TaskStatus } from '@/lib/types'

const STATUS_TRANSITIONS: Record<string, { value: TaskStatus; label: string }[]> = {
  proposed: [
    { value: 'open', label: 'Mark open' },
    { value: 'cancelled', label: 'Cancel' },
  ],
  open: [
    { value: 'in_progress', label: 'Start' },
    { value: 'blocked', label: 'Mark blocked' },
    { value: 'cancelled', label: 'Cancel' },
  ],
  in_progress: [
    { value: 'blocked', label: 'Mark blocked' },
    { value: 'open', label: 'Pause' },
    { value: 'cancelled', label: 'Cancel' },
  ],
  blocked: [
    { value: 'in_progress', label: 'Resume' },
    { value: 'open', label: 'Reopen' },
    { value: 'cancelled', label: 'Cancel' },
  ],
}

export default function TaskActionButtons({
  taskId,
  currentStatus,
  isSelfAssigned,
  userIsResponsible,
  userIsRequester,
}: {
  taskId: string
  currentStatus: string
  isSelfAssigned: boolean
  userIsResponsible: boolean
  userIsRequester: boolean
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showSendBack, setShowSendBack] = useState(false)
  const [reviewNote, setReviewNote] = useState('')

  const isTerminal = currentStatus === 'done' || currentStatus === 'cancelled'

  // ── Terminal state ────────────────────────────────────────────────────────

  if (isTerminal) {
    if (!userIsRequester && !userIsResponsible) return null
    return (
      <div>
        <button
          onClick={() => {
            setError(null)
            startTransition(async () => {
              const result = await reopenTask(taskId)
              if (result.error) setError(result.error)
            })
          }}
          disabled={isPending}
          className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg disabled:opacity-40 hover:text-kk-ink hover:border-kk-ink transition-colors"
        >
          {isPending ? '…' : 'Reopen task'}
        </button>
        {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
      </div>
    )
  }

  // ── Pending review — requester approves or sends back ─────────────────────

  if (currentStatus === 'pending_review') {
    if (userIsRequester) {
      return (
        <div className="space-y-3">
          {!showSendBack ? (
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => {
                  setError(null)
                  startTransition(async () => {
                    const result = await approveTask(taskId)
                    if (result.error) setError(result.error)
                  })
                }}
                disabled={isPending}
                className="px-3 py-1.5 bg-kk-good text-white text-xs font-medium rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                {isPending ? '…' : 'Approve'}
              </button>
              <button
                onClick={() => setShowSendBack(true)}
                disabled={isPending}
                className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:text-kk-ink hover:border-kk-ink transition-colors"
              >
                Send back
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="What needs to change? (optional)"
                rows={3}
                className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20 resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setError(null)
                    startTransition(async () => {
                      const result = await sendTaskBack(taskId, reviewNote)
                      if (result.error) setError(result.error)
                      else setShowSendBack(false)
                    })
                  }}
                  disabled={isPending}
                  className="px-3 py-1.5 border border-kk-bad text-xs text-kk-bad rounded-lg disabled:opacity-40 hover:bg-kk-bad-bg transition-colors"
                >
                  {isPending ? '…' : 'Confirm send back'}
                </button>
                <button
                  onClick={() => { setShowSendBack(false); setReviewNote('') }}
                  disabled={isPending}
                  className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:text-kk-ink transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && <p className="text-xs text-kk-bad">{error}</p>}
        </div>
      )
    }
    // Responsible person: task is with the requester — nothing to act on
    return (
      <p className="text-xs text-kk-muted">
        Awaiting review by the requester.
      </p>
    )
  }

  // ── Active state ──────────────────────────────────────────────────────────

  const transitions = STATUS_TRANSITIONS[currentStatus] || []

  // Self-assigned or SUPER_ADMIN acting as requester: direct "Mark done"
  const showMarkDone = isSelfAssigned || userIsRequester

  return (
    <div>
      <div className="flex gap-2 flex-wrap">
        {showMarkDone ? (
          <button
            onClick={() => {
              setError(null)
              startTransition(async () => {
                const result = await completeTask(taskId)
                if (result.error) setError(result.error)
              })
            }}
            disabled={isPending}
            className="px-3 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {isPending ? '…' : 'Mark done'}
          </button>
        ) : userIsResponsible ? (
          <button
            onClick={() => {
              setError(null)
              startTransition(async () => {
                const result = await submitTaskForReview(taskId)
                if (result.error) setError(result.error)
              })
            }}
            disabled={isPending}
            className="px-3 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {isPending ? '…' : 'Submit for review'}
          </button>
        ) : null}

        {transitions.map((t) => (
          <button
            key={t.value}
            onClick={() => {
              if (t.value === 'cancelled') {
                setError(null)
                startTransition(async () => {
                  const result = await cancelTask(taskId)
                  if (result.error) setError(result.error)
                })
                return
              }
              setError(null)
              startTransition(async () => {
                const result = await updateTask(taskId, { status: t.value })
                if (result.error) setError(result.error)
              })
            }}
            disabled={isPending}
            className={[
              'px-3 py-1.5 border text-xs rounded-lg disabled:opacity-40 transition-colors',
              t.value === 'cancelled'
                ? 'border-kk-line text-kk-bad hover:border-kk-bad'
                : 'border-kk-line text-kk-muted hover:text-kk-ink hover:border-kk-ink',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
    </div>
  )
}
