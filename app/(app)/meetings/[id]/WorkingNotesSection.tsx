'use client'

import { useState } from 'react'
import { updateMeeting } from '@/lib/actions/meetings'

type Props = {
  meetingId: string
  initialNotes: string
  isEditable: boolean
}

export default function WorkingNotesSection({ meetingId, initialNotes, isEditable }: Props) {
  const [notes, setNotes] = useState(initialNotes)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (saving) return
    setSaving(true)
    setSaved(false)
    setError(null)

    const result = await updateMeeting(meetingId, { working_notes: notes })
    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
    setSaving(false)
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Working notes</h2>
        {saved && <span className="text-xs text-kk-good">Saved</span>}
        {saving && <span className="text-xs text-kk-muted">Saving…</span>}
      </div>

      <div className="p-5">
        {isEditable ? (
          <>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes taken during the meeting…"
              rows={8}
              disabled={saving}
              className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-y"
            />
            {error && <p className="text-xs text-kk-bad mt-1">{error}</p>}
            <div className="mt-3 flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving || notes === initialNotes}
                className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                {saving ? 'Saving…' : 'Save notes'}
              </button>
            </div>
          </>
        ) : (
          notes ? (
            <p className="text-sm text-kk-ink whitespace-pre-wrap">{notes}</p>
          ) : (
            <p className="text-sm text-kk-muted">No working notes.</p>
          )
        )}
      </div>
    </div>
  )
}
