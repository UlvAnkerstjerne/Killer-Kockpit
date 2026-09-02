'use client'

/**
 * TodoPageClient — full interactive todos list for the dedicated /todos page.
 *
 * Receives server-fetched data as props; calls server actions on mutations and
 * refreshes via router.refresh() so the server component re-runs with fresh data.
 *
 * Security: no user_id is passed from this client — all mutations derive identity
 * server-side via getCurrentUser().
 */

import { useState, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createTodo, completeTodo, cancelTodo, reopenTodo } from '@/lib/actions/todos'
import type { Todo } from '@/lib/types'

// ---------------------------------------------------------------------------
// Priority config
// ---------------------------------------------------------------------------

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Critical',
  2: 'Normal',
  3: 'Low',
  4: 'Background',
}

function PriorityDot({ priority }: { priority: number }) {
  if (priority === 1) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded shrink-0">
        !!
      </span>
    )
  }
  if (priority === 3) {
    return <span className="w-1.5 h-1.5 rounded-full shrink-0 opacity-30 bg-kk-line" />
  }
  if (priority === 4) {
    return <span className="w-1.5 h-1.5 rounded-full shrink-0 opacity-20 bg-kk-line" />
  }
  return null
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  openTodos: Todo[]
  completedTodos: Todo[]
  cancelledTodos: Todo[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TodoPageClient({ openTodos, completedTodos, cancelledTodos }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(2)
  const [createError, setCreateError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setCreateError(null)
    const result = await createTodo(title.trim(), priority)
    if (result.error) {
      setCreateError(result.error)
      return
    }
    setTitle('')
    setPriority(2)
    startTransition(() => router.refresh())
    inputRef.current?.focus()
  }

  async function handleAction(action: () => Promise<{ error?: string }>) {
    setActionError(null)
    const result = await action()
    if (result.error) {
      setActionError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="space-y-6">
      {/* Quick-add */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl">
        <form onSubmit={handleCreate} className="px-5 py-3.5 flex items-center gap-3">
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Add a to-do…"
            maxLength={200}
            className="flex-1 text-sm bg-transparent outline-none text-kk-ink placeholder:text-kk-muted"
            disabled={isPending}
          />
          <select
            value={priority}
            onChange={e => setPriority(Number(e.target.value) as 1 | 2 | 3 | 4)}
            className="text-xs text-kk-muted bg-transparent border border-kk-line rounded-lg px-2 py-1 outline-none cursor-pointer hover:border-kk-ink transition-colors shrink-0"
            disabled={isPending}
            aria-label="Priority"
          >
            <option value={1}>Critical</option>
            <option value={2}>Normal</option>
            <option value={3}>Low</option>
            <option value={4}>Background</option>
          </select>
          <button
            type="submit"
            disabled={!title.trim() || isPending}
            className="text-xs px-3 py-1.5 bg-kk-ink text-white rounded-lg disabled:opacity-30 transition-opacity hover:opacity-80 shrink-0"
          >
            Add
          </button>
        </form>
        {createError && (
          <div className="px-5 pb-3 text-xs text-kk-bad">{createError}</div>
        )}
      </div>

      {/* Open todos */}
      <Section title="Open" count={openTodos.length} emptyText="No open to-dos.">
        {openTodos.map(todo => (
          <div key={todo.id} className="flex items-center gap-3 px-5 py-3 group">
            <button
              onClick={() => handleAction(() => completeTodo(todo.id))}
              disabled={isPending}
              className="w-4 h-4 rounded border border-kk-line hover:border-kk-good hover:bg-kk-good-bg transition-colors shrink-0 disabled:opacity-40 flex items-center justify-center"
              title="Mark complete"
              aria-label="Mark complete"
            />
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <PriorityDot priority={todo.priority} />
              <span className="text-sm text-kk-ink truncate">{todo.title}</span>
            </div>
            <span className="text-xs text-kk-muted shrink-0 opacity-0 group-hover:opacity-60">
              {PRIORITY_LABELS[todo.priority]}
            </span>
            <button
              onClick={() => handleAction(() => cancelTodo(todo.id))}
              disabled={isPending}
              className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 hover:text-kk-bad transition-all disabled:opacity-0 shrink-0"
              title="Cancel"
              aria-label="Cancel"
            >
              ×
            </button>
          </div>
        ))}
      </Section>

      {/* Completed todos */}
      {completedTodos.length > 0 && (
        <Section title="Completed" count={completedTodos.length}>
          {completedTodos.map(todo => (
            <div key={todo.id} className="flex items-center gap-3 px-5 py-3 group opacity-70">
              <div className="w-4 h-4 rounded border border-kk-good bg-kk-good-bg shrink-0 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-kk-good" />
                </svg>
              </div>
              <span className="flex-1 text-sm text-kk-muted line-through truncate">{todo.title}</span>
              {todo.completed_at && (
                <span className="text-xs text-kk-muted shrink-0 opacity-0 group-hover:opacity-100">
                  {new Date(todo.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              )}
              <button
                onClick={() => handleAction(() => reopenTodo(todo.id))}
                disabled={isPending}
                className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 hover:text-kk-ink transition-all disabled:opacity-0 shrink-0"
                title="Reopen"
              >
                ↩
              </button>
            </div>
          ))}
        </Section>
      )}

      {/* Cancelled todos */}
      {cancelledTodos.length > 0 && (
        <Section title="Cancelled" count={cancelledTodos.length}>
          {cancelledTodos.map(todo => (
            <div key={todo.id} className="flex items-center gap-3 px-5 py-3 group opacity-50">
              <div className="w-4 h-4 rounded border border-kk-line shrink-0" />
              <span className="flex-1 text-sm text-kk-muted line-through truncate">{todo.title}</span>
              {todo.cancelled_at && (
                <span className="text-xs text-kk-muted shrink-0 opacity-0 group-hover:opacity-100">
                  {new Date(todo.cancelled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              )}
              <button
                onClick={() => handleAction(() => reopenTodo(todo.id))}
                disabled={isPending}
                className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 hover:text-kk-ink transition-all disabled:opacity-0 shrink-0"
                title="Reopen"
              >
                ↩
              </button>
            </div>
          ))}
        </Section>
      )}

      {actionError && (
        <div className="text-xs text-kk-bad px-1">{actionError}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  title,
  count,
  emptyText,
  children,
}: {
  title: string
  count: number
  emptyText?: string
  children?: React.ReactNode
}) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          {title}
          {count > 0 && (
            <span className="text-kk-muted font-normal ml-1">· {count}</span>
          )}
        </h2>
      </div>
      {count === 0 && emptyText ? (
        <div className="px-5 py-8 text-center text-sm text-kk-muted">{emptyText}</div>
      ) : (
        <div className="divide-y divide-kk-line">{children}</div>
      )}
    </div>
  )
}
