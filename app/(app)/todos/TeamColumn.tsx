'use client'

import { useState, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { PriorityDot } from '@/components/ui/PriorityDot'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'
import { createTodo, completeTodo, completeRecurringTodo, setTodoNotify } from '@/lib/actions/todos'
import type { TeamTodo } from '@/lib/types'
import TodoEditPanel from '@/components/todos/TodoEditPanel'

type UserOption = { id: string; display_name: string; email: string }

interface Props {
  name: string
  todos: TeamTodo[]
  interactive?: boolean
  currentUserId?: string
  allUsers?: UserOption[]
  projects?: { id: string; title: string }[]
}

export default function TeamColumn({ name, todos, interactive, allUsers }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [title, setTitle] = useState('')
  const [createRecurrence, setCreateRecurrence] = useState('')
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [contextText, setContextText] = useState('')
  const [contextLoading, setContextLoading] = useState(false)
  const [notifyOpenId, setNotifyOpenId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
    setContextLoading(false)
    startTransition(() => router.refresh())
  }

  return (
    <div className="min-w-0">
      <div className="mb-2">
        <span className="text-lg font-black uppercase tracking-wide text-kk-ink">{name}</span>
        {todos.length > 0 && (
          <span className="text-xs text-kk-muted ml-1">· {todos.length}</span>
        )}
      </div>

      <div className="space-y-1.5">
        {interactive && (
          <div>
            <form onSubmit={handleCreate} className="flex gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Add a to-do..."
                maxLength={200}
                disabled={isPending}
                className="flex-1 text-sm bg-kraft-bg border-2 border-[#171717] rounded-lg px-2.5 py-1.5 text-kk-ink placeholder:text-kk-muted outline-none min-w-0"
              />
              <button
                type="submit"
                disabled={!title.trim() || isPending}
                className="text-xs px-2.5 py-1.5 bg-[#171717] text-kraft-light rounded-lg disabled:opacity-30 hover:opacity-80 transition-opacity shrink-0 [box-shadow:2px_2px_0_#555555]"
              >
                +
              </button>
            </form>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] text-kk-muted">↻</span>
              <select
                value={createRecurrence}
                onChange={e => setCreateRecurrence(e.target.value)}
                className="text-[10px] text-kk-muted bg-transparent outline-none cursor-pointer hover:text-kk-ink transition-colors"
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

        {todos.length === 0 && !interactive && (
          <div className="bg-kraft-light border-2 border-[#171717]/40 rounded-lg px-3 py-4 text-center">
            <span className="text-xs text-kk-muted">No open to-dos</span>
          </div>
        )}

        {todos.map(todo => (
          <div key={todo.id} className="min-w-0">
            {/* Card */}
            <div
              className="bg-kraft-light border-2 border-[#171717] rounded-lg px-3 py-2 [box-shadow:2px_2px_0_#555555] min-w-0"
            >
              <div className="flex items-start gap-2 min-w-0">
                {interactive && (
                  <button
                    onClick={() => { setCompletingId(completingId === todo.id ? null : todo.id); setContextText(''); setEditingId(null) }}
                    className="mt-0.5 w-4 h-4 rounded border-2 border-[#171717] bg-kraft-light shrink-0 flex items-center justify-center [box-shadow:1px_1px_0_#555555] hover:bg-[#171717] hover:text-kraft-light transition-colors"
                    title="Mark complete"
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" className="opacity-0 group-hover:opacity-100" aria-hidden="true">
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
                {interactive && (
                  <button
                    onClick={() => { setEditingId(editingId === todo.id ? null : todo.id); setCompletingId(null) }}
                    className="text-[10px] text-kk-muted hover:text-kk-ink transition-colors shrink-0 mt-0.5"
                    title="Edit"
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* Edit panel */}
              {interactive && editingId === todo.id && (
                <TodoEditPanel
                  todo={{ id: todo.id, title: todo.title, notes: todo.notes, recurrence_rule: todo.recurrence_rule, recurrence_day: todo.recurrence_day }}
                  onClose={() => setEditingId(null)}
                />
              )}
            </div>

            {/* Completion context — expands below card on click */}
            {interactive && completingId === todo.id && (
              <div className="mt-1 bg-kraft-bg border border-[#171717]/30 rounded-lg px-3 py-2 space-y-1.5">
                <p className="text-[10px] text-kk-muted">What happened?</p>
                <textarea
                  value={contextText}
                  onChange={e => setContextText(e.target.value)}
                  rows={2}
                  placeholder="e.g. Sent the report, confirmed receipt."
                  className="w-full text-xs text-kk-ink bg-kraft-light border border-[#171717]/20 rounded px-2 py-1 outline-none resize-none placeholder:text-kk-muted"
                  disabled={contextLoading}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleComplete(todo.id, !!todo.recurrence_rule) }
                    if (e.key === 'Escape') setCompletingId(null)
                  }}
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleComplete(todo.id, !!todo.recurrence_rule)}
                    disabled={!contextText.trim() || contextLoading}
                    className="text-[10px] px-2 py-1 bg-[#171717] text-kraft-light rounded disabled:opacity-30 hover:opacity-80"
                  >
                    {contextLoading ? '...' : 'Done'}
                  </button>
                  {allUsers && (
                    notifyOpenId === todo.id ? (
                      <select
                        value=""
                        onChange={async e => {
                          if (e.target.value) {
                            await setTodoNotify(todo.id, e.target.value)
                            startTransition(() => router.refresh())
                          }
                          setNotifyOpenId(null)
                        }}
                        className="text-[10px] text-kk-ink bg-kraft-light border border-[#171717]/20 rounded px-1.5 py-0.5 outline-none cursor-pointer"
                        autoFocus
                        onBlur={() => setNotifyOpenId(null)}
                      >
                        <option value="">Notify...</option>
                        {allUsers.map(u => (
                          <option key={u.id} value={u.id}>{u.display_name.split(' ')[0]}</option>
                        ))}
                      </select>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setNotifyOpenId(todo.id) }}
                        className="text-[10px] px-2 py-1 text-kk-muted hover:text-kk-ink transition-colors"
                      >
                        Notify
                      </button>
                    )
                  )}
                  <button
                    onClick={() => setCompletingId(null)}
                    className="text-[10px] px-2 py-1 text-kk-muted hover:text-kk-ink"
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
