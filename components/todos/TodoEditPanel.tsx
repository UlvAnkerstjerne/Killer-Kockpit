'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateTodo, updateTodoNotes, updateTodoRecurrence } from '@/lib/actions/todos'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'

const RECURRENCE_OPTIONS = [
  { value: '', label: 'No repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
]

export interface EditableTodo {
  id: string
  title: string
  notes: string | null
  recurrence_rule: string | null
  recurrence_day: number | null
}

interface Props {
  todo: EditableTodo
  onClose: () => void
}

export default function TodoEditPanel({ todo, onClose }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [title, setTitle] = useState(todo.title)
  const [notes, setNotes] = useState(todo.notes ?? '')
  const [recurrence, setRecurrence] = useState(todo.recurrence_rule ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Build options: always show none/daily/weekly, plus current rule if it's something else
  const options = [...RECURRENCE_OPTIONS]
  if (todo.recurrence_rule && !options.some(o => o.value === todo.recurrence_rule)) {
    options.push({
      value: todo.recurrence_rule,
      label: formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day),
    })
  }

  async function handleSave() {
    const trimmedTitle = title.trim()
    if (saving || !trimmedTitle) return
    setSaving(true)
    setError(null)

    if (trimmedTitle !== todo.title) {
      const res = await updateTodo(todo.id, { title: trimmedTitle })
      if (res.error) { setError(res.error); setSaving(false); return }
    }

    const newNotes = notes.trim() || null
    if (newNotes !== (todo.notes ?? null)) {
      const res = await updateTodoNotes(todo.id, newNotes)
      if (res.error) { setError(res.error); setSaving(false); return }
    }

    const newRule = recurrence || null
    if (newRule !== (todo.recurrence_rule ?? null)) {
      const res = await updateTodoRecurrence(todo.id, newRule, null)
      if (res.error) { setError(res.error); setSaving(false); return }
    }

    setSaving(false)
    startTransition(() => router.refresh())
    onClose()
  }

  return (
    <div className="mt-2 pt-2 border-t border-[#171717]/20 space-y-2">
      <label className="block">
        <span className="text-[10px] text-kk-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
          disabled={saving}
          className="mt-0.5 w-full text-sm text-kk-ink bg-kk-soft rounded-lg px-3 py-1.5 outline-none"
          autoFocus
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave() }
            if (e.key === 'Escape') onClose()
          }}
        />
      </label>

      <label className="block">
        <span className="text-[10px] text-kk-muted">Notes</span>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          placeholder="Add a note..."
          disabled={saving}
          className="mt-0.5 w-full text-xs text-kk-ink bg-kk-soft rounded-lg px-3 py-1.5 outline-none resize-none placeholder:text-kk-muted"
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
          }}
        />
      </label>

      <label className="flex items-center gap-2">
        <span className="text-[10px] text-kk-muted">Repeat</span>
        <select
          value={recurrence}
          onChange={e => setRecurrence(e.target.value)}
          disabled={saving}
          className="text-xs text-kk-ink bg-kk-soft rounded px-2 py-1 outline-none cursor-pointer"
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>

      {error && <p className="text-xs text-kk-bad">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!title.trim() || saving}
          className="text-xs px-3 py-1 bg-[#171717] text-kraft-light rounded-lg disabled:opacity-30 hover:opacity-80 transition-opacity"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="text-xs px-3 py-1 border border-[#171717]/30 text-kk-muted rounded-lg hover:bg-[#B7A486]/20 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
