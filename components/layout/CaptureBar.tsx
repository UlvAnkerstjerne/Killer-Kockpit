'use client'

import { useState } from 'react'
import type { AppUser, ViewMode } from '@/lib/types'
import QuickCreateModal from './QuickCreateModal'

type CaptureType = 'task' | 'project'

export default function CaptureBar({
  user,
}: {
  user: AppUser
  currentView?: ViewMode
}) {
  const [open, setOpen] = useState<CaptureType | null>(null)

  return (
    <>
      <div className="border-b border-kk-line bg-kk-bg px-7 py-3 flex items-center gap-2">
        <button
          onClick={() => setOpen('task')}
          className="text-sm px-3 py-1.5 bg-kk-ink text-white rounded-lg hover:opacity-90 transition-opacity font-medium"
        >
          + Task
        </button>
        <button
          onClick={() => setOpen('project')}
          className="text-sm px-3 py-1.5 bg-white border border-kk-line text-kk-ink rounded-lg hover:bg-kk-soft transition-colors"
        >
          + Project
        </button>
        <button
          disabled
          title="Coming in a later milestone"
          className="text-sm px-3 py-1.5 bg-white border border-kk-line text-kk-muted rounded-lg cursor-not-allowed opacity-50"
        >
          + Note
        </button>
        <button
          disabled
          title="Coming in a later milestone"
          className="text-sm px-3 py-1.5 bg-white border border-kk-line text-kk-muted rounded-lg cursor-not-allowed opacity-50"
        >
          + Decision
        </button>
      </div>

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
