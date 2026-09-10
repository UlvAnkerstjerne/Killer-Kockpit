'use client'

import { useState, useEffect } from 'react'
import type { AppUser, ViewMode } from '@/lib/types'
import { canCreateDecision, canAccessManagementView } from '@/lib/permissions'
import QuickCreateModal from './QuickCreateModal'
import QuickCaptureModal from '@/components/capture/QuickCaptureModal'

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
  const [captureOpen, setCaptureOpen] = useState(false)
  const canDecide = canCreateDecision(user.role)
  const canCapture = canAccessManagementView(user.role)

  useEffect(() => {
    if (!canCapture) return
    function handleKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyC')) return
      const target = e.target as HTMLElement
      const tag = target.tagName.toLowerCase()
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target.isContentEditable
      ) return
      e.preventDefault()
      setCaptureOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canCapture])

  const buttonRow = (
    <>
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
      {canCapture && (
        <button
          onClick={() => setCaptureOpen(true)}
          className="text-sm px-3.5 py-1.5 bg-white border border-kk-line text-kk-ink rounded-md hover:bg-kk-soft transition-colors"
          title="Quick Capture (⌘⇧C)"
        >
          + Capture
        </button>
      )}
    </>
  )

  return (
    <>
      {inline ? (
        <div className="flex items-center gap-2">{buttonRow}</div>
      ) : (
        <div className="border-b border-kk-line bg-kk-bg overflow-x-auto">
          <div className="flex items-center gap-2 px-7 py-3 min-w-max">{buttonRow}</div>
        </div>
      )}
      {open && (
        <QuickCreateModal
          type={open}
          user={user}
          onClose={() => setOpen(null)}
        />
      )}
      {captureOpen && (
        <QuickCaptureModal onClose={() => setCaptureOpen(false)} />
      )}
    </>
  )
}
