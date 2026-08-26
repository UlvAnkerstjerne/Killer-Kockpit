'use client'

import { useState, useTransition } from 'react'
import { completeTask, cancelTask, updateTask } from '@/lib/actions/tasks'
import type { TaskStatus } from '@/lib/types'

const STATUS_TRANSITIONS: Record<string, { value: TaskStatus; label: string }[]> = {
  proposed: [
    { value: 'open', label: 'Mark open' },
    { value: 'cancelled', label: 'Cancel' },
  ],
  open: [
    { value: 'in_progress', label: 'Start' },
    { value: 'blocked', label: 'Mark blocked' },
  ],
  in_progress: [
    { value: 'blocked', label: 'Mark blocked' },
    { value: 'open', label: 'Pause' },
  ],
  blocked: [
    { value: 'in_progress', label: 'Resume' },
    { value: 'open', label: 'Reopen' },
  ],
}

export default function TaskActionButtons({
  taskId,
  currentStatus,
}: {
  taskId: string
  currentStatus: string
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function handleComplete() {
    setError(null)
    startTransition(async () => {
      const result = await completeTask(taskId)
      if (result.error) setError(result.error)
    })
  }

  async function handleStatusChange(status: TaskStatus) {
    if (status === 'cancelled') {
      setError(null)
      startTransition(async () => {
        const result = await cancelTask(taskId)
        if (result.error) setError(result.error)
      })
      return
    }

    setError(null)
    startTransition(async () => {
      const result = await updateTask(taskId, { status })
      if (result.error) setError(result.error)
    })
  }

  const transitions = STATUS_TRANSITIONS[currentStatus] || []

  return (
    <div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handleComplete}
          disabled={isPending}
          className="px-3 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {isPending ? '…' : 'Mark done'}
        </button>

        {transitions.map((t) => (
          <button
            key={t.value}
            onClick={() => handleStatusChange(t.value)}
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
