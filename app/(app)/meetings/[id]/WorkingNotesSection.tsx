'use client'

import { useState } from 'react'
import { updateMeeting } from '@/lib/actions/meetings'
import { useSaveState } from '@/lib/hooks/useSaveState'
import { SaveStatusIndicator } from '@/components/ui/SaveStatusIndicator'

type Props = {
  meetingId: string
  initialNotes: string
  isEditable: boolean
}

export default function WorkingNotesSection({ meetingId, initialNotes, isEditable }: Props) {
  const [notes, setNotes] = useState(initialNotes)
  const save = useSaveState()

  async function handleSave() {
    if (save.status === 'saving') return
    save.start()

    const result = await updateMeeting(meetingId, { working_notes: notes })
    if (result.error) {
      save.fail(result.error)
    } else {
      save.ok()
    }
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Working notes</h2>
        <SaveStatusIndicator status={save.status} errorMsg={save.errorMsg} />
      </div>

      <div className="p-5">
        {isEditable ? (
          <>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes taken during the meeting…"
              rows={8}
              disabled={save.status === 'saving'}
              className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-y"
            />
            {save.status === 'error' && save.errorMsg && (
              <p className="text-xs text-kk-bad mt-1">{save.errorMsg}</p>
            )}
            <div className="mt-3 flex justify-end">
              <button
                onClick={handleSave}
                disabled={save.status === 'saving' || notes === initialNotes}
                className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                {save.status === 'saving' ? 'Saving…' : 'Save notes'}
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
