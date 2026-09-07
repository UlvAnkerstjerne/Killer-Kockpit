'use client'

import { useState } from 'react'
import type { AppUser } from '@/lib/types'
import { canAccessManagementView } from '@/lib/permissions'
import QuickCaptureModal from '@/components/capture/QuickCaptureModal'
import QuickCreateModal from '@/components/layout/QuickCreateModal'

export default function TodayCaptureButton({ user }: { user: AppUser }) {
  const [captureOpen, setCaptureOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const canCapture = canAccessManagementView(user.role)

  function handleClick() {
    if (canCapture) {
      setCaptureOpen(true)
    } else {
      setTaskOpen(true)
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-3 bg-kk-panel border border-kk-line rounded-xl px-4 py-3.5 text-left hover:border-kk-ink/20 hover:bg-kk-soft/40 transition-colors"
      >
        <div className="w-8 h-8 bg-kk-ink rounded-full flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 2v10M2 7h10" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-kk-muted">Capture a task, note or idea...</div>
          <div className="text-[11px] text-kk-muted/50 mt-0.5">Press ⌘ ↵ to add</div>
        </div>
      </button>
      {captureOpen && (
        <QuickCaptureModal onClose={() => setCaptureOpen(false)} />
      )}
      {taskOpen && (
        <QuickCreateModal type="task" user={user} onClose={() => setTaskOpen(false)} />
      )}
    </>
  )
}
