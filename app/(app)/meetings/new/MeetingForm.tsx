'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createMeeting } from '@/lib/actions/meetings'

type Props = {
  currentUserId: string
  canAssign: boolean
  users: { id: string; display_name: string }[]
  projects: { id: string; title: string }[]
}

export default function MeetingForm({ currentUserId, canAssign, users, projects }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [ownerId, setOwnerId] = useState(currentUserId)
  const [projectId, setProjectId] = useState('')
  const [scheduledStart, setScheduledStart] = useState('')
  const [scheduledEnd, setScheduledEnd] = useState('')
  const [context, setContext] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = await createMeeting({
      title,
      owner_user_id: ownerId || undefined,
      project_id: projectId || undefined,
      scheduled_start: scheduledStart || undefined,
      scheduled_end: scheduledEnd || undefined,
      context: context || undefined,
    })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    router.push(`/meetings/${result.data!.id}`)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Meeting title"
          required
          maxLength={500}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
        />
      </div>

      {canAssign && (
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">Owner</label>
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}{u.id === currentUserId ? ' (me)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Project <span className="text-kk-muted font-normal">(optional)</span></label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">Start <span className="text-kk-muted font-normal">(optional)</span></label>
          <input
            type="datetime-local"
            value={scheduledStart}
            onChange={(e) => setScheduledStart(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">End <span className="text-kk-muted font-normal">(optional)</span></label>
          <input
            type="datetime-local"
            value={scheduledEnd}
            onChange={(e) => setScheduledEnd(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Context / prep notes <span className="text-kk-muted font-normal">(optional)</span></label>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Background, goals, pre-reading…"
          rows={3}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none"
        />
      </div>

      {error && <p className="text-sm text-kk-bad">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={!title.trim() || submitting}
          className="flex-1 py-2.5 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {submitting ? 'Creating…' : 'Create meeting'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/meetings')}
          className="px-5 py-2.5 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
