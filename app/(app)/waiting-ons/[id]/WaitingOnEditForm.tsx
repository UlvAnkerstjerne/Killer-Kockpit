'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateWaitingOn } from '@/lib/actions/waiting-ons'

type Props = {
  waitingOnId: string
  currentUserId: string
  canAssign: boolean
  initialTitle: string
  initialWaitingForUserId: string
  initialWaitingForName: string
  initialUseExternalName: boolean
  initialOwnerId: string
  initialProjectId: string
  initialDueAt: string
  initialNotes: string
  users: { id: string; display_name: string }[]
  projects: { id: string; title: string }[]
}

export default function WaitingOnEditForm({
  waitingOnId,
  currentUserId,
  canAssign,
  initialTitle,
  initialWaitingForUserId,
  initialWaitingForName,
  initialUseExternalName,
  initialOwnerId,
  initialProjectId,
  initialDueAt,
  initialNotes,
  users,
  projects,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState(initialTitle)
  const [waitingForUserId, setWaitingForUserId] = useState(initialWaitingForUserId)
  const [waitingForName, setWaitingForName] = useState(initialWaitingForName)
  const [useExternalName, setUseExternalName] = useState(initialUseExternalName)
  const [ownerId, setOwnerId] = useState(initialOwnerId)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [dueAt, setDueAt] = useState(initialDueAt)
  const [notes, setNotes] = useState(initialNotes)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || isPending) return

    setError(null)
    setSaved(false)

    startTransition(async () => {
      const result = await updateWaitingOn(waitingOnId, {
        title: title.trim(),
        owner_user_id: ownerId || undefined,
        waiting_for_user_id: !useExternalName && waitingForUserId ? waitingForUserId : undefined,
        waiting_for_name: useExternalName ? waitingForName.trim() || undefined : undefined,
        project_id: projectId || undefined,
        due_at: dueAt || undefined,
        notes: notes.trim() || undefined,
      })

      if (result.error) {
        setError(result.error)
        return
      }

      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      router.refresh()
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={500}
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Waiting on</label>
        <div className="flex gap-2 mb-2">
          <button
            type="button"
            onClick={() => setUseExternalName(false)}
            disabled={isPending}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${!useExternalName ? 'bg-kk-ink text-white border-kk-ink' : 'border-kk-line text-kk-muted hover:bg-kk-soft'}`}
          >
            Team member
          </button>
          <button
            type="button"
            onClick={() => setUseExternalName(true)}
            disabled={isPending}
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
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
          />
        ) : (
          <select
            value={waitingForUserId}
            onChange={(e) => setWaitingForUserId(e.target.value)}
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white disabled:opacity-60"
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
            disabled={isPending}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white disabled:opacity-60"
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
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white disabled:opacity-60"
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
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors disabled:opacity-60"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Notes <span className="text-kk-muted font-normal">(optional)</span></label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any context or details…"
          rows={3}
          disabled={isPending}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none disabled:opacity-60"
        />
      </div>

      {error && (
        <p className="text-sm text-kk-bad">{error}</p>
      )}

      {saved && (
        <p className="text-sm text-kk-good">Changes saved.</p>
      )}

      <div className="pt-2">
        <button
          type="submit"
          disabled={!title.trim() || isPending}
          className="px-5 py-2.5 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}
