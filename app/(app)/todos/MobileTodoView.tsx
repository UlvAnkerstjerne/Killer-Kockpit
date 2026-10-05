'use client'

import { useState, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PriorityDot } from '@/components/ui/PriorityDot'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'
import { createTodo, completeTodo, completeRecurringTodo } from '@/lib/actions/todos'
import type { TeamTodo } from '@/lib/types'
import TodoEditPanel from '@/components/todos/TodoEditPanel'

type UserOption = { id: string; display_name: string; email: string }

interface Props {
  myName: string
  myTodos: TeamTodo[]
  teamColumns: { name: string; todos: TeamTodo[] }[]
  currentUserId: string
  allUsers: UserOption[]
  projects: { id: string; title: string }[]
  returnTo?: string
}

export default function MobileTodoView({
  myName,
  myTodos,
  teamColumns,
  currentUserId,
  allUsers,
  projects,
  returnTo,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selectedPerson, setSelectedPerson] = useState<string>('me')
  const [title, setTitle] = useState('')
  const [createRecurrence, setCreateRecurrence] = useState('')
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [contextText, setContextText] = useState('')
  const [contextLoading, setContextLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const isViewingOwn = selectedPerson === 'me'
  const activeTodos = isViewingOwn
    ? myTodos
    : teamColumns.find(c => c.name === selectedPerson)?.todos ?? []

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || isPending) return
    await createTodo(title.trim(), 2, null, createRecurrence || null, null)
    setTitle('')
    setCreateRecurrence('')
    startTransition(() => router.refresh())
    inputRef.current?.focus()
  }

  async function handleComplete(todoId: string, isRecurring: boolean) {
    if (!contextText.trim() || contextLoading) return
    setContextLoading(true)
    await (isRecurring ? completeRecurringTodo(todoId, contextText) : completeTodo(todoId, contextText))
    setCompletingId(null)
    setContextText('')
    setContextLoading(false)
    startTransition(() => router.refresh())
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        {returnTo && (
          <Link
            href={returnTo}
            className="flex items-center gap-1.5 text-sm text-kk-muted mb-3 py-1"
          >
            <span className="text-lg leading-none">&lsaquo;</span>
            <span>{returnTo === '/store' ? 'Store Dashboard' : 'Back'}</span>
          </Link>
        )}
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">To-Dos</h1>
      </div>

      {/* Person selector (only for management users with team columns) */}
      {teamColumns.length > 0 && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            onClick={() => setSelectedPerson('me')}
            className={`shrink-0 text-xs font-bold px-3 py-2 rounded-lg transition-colors ${
              isViewingOwn
                ? 'bg-[#171717] text-kraft-light'
                : 'text-kk-muted hover:text-kk-ink'
            }`}
          >
            {myName}
          </button>
          {teamColumns.map(col => (
            <button
              key={col.name}
              onClick={() => setSelectedPerson(col.name)}
              className={`shrink-0 text-xs font-bold px-3 py-2 rounded-lg transition-colors ${
                selectedPerson === col.name
                  ? 'bg-[#171717] text-kraft-light'
                  : 'text-kk-muted hover:text-kk-ink'
              }`}
            >
              {col.name}
              {col.todos.length > 0 && (
                <span className="ml-1 text-[10px] opacity-60">{col.todos.length}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Create form (own todos only) */}
      {isViewingOwn && (
        <div className="mb-4">
          <form onSubmit={handleCreate} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Add a to-do..."
              maxLength={200}
              disabled={isPending}
              className="flex-1 text-sm bg-kraft-bg border-2 border-[#171717] rounded-lg px-3 py-2.5 text-kk-ink placeholder:text-kk-muted outline-none min-w-0"
            />
            <button
              type="submit"
              disabled={!title.trim() || isPending}
              className="text-sm font-bold px-4 py-2.5 bg-kraft-light text-[#171717] rounded-lg disabled:opacity-30 shrink-0"
            >
              Add
            </button>
          </form>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-[10px] text-kk-muted">↻</span>
            <select
              value={createRecurrence}
              onChange={e => setCreateRecurrence(e.target.value)}
              className="text-xs text-kk-muted bg-transparent outline-none cursor-pointer hover:text-kk-ink transition-colors"
              disabled={isPending}
              aria-label="Repeat"
            >
              <option value="">No repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
        </div>
      )}

      {/* Todo list */}
      <div className="space-y-2">
        {activeTodos.length === 0 && (
          <div className="bg-kraft-brown/20 border border-[#171717]/15 rounded-lg px-4 py-6 text-center">
            <span className="text-sm text-kk-muted">
              {isViewingOwn ? 'No open to-dos' : `No open to-dos for ${selectedPerson}`}
            </span>
          </div>
        )}

        {activeTodos.map(todo => (
          <div key={todo.id}>
            <div className="bg-kraft-light border-2 border-[#171717] rounded-lg px-4 py-3 min-w-0">
              <div className="flex items-start gap-3 min-w-0">
                {isViewingOwn && (
                  <button
                    onClick={() => {
                      setCompletingId(completingId === todo.id ? null : todo.id)
                      setContextText('')
                      setEditingId(null)
                    }}
                    className="mt-0.5 w-5 h-5 rounded border-2 border-[#171717] bg-kraft-light shrink-0 hover:bg-[#171717] hover:text-kraft-light transition-colors flex items-center justify-center"
                    title="Mark complete"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-0" aria-hidden="true">
                      <path d="M1.5 5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
                <PriorityDot priority={todo.priority} size="md" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-semibold text-kk-ink break-words" style={{ wordBreak: 'break-word' }}>
                    {todo.title}
                  </span>
                  {todo.recurrence_rule && (
                    <span className="text-[10px] text-kk-brand/60 ml-1.5">
                      ↻ {formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day)}
                    </span>
                  )}
                  {todo.notes && (
                    <p className="text-xs text-kk-muted mt-0.5 break-words" style={{ wordBreak: 'break-word' }}>{todo.notes}</p>
                  )}
                </div>
                {isViewingOwn && (
                  <button
                    onClick={() => { setEditingId(editingId === todo.id ? null : todo.id); setCompletingId(null) }}
                    className="text-xs text-kk-muted hover:text-kk-ink transition-colors shrink-0 mt-0.5"
                    title="Edit"
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* Edit panel */}
              {isViewingOwn && editingId === todo.id && (
                <TodoEditPanel
                  todo={{ id: todo.id, title: todo.title, notes: todo.notes, recurrence_rule: todo.recurrence_rule, recurrence_day: todo.recurrence_day }}
                  onClose={() => setEditingId(null)}
                />
              )}
            </div>

            {/* Completion context */}
            {isViewingOwn && completingId === todo.id && (
              <div className="mt-1.5 bg-kraft-bg border border-[#171717]/30 rounded-lg px-4 py-3 space-y-2">
                <p className="text-xs text-kk-muted">What happened?</p>
                <textarea
                  value={contextText}
                  onChange={e => setContextText(e.target.value)}
                  rows={2}
                  placeholder="e.g. Sent the report, confirmed receipt."
                  className="w-full text-sm text-kk-ink bg-kraft-light border border-[#171717]/20 rounded-lg px-3 py-2 outline-none resize-none placeholder:text-kk-muted"
                  disabled={contextLoading}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleComplete(todo.id, !!todo.recurrence_rule) }
                    if (e.key === 'Escape') setCompletingId(null)
                  }}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleComplete(todo.id, !!todo.recurrence_rule)}
                    disabled={!contextText.trim() || contextLoading}
                    className="text-sm font-bold px-4 py-2 bg-[#171717] text-kraft-light rounded-lg disabled:opacity-30"
                  >
                    {contextLoading ? '...' : 'Done'}
                  </button>
                  <button
                    onClick={() => setCompletingId(null)}
                    className="text-sm px-3 py-2 text-kk-muted hover:text-kk-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
