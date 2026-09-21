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

  const createActions = (
    <>
      <button
        onClick={() => setOpen('task')}
        className="text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-md hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
      >
        + Task
      </button>
      <button
        onClick={() => setOpen('project')}
        className="text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-md hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
      >
        + Project
      </button>
      <button
        onClick={() => setOpen('waiting-on')}
        className="text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-md hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
      >
        + Waiting On
      </button>
      {canDecide ? (
        <button
          onClick={() => setOpen('decision')}
          className="text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-md hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
        >
          + Decision
        </button>
      ) : (
        <button
          disabled
          title="Coming in a later milestone"
          className="text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-md cursor-not-allowed opacity-50 font-medium [box-shadow:3px_3px_0_#555555]"
        >
          + Note
        </button>
      )}
    </>
  )

  const defaultCaptureAction = canCapture ? (
    <button
      onClick={() => setCaptureOpen(true)}
      className="text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-md hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
      title="Quick Capture (⌘⇧C)"
    >
      + Capture
    </button>
  ) : null

  const todayCaptureAction = canCapture ? (
    <button
      onClick={() => setCaptureOpen(true)}
      className="w-full sm:w-auto sm:ml-auto inline-flex items-center justify-center gap-2 text-sm px-3.5 py-1.5 bg-[#171717] text-kraft-light rounded-lg hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
      title="Open Quick Capture (⌘⇧C)"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.75a4.25 4.25 0 0 0-2.9 7.36v1.14h5.8V9.11A4.25 4.25 0 0 0 8 1.75Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
        <path d="M6.15 12.25h3.7M6.8 14.25h2.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
      Got an update?
    </button>
  ) : null

  return (
    <>
      {inline ? (
        <div className="flex flex-wrap items-center gap-2 w-full">
          <div className="flex flex-wrap items-center gap-2">{createActions}</div>
          {todayCaptureAction}
        </div>
      ) : (
        <div className="border-b border-kk-line bg-kk-bg overflow-x-auto">
          <div className="flex items-center gap-2 px-7 py-3 min-w-max">
            {createActions}
            {defaultCaptureAction}
          </div>
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
        <QuickCaptureModal
          onClose={() => setCaptureOpen(false)}
          title={inline ? 'Got an update?' : undefined}
          helper={inline ? 'What happened? What changed? What should Kockpit remember?' : undefined}
        />
      )}
    </>
  )
}
