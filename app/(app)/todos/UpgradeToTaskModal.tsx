'use client'

/**
 * UpgradeToTaskModal
 *
 * Inline modal for converting a to-do into a proper Task.
 * Calls upgradeTodoToTask server action directly — no navigation required.
 * After success the parent calls router.refresh() to sync the updated list.
 *
 * For recurring to-dos the server action (via the upgrade_recurring_todo RPC)
 * atomically marks the current occurrence as upgraded and spawns the next
 * one, so future recurrences continue as normal.
 */

import { useState, useTransition } from 'react'
import { upgradeTodoToTask } from '@/lib/actions/todos'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'
import type { Todo, TaskPriority } from '@/lib/types'

type UserOption    = { id: string; display_name: string; email: string }
type ProjectOption = { id: string; title: string }

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 1, label: '1 — Critical' },
  { value: 2, label: '2 — Normal' },
  { value: 3, label: '3 — Low' },
  { value: 4, label: '4 — Background' },
]

interface Props {
  todo:          Todo
  allUsers:      UserOption[]
  projects:      ProjectOption[]
  currentUserId: string
  onClose:       () => void
  onSuccess:     () => void
}

export default function UpgradeToTaskModal({
  todo, allUsers, projects, currentUserId, onClose, onSuccess,
}: Props) {
  const [isPending, startTransition] = useTransition()

  const [title,     setTitle]     = useState(todo.title)
  const [ownerId,   setOwnerId]   = useState(currentUserId)
  const [priority,  setPriority]  = useState<TaskPriority>(todo.priority)
  const [dueAt,     setDueAt]     = useState('')
  const [projectId, setProjectId] = useState('')
  const [error,     setError]     = useState<string | null>(null)

  function handleBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || isPending) return
    setError(null)
    startTransition(async () => {
      const result = await upgradeTodoToTask(todo.id, {
        title:         title.trim(),
        owner_user_id: ownerId,
        project_id:    projectId || null,
        priority,
        due_at:        dueAt || null,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      onSuccess()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={handleBackdropMouseDown}
    >
      <div className="bg-kk-panel rounded-2xl border border-kk-line shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="px-5 py-3 border-b border-kk-line">
          <h2 className="text-sm font-bold text-kk-ink">Upgrade to Task</h2>
          {todo.recurrence_rule && (
            <p className="text-[11px] text-kk-muted mt-0.5">
              Recurring ({formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day)}) — only the current occurrence is upgraded. Future occurrences will continue.
            </p>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-kk-ink mb-1">Title *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              maxLength={500}
              disabled={isPending}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
            />
          </div>

          {/* Responsible + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-kk-ink mb-1">Responsible</label>
              <select
                value={ownerId}
                onChange={e => setOwnerId(e.target.value)}
                disabled={isPending}
                className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
              >
                {allUsers.map(u => (
                  <option key={u.id} value={u.id}>{u.display_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-kk-ink mb-1">Priority</label>
              <select
                value={priority}
                onChange={e => setPriority(Number(e.target.value) as TaskPriority)}
                disabled={isPending}
                className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
              >
                {PRIORITY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Due date */}
          <div>
            <label className="block text-xs font-medium text-kk-ink mb-1">
              Due date/time <span className="font-normal text-kk-muted">(optional)</span>
            </label>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={e => setDueAt(e.target.value)}
              disabled={isPending}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
            />
          </div>

          {/* Project */}
          {projects.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-kk-ink mb-1">
                Project <span className="font-normal text-kk-muted">(optional)</span>
              </label>
              <select
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                disabled={isPending}
                className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
              >
                <option value="">No project</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <p className="text-xs text-kk-bad">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={!title.trim() || isPending}
              className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {isPending ? 'Creating…' : 'Create Task'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
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
