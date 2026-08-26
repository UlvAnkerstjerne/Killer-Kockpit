'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { archiveProject } from '@/lib/actions/projects'

export default function ArchiveProjectButton({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  function handleClick() {
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 3000)
      return
    }

    startTransition(async () => {
      const result = await archiveProject(projectId)
      if (result.error) {
        setError(result.error)
        setConfirming(false)
      } else {
        router.push('/projects')
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={isPending}
        className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:border-kk-bad hover:text-kk-bad transition-colors disabled:opacity-40"
      >
        {isPending ? 'Archiving…' : confirming ? 'Click again to confirm' : 'Archive project'}
      </button>
      {error && <p className="text-xs text-kk-bad">{error}</p>}
    </div>
  )
}
