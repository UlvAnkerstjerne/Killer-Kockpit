'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createAgendaItem, updateAgendaItem } from '@/lib/actions/agenda-items'
import type { AgendaItem } from '@/lib/types'

type Props = {
  meetingId: string
  items: AgendaItem[]
  canEdit: boolean
  isEditable: boolean
}

export default function AgendaSection({ meetingId, items, canEdit, isEditable }: Props) {
  const router = useRouter()
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim() || adding) return
    setAdding(true)
    setError(null)

    const result = await createAgendaItem(meetingId, {
      title: newTitle,
      sortOrder: items.length,
    })

    if (result.error) {
      setError(result.error)
    } else {
      setNewTitle('')
      router.refresh()
    }
    setAdding(false)
  }

  async function toggleStatus(item: AgendaItem) {
    const nextStatus = item.status === 'open' ? 'done' : 'open'
    await updateAgendaItem(item.id, meetingId, { status: nextStatus })
    router.refresh()
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Agenda <span className="text-kk-muted font-normal">· {items.length}</span>
        </h2>
      </div>

      <div className="divide-y divide-kk-line">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-3 px-5 py-3">
            {isEditable && canEdit && (
              <button
                onClick={() => toggleStatus(item)}
                className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 transition-colors ${
                  item.status === 'done'
                    ? 'bg-kk-good-bg border-kk-good'
                    : 'border-kk-line hover:border-kk-ink'
                }`}
                title={item.status === 'done' ? 'Mark open' : 'Mark done'}
              >
                {item.status === 'done' && (
                  <svg className="w-3 h-3 text-kk-good mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )}
            <span className={`text-sm flex-1 ${item.status === 'done' ? 'text-kk-muted line-through' : 'text-kk-ink'}`}>
              {item.title}
            </span>
          </div>
        ))}

        {items.length === 0 && (
          <div className="px-5 py-4 text-sm text-kk-muted">No agenda items yet.</div>
        )}
      </div>

      {canEdit && isEditable && (
        <div className="px-5 py-3 border-t border-kk-line">
          <form onSubmit={handleAdd} className="flex gap-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Add agenda item…"
              maxLength={500}
              disabled={adding}
              className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
            />
            <button
              type="submit"
              disabled={!newTitle.trim() || adding}
              className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              Add
            </button>
          </form>
          {error && <p className="text-xs text-kk-bad mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}
