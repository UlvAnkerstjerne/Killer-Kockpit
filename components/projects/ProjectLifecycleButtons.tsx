'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { closeProject, cancelProject, reopenProject, archiveProject } from '@/lib/actions/projects'
import type { ProjectStatus } from '@/lib/types'

const TERMINAL_STATUSES: ProjectStatus[] = ['completed', 'cancelled', 'archived']

export default function ProjectLifecycleButtons({
  projectId,
  currentStatus,
}: {
  projectId: string
  currentStatus: ProjectStatus
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  function requestConfirm(key: string) {
    setConfirming(key)
    setTimeout(() => setConfirming(null), 3000)
  }

  function run(action: () => Promise<{ error?: string }>, redirect?: string) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.error) {
        setError(result.error)
        setConfirming(null)
      } else if (redirect) {
        router.push(redirect)
      } else {
        router.refresh()
      }
    })
  }

  const isTerminal = TERMINAL_STATUSES.includes(currentStatus)

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2 flex-wrap justify-end">
        {isTerminal ? (
          // Reopen
          <button
            onClick={() => run(() => reopenProject(projectId))}
            disabled={isPending}
            className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:border-kk-ink hover:text-kk-ink transition-colors disabled:opacity-40"
          >
            {isPending ? 'Reopening…' : 'Reopen project'}
          </button>
        ) : (
          <>
            {/* Close (mark completed) */}
            <button
              onClick={() => {
                if (confirming === 'close') {
                  run(() => closeProject(projectId))
                } else {
                  requestConfirm('close')
                }
              }}
              disabled={isPending}
              className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:border-kk-good hover:text-kk-good transition-colors disabled:opacity-40"
            >
              {isPending && confirming === 'close' ? 'Closing…' : confirming === 'close' ? 'Click again to confirm' : 'Close project'}
            </button>

            {/* Cancel */}
            <button
              onClick={() => {
                if (confirming === 'cancel') {
                  run(() => cancelProject(projectId))
                } else {
                  requestConfirm('cancel')
                }
              }}
              disabled={isPending}
              className="px-3 py-1.5 border border-kk-line text-xs text-kk-bad rounded-lg hover:border-kk-bad transition-colors disabled:opacity-40"
            >
              {isPending && confirming === 'cancel' ? 'Cancelling…' : confirming === 'cancel' ? 'Click again to confirm' : 'Cancel project'}
            </button>

            {/* Archive */}
            <button
              onClick={() => {
                if (confirming === 'archive') {
                  run(() => archiveProject(projectId), '/projects')
                } else {
                  requestConfirm('archive')
                }
              }}
              disabled={isPending}
              className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:border-kk-bad hover:text-kk-bad transition-colors disabled:opacity-40"
            >
              {isPending && confirming === 'archive' ? 'Archiving…' : confirming === 'archive' ? 'Click again to confirm' : 'Archive project'}
            </button>
          </>
        )}
      </div>
      {error && <p className="text-xs text-kk-bad">{error}</p>}
    </div>
  )
}
