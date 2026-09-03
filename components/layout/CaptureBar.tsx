'use client'

import { useState } from 'react'
import type { AppUser, ViewMode } from '@/lib/types'
import { canCreateDecision } from '@/lib/permissions'
import QuickCreateModal from './QuickCreateModal'

type CaptureType = 'task' | 'project' | 'waiting-on' | 'decision'

export default function CaptureBar({
  user,
  inline,
}: {
  user: AppUser
  currentView?: ViewMode
  inline?: boolean
}) {
  const [open, setOpen] = useState<CaptureType | null>(null)
  const canDecide = canCreateDecision(user.role)

  const buttons = (
    <div className={inline ? 'flex items-center gap-2' : 'border-b border-kk-line bg-kk-bg px-7 py-3 flex items-center gap-2'}>
      <button
        onClick={() => setOpen('task')}
        className="text-sm px-3.5 py-1.5 bg-kk-brand text-white rounded-md hover:opacity-90 transition-opacity font-medium"
      >
        + Task
      </button>
      <button
        onClick={() => setOpen('project')}
        className="text-sm px-3.5 py-1.5 bg-white border border-kk-line text-kk-ink rounded-md hover:bg-kk-soft transition-colors"
      >
        + Project
      </button>
      <button
        onClick={() => setOpen('waiting-on')}
        className="text-sm px-3.5 py-1.5 bg-white border border-kk-line text-kk-ink rounded-md hover:bg-kk-soft transition-colors"
      >
        + Waiting On
      </button>
      {canDecide ? (
        <button
          onClick={() => setOpen('decision')}
          className="text-sm px-3.5 py-1.5 bg-white border border-kk-line text-kk-ink rounded-md hover:bg-kk-soft transition-colors"
        >
          + Decision
        </button>
      ) : (
        <button
          disabled
          title="Coming in a later milestone"
          className="text-sm px-3.5 py-1.5 bg-white border border-kk-line text-kk-muted rounded-md cursor-not-allowed opacity-50"
        >
          + Note
        </button>
      )}
    </div>
  )

  return (
    <>
      {buttons}
      {open && (
        <QuickCreateModal
          type={open}
          user={user}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
