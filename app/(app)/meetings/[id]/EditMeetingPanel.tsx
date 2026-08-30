'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateMeeting } from '@/lib/actions/meetings'
import { utcToWall } from '@/lib/time'

type Props = {
  meetingId: string
  initialTitle: string
  initialStart: string | null
  initialEnd: string | null
  initialProjectId: string | null
  projects: { id: string; title: string }[]
}

export default function EditMeetingPanel({
  meetingId,
  initialTitle,
  initialStart,
  initialEnd,
  initialProjectId,
  projects,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(initialTitle)
  const [start, setStart] = useState(utcToWall(initialStart))
  const [end, setEnd] = useState(utcToWall(initialEnd))
  const [projectId, setProjectId] = useState(initialProjectId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleCancel() {
    setTitle(initialTitle)
    setStart(utcToWall(initialStart))
    setEnd(utcToWall(initialEnd))
    setProjectId(initialProjectId ?? '')
    setError(null)
    setOpen(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    setError(null)

    const result = await updateMeeting(meetingId, {
      title,
      scheduled_start: start || undefined,
      scheduled_end: end || undefined,
      project_id: projectId || undefined,
    })

    setSaving(false)
    if (result.error) {
      setError(result.error)
    } else {
      setOpen(false)
      router.refresh()
    }
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-4">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="w-full text-sm text-kk-muted hover:text-kk-ink transition-colors text-left"
        >
          ✎ Edit meeting details
        </button>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-1">Edit details</div>

          <div>
            <label className="block text-xs font-medium text-kk-ink mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={500}
              disabled={saving}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-kk-ink mb-1">Start</label>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-kk-ink mb-1">End</label>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
            />
          </div>

          {projects.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-kk-ink mb-1">Project</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={saving}
                className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs text-kk-bad">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={!title.trim() || saving}
              className="flex-1 py-2 bg-kk-ink text-white text-xs font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="px-4 py-2 border border-kk-line text-xs text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
