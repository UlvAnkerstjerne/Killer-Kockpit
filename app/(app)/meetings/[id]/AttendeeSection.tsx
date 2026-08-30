'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { addMeetingAttendee, removeMeetingAttendee } from '@/lib/actions/meetings'
import type { MeetingAttendee } from '@/lib/types'

type Props = {
  meetingId: string
  attendees: MeetingAttendee[]
  allUsers: { id: string; display_name: string }[]
  canEdit: boolean
}

export default function AttendeeSection({ meetingId, attendees, allUsers, canEdit }: Props) {
  const router = useRouter()
  const [useExternal, setUseExternal] = useState(false)
  const [userId, setUserId] = useState('')
  const [externalName, setExternalName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attendeeUserIds = new Set(attendees.filter((a) => a.user_id).map((a) => a.user_id!))
  const availableUsers = allUsers.filter((u) => !attendeeUserIds.has(u.id))

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (adding) return
    if (!useExternal && !userId) return
    if (useExternal && !externalName.trim()) return

    setAdding(true)
    setError(null)

    const result = await addMeetingAttendee(meetingId, {
      userId: !useExternal ? userId : undefined,
      externalName: useExternal ? externalName : undefined,
    })

    if (result.error) {
      setError(result.error)
    } else {
      setUserId('')
      setExternalName('')
      router.refresh()
    }
    setAdding(false)
  }

  async function handleRemove(attendeeId: string) {
    const result = await removeMeetingAttendee(meetingId, attendeeId)
    if (!result.error) router.refresh()
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Attendees <span className="text-kk-muted font-normal">· {attendees.length}</span>
        </h2>
      </div>

      <div className="divide-y divide-kk-line">
        {attendees.map((a) => {
          const user = Array.isArray(a.user) ? a.user[0] : a.user
          const displayName = user?.display_name ?? a.external_name ?? 'Unknown'
          return (
            <div key={a.id} className="flex items-center gap-3 px-5 py-2.5">
              <span className="text-sm text-kk-ink flex-1">{displayName}</span>
              {!user && a.external_name && (
                <span className="text-xs text-kk-muted">External</span>
              )}
              {canEdit && (
                <button
                  onClick={() => handleRemove(a.id)}
                  className="text-xs text-kk-muted hover:text-kk-bad transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          )
        })}
        {attendees.length === 0 && (
          <div className="px-5 py-4 text-sm text-kk-muted">No attendees added yet.</div>
        )}
      </div>

      {canEdit && (
        <div className="px-5 py-3 border-t border-kk-line">
          <form onSubmit={handleAdd} className="space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setUseExternal(false)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${!useExternal ? 'bg-kk-ink text-white border-kk-ink' : 'border-kk-line text-kk-muted hover:bg-kk-soft'}`}
              >
                Team member
              </button>
              <button
                type="button"
                onClick={() => setUseExternal(true)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${useExternal ? 'bg-kk-ink text-white border-kk-ink' : 'border-kk-line text-kk-muted hover:bg-kk-soft'}`}
              >
                External
              </button>
            </div>
            <div className="flex gap-2">
              {useExternal ? (
                <input
                  type="text"
                  value={externalName}
                  onChange={(e) => setExternalName(e.target.value)}
                  placeholder="External attendee name"
                  maxLength={300}
                  disabled={adding}
                  className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
                />
              ) : (
                <select
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  disabled={adding}
                  className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
                >
                  <option value="">Select team member…</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name}</option>
                  ))}
                </select>
              )}
              <button
                type="submit"
                disabled={adding || (!useExternal && !userId) || (useExternal && !externalName.trim())}
                className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                Add
              </button>
            </div>
          </form>
          {error && <p className="text-xs text-kk-bad mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}
