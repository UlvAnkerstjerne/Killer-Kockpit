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
  isSuperAdmin,
}: {
  taskId: string
  currentStatus: string
  isSelfAssigned: boolean
  userIsResponsible: boolean
  userIsRequester: boolean
  isSuperAdmin: boolean
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showSendBack, setShowSendBack] = useState(false)
  const [reviewNote, setReviewNote] = useState('')

  const isTerminal = currentStatus === 'done' || currentStatus === 'cancelled'

  // ── Terminal state ────────────────────────────────────────────────────────

  if (isTerminal) {
    if (!userIsRequester && !userIsResponsible && !isSuperAdmin) return null

    const reopenBtn = (
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
    )

    if (userIsRequester || userIsResponsible) {
      return (
        <div>
          {reopenBtn}
          {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
        </div>
      )
    }

    // Unrelated SUPER_ADMIN — reopen is an administrative override
    return (
      <div>
        <p className="text-[10px] font-semibold text-kk-muted uppercase tracking-wide mb-2">Admin actions</p>
        {reopenBtn}
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
    if (userIsResponsible) {
      return (
        <p className="text-xs text-kk-muted">
          Awaiting review by the requester.
        </p>
      )
    }

    // SUPER_ADMIN who is neither requester nor responsible — secondary admin override
    if (isSuperAdmin) {
      return (
        <div className="space-y-3">
          <p className="text-xs text-kk-muted">You are not the requester or responsible party.</p>
          <div className="border-t border-kk-line pt-3">
            <p className="text-[10px] font-semibold text-kk-muted uppercase tracking-wide mb-2">Admin actions</p>
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
        </div>
      )
    }

    return null
  }

  // ── Active state ──────────────────────────────────────────────────────────
  //
  // Relationship matrix — no SUPER_ADMIN leakage into normal workflow:
  //   self-assigned (owner == creator == me)  → Mark done + transitions
  //   delegated responsible                   → Done — send for review + transitions
  //   delegated requester                     → waiting message (no mutations)
  //   unrelated SUPER_ADMIN                   → ADMIN ACTIONS section only

  const transitions = STATUS_TRANSITIONS[currentStatus] || []

  // Renders the status-transition buttons (Start, Block, Cancel…) shared across cases.
  const renderTransitions = () => transitions.map((t) => (
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
  ))

  // Self-assigned: I am both requester and responsible — mark done directly.
  if (isSelfAssigned && userIsResponsible) {
    return (
      <div>
        <div className="flex gap-2 flex-wrap">
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
          {renderTransitions()}
        </div>
        {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
      </div>
    )
  }

  // Delegated responsible: I own the work; submit it for review.
  if (userIsResponsible) {
    return (
      <div>
        <div className="flex gap-2 flex-wrap">
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
            {isPending ? 'Sending…' : 'Done — send for review'}
          </button>
          {renderTransitions()}
        </div>
        {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
      </div>
    )
  }

  // Delegated requester: I requested the work; wait for the responsible to submit.
  if (userIsRequester) {
    return (
      <p className="text-xs text-kk-muted">
        Waiting for the responsible person to submit for review.
      </p>
    )
  }

  // Unrelated SUPER_ADMIN: all mutation controls grouped under ADMIN ACTIONS.
  if (isSuperAdmin) {
    return (
      <div>
        <p className="text-[10px] font-semibold text-kk-muted uppercase tracking-wide mb-2">Admin actions</p>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => {
              setError(null)
              startTransition(async () => {
                const result = await completeTask(taskId)
                if (result.error) setError(result.error)
              })
            }}
            disabled={isPending}
            className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg disabled:opacity-40 hover:text-kk-ink hover:border-kk-ink transition-colors"
          >
            {isPending ? '…' : 'Mark done'}
          </button>
          {renderTransitions()}
        </div>
        {error && <p className="text-xs text-kk-bad mt-2">{error}</p>}
      </div>
    )
  }

  return null
}
