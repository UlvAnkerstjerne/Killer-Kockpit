'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createMeetingWithSetup } from '@/lib/actions/meetings'

type User = { id: string; display_name: string }

export default function QuickNewMeeting({ users, currentUserId }: { users: User[]; currentUserId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(userId: string) {
    setSelectedUsers(prev => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  async function handleRecord() {
    setCreating(true)
    setError(null)

    const now = new Date()
    const title = `Meeting ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

    const attendees = [
      { userId: currentUserId },
      ...[...selectedUsers].filter(id => id !== currentUserId).map(id => ({ userId: id })),
    ]

    const result = await createMeetingWithSetup({
      title,
      attendees,
      agendaItems: [],
    })

    if (result.error) {
      setError(result.error)
      setCreating(false)
      return
    }

    router.push(`/meetings/${result.data!.id}/record`)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs px-3 py-1.5 bg-[#171717] text-kraft-light rounded-lg hover:opacity-80 transition-opacity font-medium [box-shadow:3px_3px_0_#555555]"
      >
        + New meeting
      </button>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-kk-muted">Who is in this meeting?</p>
      <div className="flex flex-wrap gap-1.5">
        {users.map(u => (
          <button
            key={u.id}
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

      {error && <p className="text-xs text-kk-bad">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={handleRecord}
          disabled={creating}
          className="text-xs px-4 py-1.5 bg-[#AD3919] text-white rounded-lg hover:opacity-90 transition-opacity font-semibold disabled:opacity-40 [box-shadow:3px_3px_0_#555555]"
        >
          {creating ? 'Starting…' : 'Record'}
        </button>
        <button
          onClick={() => { setOpen(false); setSelectedUsers(new Set()); setError(null) }}
          disabled={creating}
          className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
