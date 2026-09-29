'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createMeetingWithSetup } from '@/lib/actions/meetings'

type User = { id: string; display_name: string }

export default function QuickNewMeeting({ users, currentUserId }: { users: User[]; currentUserId: string }) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function toggle(userId: string) {
    setSelectedUsers(prev => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)

    const now = new Date()
    const meetingTitle = title.trim() || `Meeting ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

    const attendees = [
      { userId: currentUserId },
      ...[...selectedUsers].filter(id => id !== currentUserId).map(id => ({ userId: id })),
    ]

    const result = await createMeetingWithSetup({
      title: meetingTitle,
      attendees,
      agendaItems: [],
    })

    if (result.error) {
      setError(result.error)
      setCreating(false)
      return
    }

    router.push(`/meetings/${result.data!.id}`)
  }

  return (
    <div>
      <form onSubmit={handleCreate} className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={e => { setTitle(e.target.value); if (!open) setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Add a meeting..."
          maxLength={200}
          disabled={creating}
          className="flex-1 text-sm bg-kraft-bg border-2 border-[#171717] rounded-lg px-3 py-1.5 text-kk-ink placeholder:text-kk-muted outline-none transition-colors"
        />
        <button
          type="submit"
          disabled={creating}
          className="text-xs px-3 py-1.5 bg-[#171717] text-kraft-light rounded-lg disabled:opacity-30 transition-opacity hover:opacity-80 shrink-0 [box-shadow:3px_3px_0_#555555]"
        >
          {creating ? '...' : 'Add'}
        </button>
      </form>

      {/* Attendee picker — shown when input is focused */}
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] text-kk-muted uppercase tracking-wide font-medium">Attendees</p>
          <div className="flex flex-wrap gap-1.5">
            {users.map(u => (
              <button
                key={u.id}
                type="button"
                onClick={() => toggle(u.id)}
                disabled={creating}
                className={[
                  'text-xs px-2.5 py-1 rounded-lg transition-colors font-medium border',
                  selectedUsers.has(u.id)
                    ? 'bg-[#171717] text-kraft-light border-[#171717]'
                    : 'bg-kraft-light text-kk-ink border-[#171717]/30 hover:border-[#171717]',
                ].join(' ')}
              >
                {u.display_name}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-kk-bad">{error}</p>}
    </div>
  )
}
