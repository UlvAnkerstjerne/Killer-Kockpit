'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createTask } from '@/lib/actions/tasks'
import { createProject } from '@/lib/actions/projects'
import type { AppUser } from '@/lib/types'

export default function QuickCreateModal({
  type,
  onClose,
}: {
  type: 'task' | 'project'
  user?: AppUser
  onClose: () => void
}) {
  const router = useRouter()
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = type === 'task'
      ? await createTask({ title: title.trim() })
      : await createProject({ title: title.trim() })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    onClose()
    if (result.data?.id) {
      router.push(type === 'task' ? `/tasks/${result.data.id}` : `/projects/${result.data.id}`)
    }
  }

  const label = type === 'task' ? 'New task' : 'New project'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" />

      {/* Modal */}
      <div className="relative bg-white border border-kk-line rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-kk-ink mb-4">{label}</h2>

        <form onSubmit={handleSubmit}>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={type === 'task' ? 'Task title…' : 'Project title…'}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
            maxLength={500}
            disabled={submitting}
          />

          {error && (
            <p className="mt-2 text-sm text-kk-bad">{error}</p>
          )}

          <p className="mt-2 text-xs text-kk-muted">
            You can add more details after creating. Press Enter to save.
          </p>

          <div className="flex gap-2 mt-4">
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="flex-1 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {submitting ? 'Creating…' : `Create ${type}`}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
