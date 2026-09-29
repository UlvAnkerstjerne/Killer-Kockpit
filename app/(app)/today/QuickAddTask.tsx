'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createTask } from '@/lib/actions/tasks'

export default function QuickAddTask() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    setError(null)
    const result = await createTask({ title: title.trim() })
    setSaving(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setTitle('')
    router.refresh()
    inputRef.current?.focus()
  }

  return (
    <div className="border-b-2 border-[#171717]">
      <form onSubmit={handleSubmit} className="px-4 py-2.5 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Add a task..."
          maxLength={200}
          disabled={saving}
          className="flex-1 text-sm bg-kraft-bg border-2 border-[#171717] rounded-lg px-3 py-1.5 text-kk-ink placeholder:text-kk-muted outline-none transition-colors"
        />
        <button
          type="submit"
          disabled={!title.trim() || saving}
          className="text-xs px-3 py-1.5 bg-[#171717] text-kraft-light rounded-lg disabled:opacity-30 transition-opacity hover:opacity-80 shrink-0 [box-shadow:3px_3px_0_#555555]"
        >
          Add
        </button>
      </form>
      {error && <div className="px-4 pb-2 text-xs text-kk-bad">{error}</div>}
    </div>
  )
}
