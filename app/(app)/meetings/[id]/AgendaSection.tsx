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

  // Per-item inline editing
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editSaving, setEditSaving] = useState(false)

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

  function startEdit(item: AgendaItem) {
    setEditingItemId(item.id)
    setEditTitle(item.title)
    setEditDesc(item.description ?? '')
    setError(null)
  }

  function cancelEdit() {
    setEditingItemId(null)
    setEditTitle('')
    setEditDesc('')
    setError(null)
  }

  async function handleEditSave(item: AgendaItem) {
    if (editSaving) return
    setEditSaving(true)
    setError(null)

    const result = await updateAgendaItem(item.id, meetingId, {
      title: editTitle,
      description: editDesc,
    })

    setEditSaving(false)
    if (result.error) {
      setError(result.error)
    } else {
      setEditingItemId(null)
      router.refresh()
    }
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
          <div key={item.id} className="group px-5 py-3">
            {editingItemId === item.id ? (
              /* ── Edit mode ─────────────────────────────────────────────── */
              <div className="space-y-2">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={500}
                  disabled={editSaving}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  className="w-full px-3 py-1.5 border border-kk-line rounded-lg text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors"
                />
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Description (optional)"
                  rows={2}
                  disabled={editSaving}
                  className="w-full px-3 py-1.5 border border-kk-line rounded-lg text-xs text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEditSave(item)}
                    disabled={!editTitle.trim() || editSaving}
                    className="px-3 py-1 bg-kk-ink text-white text-xs rounded-lg disabled:opacity-40 hover:opacity-90 transition-opacity"
                  >
                    {editSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={cancelEdit}
                    disabled={editSaving}
                    className="px-3 py-1 border border-kk-line text-xs text-kk-muted rounded-lg hover:bg-kk-soft transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* ── Read mode ─────────────────────────────────────────────── */
              <div className="flex items-start gap-3">
                <span className={`text-sm flex-1 ${item.status === 'done' ? 'text-kk-muted line-through' : 'text-kk-ink'}`}>
                  {item.title}
                  {item.description && (
                    <span className="block text-xs text-kk-muted mt-0.5">{item.description}</span>
                  )}
                </span>
                {isEditable && canEdit && (
                  <button
                    onClick={() => startEdit(item)}
                    className="opacity-0 group-hover:opacity-100 text-xs text-kk-muted hover:text-kk-ink transition-all shrink-0 mt-0.5"
                    title="Edit item"
                  >
                    ✎
                  </button>
                )}
              </div>
            )}
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
