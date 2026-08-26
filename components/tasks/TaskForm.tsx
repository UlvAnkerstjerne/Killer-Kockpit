'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createTask, updateTask } from '@/lib/actions/tasks'
import type { AppUser, Task, TaskStatus, TaskPriority } from '@/lib/types'

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
]

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 1, label: '1 — Critical' },
  { value: 2, label: '2 — Normal' },
  { value: 3, label: '3 — Low' },
  { value: 4, label: '4 — Background' },
]

type ProjectOption = { id: string; title: string }
type UserOption = Pick<AppUser, 'id' | 'display_name' | 'email'>

export default function TaskForm({
  mode,
  task,
  currentUser,
  allUsers,
  projects,
  defaultProjectId,
}: {
  mode: 'create' | 'edit'
  task?: Task
  currentUser: AppUser
  allUsers: UserOption[]
  projects: ProjectOption[]
  defaultProjectId?: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState(task?.title || '')
  const [description, setDescription] = useState(task?.description || '')
  const [ownerId, setOwnerId] = useState(task?.owner_user_id || currentUser.id)
  const [projectId, setProjectId] = useState(task?.project_id || defaultProjectId || '')
  const [status, setStatus] = useState<TaskStatus>(task?.status || 'open')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority || 2)
  const [dueAt, setDueAt] = useState(
    task?.due_at ? new Date(task.due_at).toISOString().slice(0, 16) : ''
  )
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || isPending) return

    setError(null)
    setSaved(false)

    startTransition(async () => {
      const input = {
        title: title.trim(),
        description: description.trim() || undefined,
        owner_user_id: ownerId,
        project_id: projectId || undefined,
        status,
        priority,
        due_at: dueAt || undefined,
      }

      const result = mode === 'create'
        ? await createTask(input)
        : await updateTask(task!.id, input)

      if (result.error) {
        setError(result.error)
        return
      }

      if (mode === 'create' && result.data?.id) {
        router.push(`/tasks/${result.data.id}`)
      } else {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1">Title *</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title"
          required
          maxLength={500}
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What needs to happen?"
          rows={3}
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60 resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Owner *</label>
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          >
            {allUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) as TaskPriority)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Due date/time</label>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          />
        </div>
      </div>

      {projects.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">
            Project <span className="font-normal text-kk-muted">(optional)</span>
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink bg-white focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-kk-bad-bg border border-red-200 text-sm text-kk-bad">
          {error}
        </div>
      )}

      {saved && (
        <div className="p-3 rounded-xl bg-kk-good-bg border border-green-200 text-sm text-kk-good">
          Changes saved.
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={!title.trim() || isPending}
          className="px-5 py-2.5 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {isPending ? 'Saving…' : mode === 'create' ? 'Create task' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          disabled={isPending}
          className="px-5 py-2.5 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
