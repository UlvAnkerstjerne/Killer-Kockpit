'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createProject, updateProject } from '@/lib/actions/projects'
import type { AppUser, Project, ProjectStatus } from '@/lib/types'

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'at_risk', label: 'At risk' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
]

export default function ProjectForm({
  mode,
  project,
  currentUser,
  allUsers,
}: {
  mode: 'create' | 'edit'
  project?: Project
  currentUser: AppUser
  allUsers: Pick<AppUser, 'id' | 'display_name' | 'email'>[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState(project?.title || '')
  const [description, setDescription] = useState(project?.description || '')
  const [ownerId, setOwnerId] = useState(project?.owner_user_id || currentUser.id)
  const [status, setStatus] = useState<ProjectStatus>(project?.status || 'planned')
  const [startDate, setStartDate] = useState(project?.start_date || '')
  const [dueDate, setDueDate] = useState(project?.due_date || '')
  const [progress, setProgress] = useState(String(project?.progress ?? ''))
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
        status,
        start_date: startDate || undefined,
        due_date: dueDate || undefined,
        progress: progress ? Number(progress) : undefined,
      }

      const result = mode === 'create'
        ? await createProject(input)
        : await updateProject(project!.id, input)

      if (result.error) {
        setError(result.error)
        return
      }

      if (mode === 'create' && result.data?.id) {
        router.push(`/projects/${result.data.id}`)
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
          placeholder="Project title"
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
          placeholder="What is this project about?"
          rows={3}
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60 resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Owner</label>
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
          <label className="block text-sm font-medium text-kk-ink mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ProjectStatus)}
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
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1">Due date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1">
          Progress <span className="font-normal text-kk-muted">(0–100)</span>
        </label>
        <input
          type="number"
          value={progress}
          onChange={(e) => setProgress(e.target.value)}
          placeholder="0"
          min={0}
          max={100}
          disabled={isPending}
          className="w-32 px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
        />
      </div>

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
          {isPending ? 'Saving…' : mode === 'create' ? 'Create project' : 'Save changes'}
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
