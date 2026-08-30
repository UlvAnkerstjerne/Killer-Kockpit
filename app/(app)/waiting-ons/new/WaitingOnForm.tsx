'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createWaitingOn } from '@/lib/actions/waiting-ons'

type Props = {
  currentUserId: string
  canAssign: boolean
  users: { id: string; display_name: string }[]
  projects: { id: string; title: string }[]
  defaultProjectId?: string
}

export default function WaitingOnForm({ currentUserId, canAssign, users, projects, defaultProjectId }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [waitingForUserId, setWaitingForUserId] = useState('')
  const [waitingForName, setWaitingForName] = useState('')
  const [useExternalName, setUseExternalName] = useState(false)
  const [projectId, setProjectId] = useState(defaultProjectId ?? '')
  const [dueAt, setDueAt] = useState('')
  const [notes, setNotes] = useState('')
  const [ownerId, setOwnerId] = useState(currentUserId)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = await createWaitingOn({
      title,
      owner_user_id: ownerId || undefined,
      waiting_for_user_id: !useExternalName && waitingForUserId ? waitingForUserId : undefined,
      waiting_for_name: useExternalName ? waitingForName : undefined,
      project_id: projectId || undefined,
      due_at: dueAt || undefined,
      notes: notes || undefined,
    })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    router.push(`/waiting-ons/${result.data!.id}`)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What are you waiting on?"
          required
          maxLength={500}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Waiting on</label>
        <div className="flex gap-2 mb-2">
          <button
            type="button"
            onClick={() => setUseExternalName(false)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${!useExternalName ? 'bg-kk-ink text-white border-kk-ink' : 'border-kk-line text-kk-muted hover:bg-kk-soft'}`}
          >
            Team member
          </button>
          <button
            type="button"
            onClick={() => setUseExternalName(true)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${useExternalName ? 'bg-kk-ink text-white border-kk-ink' : 'border-kk-line text-kk-muted hover:bg-kk-soft'}`}
          >
            External / free-text
          </button>
        </div>
        {useExternalName ? (
          <input
            type="text"
            value={waitingForName}
            onChange={(e) => setWaitingForName(e.target.value)}
            placeholder="Name or description"
            maxLength={300}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
          />
        ) : (
          <select
            value={waitingForUserId}
            onChange={(e) => setWaitingForUserId(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
          >
            <option value="">Select team member…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.display_name}</option>
            ))}
          </select>
        )}
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
              <option key={u.id} value={u.id}>{u.display_name}{u.id === currentUserId ? ' (me)' : ''}</option>
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

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Due <span className="text-kk-muted font-normal">(optional)</span></label>
        <input
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Notes <span className="text-kk-muted font-normal">(optional)</span></label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any context or details…"
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
          {submitting ? 'Creating…' : 'Create waiting on'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/waiting-ons')}
          className="px-5 py-2.5 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
