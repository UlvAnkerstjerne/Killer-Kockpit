'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createMeetingWithSetup } from '@/lib/actions/meetings'

type User    = { id: string; display_name: string }
type Project = { id: string; title: string }

type Props = {
  currentUserId: string
  canAssign:     boolean
  users:         User[]
  projects:      Project[]
}

type Attendee =
  | { kind: 'internal'; userId: string; displayName: string }
  | { kind: 'external'; name: string; email: string; key: string }

type AgendaItem = { title: string; key: string }

export default function MeetingForm({ currentUserId, canAssign, users, projects }: Props) {
  const router = useRouter()

  // Core fields
  const [title,          setTitle]          = useState('')
  const [ownerId,        setOwnerId]        = useState(currentUserId)
  const [projectId,      setProjectId]      = useState('')
  const [scheduledStart, setScheduledStart] = useState('')
  const [scheduledEnd,   setScheduledEnd]   = useState('')
  const [location,       setLocation]       = useState('')
  const [context,        setContext]        = useState('')

  // Attendees
  const [attendees,         setAttendees]        = useState<Attendee[]>([])
  const [internalPick,      setInternalPick]     = useState('')
  const [externalName,      setExternalName]     = useState('')
  const [externalEmail,     setExternalEmail]    = useState('')
  const [showExternalForm,  setShowExternalForm] = useState(false)

  // Agenda
  const [agendaItems,  setAgendaItems]  = useState<AgendaItem[]>([])
  const [newAgenda,    setNewAgenda]    = useState('')

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  // ── Attendee helpers ──────────────────────────────────────────────────────

  const attendeeUserIds = new Set(
    attendees.filter((a): a is Attendee & { kind: 'internal' } => a.kind === 'internal')
      .map((a) => a.userId)
  )

  function addInternal() {
    const user = users.find((u) => u.id === internalPick)
    if (!user || attendeeUserIds.has(user.id)) return
    setAttendees((prev) => [...prev, { kind: 'internal', userId: user.id, displayName: user.display_name }])
    setInternalPick('')
  }

  function addExternal() {
    const name = externalName.trim()
    if (!name) return
    setAttendees((prev) => [...prev, {
      kind:  'external',
      name,
      email: externalEmail.trim(),
      key:   `${Date.now()}`,
    }])
    setExternalName('')
    setExternalEmail('')
    setShowExternalForm(false)
  }

  function removeAttendee(index: number) {
    setAttendees((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Agenda helpers ────────────────────────────────────────────────────────

  function addAgendaItem() {
    const t = newAgenda.trim()
    if (!t) return
    setAgendaItems((prev) => [...prev, { title: t, key: `${Date.now()}` }])
    setNewAgenda('')
  }

  function removeAgendaItem(index: number) {
    setAgendaItems((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = await createMeetingWithSetup({
      title,
      owner_user_id:   ownerId || undefined,
      project_id:      projectId || undefined,
      scheduled_start: scheduledStart || undefined,
      scheduled_end:   scheduledEnd || undefined,
      context:         context || undefined,
      location:        location || undefined,
      attendees: attendees.map((a) =>
        a.kind === 'internal'
          ? { userId: a.userId }
          : { externalName: a.name, externalEmail: a.email || undefined }
      ),
      agendaItems: agendaItems.map((i) => ({ title: i.title })),
    })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    router.push(`/meetings/${result.data!.id}`)
  }

  // ── Available users (not yet added as attendees) ──────────────────────────

  const availableUsers = users.filter((u) => !attendeeUserIds.has(u.id))

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Title */}
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

      {/* Owner */}
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

      {/* Project */}
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">
          Project <span className="text-kk-muted font-normal">(optional)</span>
        </label>
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

      {/* Start / End */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">
            Start <span className="text-kk-muted font-normal">(optional)</span>
          </label>
          <input
            type="datetime-local"
            value={scheduledStart}
            onChange={(e) => setScheduledStart(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-kk-ink mb-1.5">
            End <span className="text-kk-muted font-normal">(optional)</span>
          </label>
          <input
            type="datetime-local"
            value={scheduledEnd}
            onChange={(e) => setScheduledEnd(e.target.value)}
            disabled={submitting}
            className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
          />
        </div>
      </div>

      {/* Location */}
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">
          Location <span className="text-kk-muted font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Killer Kebab office, Google Meet, Borgergade…"
          maxLength={500}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
        />
      </div>

      {/* Attendees */}
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">
          Attendees <span className="text-kk-muted font-normal">(optional)</span>
        </label>

        {/* Added attendees list */}
        {attendees.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attendees.map((a, i) => (
              <span
                key={a.kind === 'internal' ? a.userId : a.key}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-kk-soft border border-kk-line rounded-lg text-xs text-kk-ink"
              >
                {a.kind === 'internal' ? a.displayName : a.name}
                {a.kind === 'external' && a.email && (
                  <span className="text-kk-muted">· {a.email}</span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttendee(i)}
                  disabled={submitting}
                  className="text-kk-muted hover:text-kk-bad transition-colors ml-0.5"
                  aria-label="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Add internal attendee */}
        {availableUsers.length > 0 && (
          <div className="flex gap-2 mb-2">
            <select
              value={internalPick}
              onChange={(e) => setInternalPick(e.target.value)}
              disabled={submitting}
              className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
            >
              <option value="">Add team member…</option>
              {availableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name}{u.id === currentUserId ? ' (me)' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addInternal}
              disabled={!internalPick || submitting}
              className="px-4 py-2 border border-kk-line text-sm text-kk-ink rounded-xl disabled:opacity-40 hover:bg-kk-soft transition-colors"
            >
              Add
            </button>
          </div>
        )}

        {/* Add external attendee */}
        {!showExternalForm ? (
          <button
            type="button"
            onClick={() => setShowExternalForm(true)}
            disabled={submitting}
            className="text-xs text-kk-muted hover:text-kk-ink underline transition-colors"
          >
            + Add external attendee
          </button>
        ) : (
          <div className="border border-kk-line rounded-xl p-3 space-y-2">
            <input
              type="text"
              value={externalName}
              onChange={(e) => setExternalName(e.target.value)}
              placeholder="Name"
              maxLength={200}
              disabled={submitting}
              className="w-full px-3 py-2 border border-kk-line rounded-lg text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
            />
            <input
              type="email"
              value={externalEmail}
              onChange={(e) => setExternalEmail(e.target.value)}
              placeholder="Email (optional — for calendar invite)"
              maxLength={200}
              disabled={submitting}
              className="w-full px-3 py-2 border border-kk-line rounded-lg text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={addExternal}
                disabled={!externalName.trim() || submitting}
                className="px-3 py-1.5 bg-kk-ink text-white text-xs rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => { setShowExternalForm(false); setExternalName(''); setExternalEmail('') }}
                disabled={submitting}
                className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:bg-kk-soft transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Agenda */}
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">
          Agenda <span className="text-kk-muted font-normal">(optional)</span>
        </label>

        {agendaItems.length > 0 && (
          <div className="border border-kk-line rounded-xl divide-y divide-kk-line mb-2">
            {agendaItems.map((item, i) => (
              <div key={item.key} className="flex items-center gap-2 px-3 py-2">
                <span className="text-xs text-kk-muted w-4 text-right shrink-0">{i + 1}.</span>
                <span className="flex-1 text-sm text-kk-ink">{item.title}</span>
                <button
                  type="button"
                  onClick={() => removeAgendaItem(i)}
                  disabled={submitting}
                  className="text-kk-muted hover:text-kk-bad text-xs transition-colors"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={newAgenda}
            onChange={(e) => setNewAgenda(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAgendaItem() } }}
            placeholder="Add agenda item…"
            maxLength={500}
            disabled={submitting}
            className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
          />
          <button
            type="button"
            onClick={addAgendaItem}
            disabled={!newAgenda.trim() || submitting}
            className="px-4 py-2 border border-kk-line text-sm text-kk-ink rounded-xl disabled:opacity-40 hover:bg-kk-soft transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      {/* Context */}
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">
          Context / prep notes <span className="text-kk-muted font-normal">(optional)</span>
        </label>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Background, goals, pre-reading…"
          rows={3}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none"
        />
      </div>

      {scheduledStart && scheduledEnd && (
        <p className="text-xs text-kk-muted">
          A Google Meet will be created and attendees invited automatically if you have Google connected.
        </p>
      )}

      {error && <p className="text-sm text-kk-bad">{error}</p>}

      <div className="flex gap-2 pt-1">
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
