'use client'

/**
 * TodoBlock — compact personal to-do widget.
 *
 * Used on the Today page. Receives initial server-fetched data as props.
 * After any mutation it calls router.refresh() which re-runs the server
 * component and passes fresh data back through props.
 *
 * Security: all mutations go through server actions that derive the user
 * identity from getCurrentUser() — no user_id is ever passed from this client.
 */

import { useState, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createTodo, completeTodo, cancelTodo, reopenTodo } from '@/lib/actions/todos'
import type { Todo } from '@/lib/types'
import Link from 'next/link'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  openTodos: Todo[]
  completedThisWeek: Todo[]
  maxItems?: number     // if set, cap visible open todos (badge still shows full count)
  showFooter?: boolean  // if true, render a footer link instead of the header "All →" link
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TodoBlock({ openTodos, completedThisWeek, maxItems, showFooter }: Props) {
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
    <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07),0_1px_2px_-1px_rgba(0,0,0,0.04)]">
      {/* Header */}
      <div className="px-4 py-2 border-b border-kk-line flex items-center justify-between">
        <h2 className="text-sm font-bold text-kk-ink flex items-center gap-1.5">
          <span className="text-kk-ink/50 shrink-0">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M9.5 4.5h4M9.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </span>
          To-Dos
          {openTodos.length > 0 && (
            <span className="text-kk-muted font-normal ml-1">· {openTodos.length} open</span>
          )}
        </h2>
        <div className="flex items-center gap-3">
          {completedThisWeek.length > 0 && (
            <span className="text-xs text-kk-good font-medium">
              {completedThisWeek.length} completed this week
            </span>
          )}
          {!showFooter && (
            <Link href="/todos" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
              All →
            </Link>
          )}
        </div>
      </div>

      {/* Quick-add form */}
      <form onSubmit={handleCreate} className="px-4 py-2 border-b border-kk-line flex items-center gap-2">
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
        <div className="px-5 py-2 text-xs text-kk-bad">{createError}</div>
      )}

      {/* Open todos */}
      {openTodos.length === 0 && completedThisWeek.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-kk-muted">
          No to-dos. Add one above.
        </div>
      ) : (
        <div className="divide-y divide-kk-line">
          {(maxItems ? openTodos.slice(0, maxItems) : openTodos).map(todo => (
            <div
              key={todo.id}
              className="flex items-center gap-3 px-4 py-1.5 group"
            >
              {/* Complete button */}
              <button
                onClick={() => handleAction(() => completeTodo(todo.id))}
                disabled={isPending}
                className="w-4 h-4 rounded border border-kk-line hover:border-kk-good hover:bg-kk-good-bg transition-colors shrink-0 disabled:opacity-40 flex items-center justify-center"
                title="Mark complete"
                aria-label="Mark complete"
              />

              {/* Title + priority */}
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <PriorityDot priority={todo.priority} />
                <span className="text-sm font-semibold text-kk-ink truncate">{todo.title}</span>
              </div>

              {/* Priority label */}
              <span className="text-[10px] text-kk-muted shrink-0">
                {PRIORITY_CONFIG[todo.priority]?.label}
              </span>

              {/* Cancel button — visible on hover */}
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

          {/* Completed this week */}
          {completedThisWeek.length > 0 && (
            <>
              <div className="px-5 py-2 bg-kk-soft">
                <span className="text-xs font-medium text-kk-good">
                  ✓ Completed this week · {completedThisWeek.length}
                </span>
              </div>
              {completedThisWeek.map(todo => (
                <div key={todo.id} className="flex items-center gap-3 px-5 py-3 group opacity-70">
                  <div className="w-4 h-4 rounded border border-kk-good bg-kk-good-bg shrink-0 flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-kk-good" />
                    </svg>
                  </div>
                  <span className="flex-1 text-sm text-kk-muted line-through truncate">{todo.title}</span>
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
            </>
          )}
        </div>
      )}

      {actionError && (
        <div className="px-5 py-2 border-t border-kk-line text-xs text-kk-bad">{actionError}</div>
      )}

      {showFooter && (
        <div className="px-4 py-1.5 border-t border-kk-line flex justify-end">
          <Link href="/todos" className="text-xs text-kk-brand font-medium hover:opacity-70 transition-opacity">
            View all to-dos →
          </Link>
        </div>
      )}
    </div>
  )
}
