'use client'

import { useState, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PriorityDot } from '@/components/ui/PriorityDot'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'
import { createTodo, completeTodo, completeRecurringTodo } from '@/lib/actions/todos'
import type { TeamTodo } from '@/lib/types'

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
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [contextText, setContextText] = useState('')
  const [contextLoading, setContextLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isViewingOwn = selectedPerson === 'me'
  const activeTodos = isViewingOwn
    ? myTodos
    : teamColumns.find(c => c.name === selectedPerson)?.todos ?? []

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || isPending) return
    await createTodo(title.trim(), 2, null, null, null)
    setTitle('')
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
            className="flex items-center gap-1.5 text-sm text-kraft-dark mb-3 py-1"
          >
            <span className="text-lg leading-none">&lsaquo;</span>
            <span>{returnTo === '/store' ? 'Store Dashboard' : 'Back'}</span>
          </Link>
        )}
        <h1 className="text-2xl font-black tracking-tight text-kraft-light">To-Dos</h1>
      </div>

      {/* Person selector (only for management users with team columns) */}
      {teamColumns.length > 0 && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            onClick={() => setSelectedPerson('me')}
            className={`shrink-0 text-xs font-bold px-3 py-2 rounded-lg transition-colors ${
              isViewingOwn
                ? 'bg-kraft-light text-[#171717]'
                : 'text-kraft-dark hover:text-kraft-light'
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
                  ? 'bg-kraft-light text-[#171717]'
                  : 'text-kraft-dark hover:text-kraft-light'
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
        <form onSubmit={handleCreate} className="flex gap-2 mb-4">
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
      )}

      {/* Todo list */}
      <div className="space-y-2">
        {activeTodos.length === 0 && (
          <div className="bg-kraft-light/10 border border-kraft-dark/20 rounded-lg px-4 py-6 text-center">
            <span className="text-sm text-kraft-dark">
              {isViewingOwn ? 'No open to-dos' : `No open to-dos for ${selectedPerson}`}
            </span>
          </div>
        )}

        {activeTodos.map(todo => (
          <div key={todo.id}>
            <div
              className="bg-kraft-light border-2 border-[#171717] rounded-lg px-4 py-3 flex items-center gap-3"
              onClick={isViewingOwn ? () => {
                setCompletingId(completingId === todo.id ? null : todo.id)
                setContextText('')
              } : undefined}
              style={isViewingOwn ? { cursor: 'pointer' } : undefined}
            >
              {isViewingOwn && (
                <div className="w-5 h-5 rounded border-2 border-[#171717] bg-kraft-light shrink-0" />
              )}
              <PriorityDot priority={todo.priority} size="md" />
              <span className="text-sm font-semibold text-kk-ink flex-1 min-w-0">
                {todo.title}
              </span>
              {todo.recurrence_rule && (
                <span className="text-[10px] text-kk-brand/60 shrink-0">
                  ↻ {formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day)}
                </span>
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
