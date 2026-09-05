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
import {
  createTodo,
  completeTodo,
  completeRecurringTodo,
  cancelTodo,
  reopenTodo,
  updateTodo,
  updateTodoNotes,
  updateTodoRecurrence,
} from '@/lib/actions/todos'
import type { Todo } from '@/lib/types'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPEAT_OPTIONS: { value: string; label: string }[] = [
  { value: '',         label: 'No repeat' },
  { value: 'daily',    label: 'Daily' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly',   label: 'Weekly' },
  { value: 'mon',      label: 'Every Monday' },
  { value: 'tue',      label: 'Every Tuesday' },
  { value: 'wed',      label: 'Every Wednesday' },
  { value: 'thu',      label: 'Every Thursday' },
  { value: 'fri',      label: 'Every Friday' },
  { value: 'sat',      label: 'Every Saturday' },
  { value: 'sun',      label: 'Every Sunday' },
  { value: 'monthly',  label: 'Monthly' },
]

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

  // Create form state
  const [title, setTitle]               = useState('')
  const [priority, setPriority]         = useState<1 | 2 | 3 | 4>(2)
  const [createRepeat, setCreateRepeat] = useState('')
  const [createDay, setCreateDay]       = useState<number>(1)
  const [createNotes, setCreateNotes]   = useState('')
  const [showNotes, setShowNotes]       = useState(false)
  const [createError, setCreateError]   = useState<string | null>(null)

  // Mutation error
  const [actionError, setActionError] = useState<string | null>(null)

  // Inline note editing
  const [editingNoteId,   setEditingNoteId]   = useState<string | null>(null)
  const [editingNoteText, setEditingNoteText] = useState('')

  // Inline recurrence editing
  const [editingRepeatId, setEditingRepeatId] = useState<string | null>(null)
  const [editRepeatRule,  setEditRepeatRule]  = useState<string>('')
  const [editRepeatDay,   setEditRepeatDay]   = useState<number>(1)

  // Inline title editing
  const [editingTitleId,   setEditingTitleId]   = useState<string | null>(null)
  const [editingTitleText, setEditingTitleText] = useState('')

  // Inline scheduled date editing (non-recurring todos only)
  const [editingScheduledId,   setEditingScheduledId]   = useState<string | null>(null)
  const [editingScheduledDate, setEditingScheduledDate] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setCreateError(null)

    const result = await createTodo(
      title.trim(),
      priority,
      createNotes.trim() || null,
      createRepeat || null,
      createRepeat === 'monthly' ? createDay : null,
    )
    if (result.error) {
      setCreateError(result.error)
      return
    }
    setTitle('')
    setPriority(2)
    setCreateRepeat('')
    setCreateNotes('')
    setShowNotes(false)
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

  async function handleNoteSave(todoId: string) {
    if (editingNoteId !== todoId) return
    setEditingNoteId(null)
    const result = await updateTodoNotes(todoId, editingNoteText.trim() || null)
    if (result.error) {
      setActionError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  function startNoteEdit(todoId: string, currentNote: string | null) {
    setEditingNoteId(todoId)
    setEditingNoteText(currentNote ?? '')
  }

  function startRepeatEdit(todo: Todo) {
    setEditingRepeatId(todo.id)
    setEditRepeatRule(todo.recurrence_rule ?? '')
    // Snap to nearest valid v1 option (1 = first, 31 = last); any legacy day snaps to 1
    setEditRepeatDay(todo.recurrence_day === 31 ? 31 : 1)
  }

  async function handleRepeatSave(todoId: string) {
    setEditingRepeatId(null)
    const result = await updateTodoRecurrence(
      todoId,
      editRepeatRule || null,
      editRepeatRule === 'monthly' ? editRepeatDay : null,
    )
    if (result.error) {
      setActionError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  function startTitleEdit(todo: Todo) {
    setEditingTitleId(todo.id)
    setEditingTitleText(todo.title)
  }

  async function handleTitleSave(todoId: string) {
    const trimmed = editingTitleText.trim()
    setEditingTitleId(null)
    if (!trimmed) return
    const result = await updateTodo(todoId, { title: trimmed })
    if (result.error) {
      setActionError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  function startScheduledEdit(todo: Todo) {
    setEditingScheduledId(todo.id)
    // Convert stored UTC timestamp to Copenhagen date string YYYY-MM-DD
    const date = todo.scheduled_for
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Copenhagen',
          year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(todo.scheduled_for))
      : ''
    setEditingScheduledDate(date)
  }

  async function handleScheduledSave(todoId: string) {
    const dateStr = editingScheduledDate
    setEditingScheduledId(null)
    const scheduled_for = dateStr || null
    const result = await updateTodo(todoId, { scheduled_for })
    if (result.error) {
      setActionError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Create form ─────────────────────────────────────────────────────── */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl">

        {/* Main row: title + priority + add */}
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

        {/* Repeat + notes toggle row */}
        <div className="px-5 pb-3 flex items-center gap-3 flex-wrap border-t border-kk-line/50">
          {/* Repeat select */}
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-[10px] text-kk-muted">↻</span>
            <select
              value={createRepeat}
              onChange={e => setCreateRepeat(e.target.value)}
              className="text-xs text-kk-muted bg-transparent outline-none cursor-pointer hover:text-kk-ink transition-colors"
              disabled={isPending}
              aria-label="Repeat"
            >
              {REPEAT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Monthly day selector */}
          {createRepeat === 'monthly' && (
            <select
              value={createDay}
              onChange={e => setCreateDay(Number(e.target.value))}
              className="mt-2 text-xs text-kk-muted bg-transparent outline-none cursor-pointer hover:text-kk-ink transition-colors"
              disabled={isPending}
              aria-label="Day of month"
            >
              <option value={1}>First day</option>
              <option value={31}>Last day</option>
            </select>
          )}

          {/* Notes toggle */}
          <button
            type="button"
            onClick={() => setShowNotes(v => !v)}
            className={`mt-2 text-xs transition-colors ${showNotes ? 'text-kk-ink' : 'text-kk-muted hover:text-kk-ink'}`}
          >
            {showNotes ? '📝 Hide note' : '+ note'}
          </button>
        </div>

        {/* Notes textarea */}
        {showNotes && (
          <div className="px-5 pb-3">
            <textarea
              value={createNotes}
              onChange={e => setCreateNotes(e.target.value)}
              placeholder="Add a note…"
              rows={2}
              className="w-full text-xs text-kk-ink bg-kk-soft rounded-lg px-3 py-2 outline-none resize-none placeholder:text-kk-muted"
              disabled={isPending}
            />
          </div>
        )}

        {createError && (
          <div className="px-5 pb-3 text-xs text-kk-bad">{createError}</div>
        )}
      </div>

      {/* ── Open todos ──────────────────────────────────────────────────────── */}
      <Section title="Open" count={openTodos.length} emptyText="No open to-dos.">
        {openTodos.map(todo => (
          <div key={todo.id} className="px-5 py-3 group">
            <div className="flex items-start gap-3">
              {/* Complete checkbox */}
              <button
                onClick={() => handleAction(() =>
                  todo.recurrence_rule
                    ? completeRecurringTodo(todo.id)
                    : completeTodo(todo.id)
                )}
                disabled={isPending}
                className="mt-0.5 w-4 h-4 rounded border border-kk-line hover:border-kk-good hover:bg-kk-good-bg transition-colors shrink-0 disabled:opacity-40 flex items-center justify-center"
                title="Mark complete"
                aria-label="Mark complete"
              />

              {/* Content */}
              <div className="flex-1 min-w-0">
                {/* Title row */}
                <div className="flex items-center gap-2 min-w-0">
                  <PriorityDot priority={todo.priority} />
                  {editingTitleId === todo.id ? (
                    <input
                      type="text"
                      value={editingTitleText}
                      onChange={(e) => setEditingTitleText(e.target.value)}
                      onBlur={() => handleTitleSave(todo.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.currentTarget.blur() }
                        if (e.key === 'Escape') { setEditingTitleId(null) }
                      }}
                      maxLength={200}
                      className="flex-1 text-sm font-semibold text-kk-ink bg-kk-soft rounded px-2 py-0.5 outline-none"
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                    />
                  ) : (
                    <span
                      className="text-sm font-semibold text-kk-ink truncate cursor-text hover:text-kk-ink/70 transition-colors"
                      onClick={() => startTitleEdit(todo)}
                      title="Click to edit title"
                    >
                      {todo.title}
                    </span>
                  )}
                </div>

                {/* Scheduled date (non-recurring only) */}
                {!todo.recurrence_rule && (
                  editingScheduledId === todo.id ? (
                    <input
                      type="date"
                      value={editingScheduledDate}
                      onChange={(e) => setEditingScheduledDate(e.target.value)}
                      onBlur={() => handleScheduledSave(todo.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setEditingScheduledId(null) }
                      }}
                      className="mt-0.5 text-xs text-kk-ink bg-kk-soft rounded px-2 py-0.5 outline-none"
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                    />
                  ) : todo.scheduled_for ? (
                    <button
                      onClick={() => startScheduledEdit(todo)}
                      className="mt-0.5 text-[10px] text-kk-muted hover:text-kk-ink transition-colors text-left"
                      title="Edit scheduled date"
                    >
                      📅 {new Date(todo.scheduled_for).toLocaleDateString('en-GB', {
                        timeZone: 'Europe/Copenhagen',
                        day: 'numeric', month: 'short',
                      })}
                    </button>
                  ) : (
                    <button
                      onClick={() => startScheduledEdit(todo)}
                      className="mt-0.5 text-[10px] text-kk-muted opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                      title="Set scheduled date"
                    >
                      + date
                    </button>
                  )
                )}

                {/* Recurrence row — editable */}
                {editingRepeatId === todo.id ? (
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <select
                      value={editRepeatRule}
                      onChange={e => setEditRepeatRule(e.target.value)}
                      className="text-xs text-kk-ink bg-kk-soft rounded px-2 py-0.5 outline-none cursor-pointer"
                      autoFocus
                    >
                      {REPEAT_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {editRepeatRule === 'monthly' && (
                      <select
                        value={editRepeatDay}
                        onChange={e => setEditRepeatDay(Number(e.target.value))}
                        className="text-xs text-kk-ink bg-kk-soft rounded px-2 py-0.5 outline-none cursor-pointer"
                        aria-label="Day of month"
                      >
                        <option value={1}>First day</option>
                        <option value={31}>Last day</option>
                      </select>
                    )}
                    <button
                      onClick={() => handleRepeatSave(todo.id)}
                      className="text-xs px-2 py-0.5 bg-kk-ink text-white rounded transition-opacity hover:opacity-80"
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => setEditingRepeatId(null)}
                      className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                    >
                      ×
                    </button>
                  </div>
                ) : todo.recurrence_rule ? (
                  <button
                    onClick={() => startRepeatEdit(todo)}
                    className="mt-0.5 text-[10px] text-kk-brand/60 hover:text-kk-brand transition-colors text-left"
                    title="Edit recurrence"
                  >
                    ↻ {formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day)}
                  </button>
                ) : (
                  <button
                    onClick={() => startRepeatEdit(todo)}
                    className="mt-0.5 text-[10px] text-kk-muted opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                    title="Set recurrence"
                  >
                    ↻ repeat
                  </button>
                )}

                {/* Inline note */}
                {editingNoteId === todo.id ? (
                  <textarea
                    value={editingNoteText}
                    onChange={e => setEditingNoteText(e.target.value)}
                    onBlur={() => handleNoteSave(todo.id)}
                    onKeyDown={e => { if (e.key === 'Escape') { setEditingNoteId(null) } }}
                    rows={2}
                    className="mt-1 w-full text-xs text-kk-ink bg-kk-soft rounded px-2 py-1 outline-none resize-none"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                  />
                ) : todo.notes ? (
                  <p
                    className="mt-0.5 text-xs text-kk-muted truncate cursor-text hover:text-kk-ink transition-colors"
                    onClick={() => startNoteEdit(todo.id, todo.notes)}
                    title="Click to edit note"
                  >
                    {todo.notes}
                  </p>
                ) : (
                  <button
                    className="mt-0.5 text-[10px] text-kk-muted opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                    onClick={() => startNoteEdit(todo.id, null)}
                  >
                    + note
                  </button>
                )}
              </div>

              {/* Right meta */}
              <div className="flex items-center gap-2 shrink-0 mt-0.5">
                <span className="text-[10px] text-kk-muted">
                  {PRIORITY_CONFIG[todo.priority]?.label}
                </span>
                <button
                  onClick={() => handleAction(() => cancelTodo(todo.id))}
                  disabled={isPending}
                  className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 hover:text-kk-bad transition-all disabled:opacity-0"
                  title="Cancel"
                  aria-label="Cancel"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        ))}
      </Section>

      {/* ── Completed todos ──────────────────────────────────────────────────── */}
      {completedTodos.length > 0 && (
        <Section title="Completed" count={completedTodos.length}>
          {completedTodos.map(todo => (
            <div key={todo.id} className="px-5 py-3 group opacity-70">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-4 h-4 rounded border border-kk-good bg-kk-good-bg shrink-0 flex items-center justify-center">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-kk-good" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-kk-muted line-through truncate">{todo.title}</span>
                    {todo.recurrence_rule && (
                      <span className="text-[10px] text-kk-muted shrink-0">
                        ↻ {formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day)}
                      </span>
                    )}
                  </div>
                  {todo.notes && (
                    <p className="mt-0.5 text-xs text-kk-muted/70 truncate">{todo.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 mt-0.5">
                  {todo.completed_at && (
                    <span className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 transition-opacity">
                      {new Date(todo.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  )}
                  <button
                    onClick={() => handleAction(() => reopenTodo(todo.id))}
                    disabled={isPending}
                    className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 hover:text-kk-ink transition-all disabled:opacity-0"
                    title="Reopen"
                  >
                    ↩
                  </button>
                </div>
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* ── Cancelled todos ──────────────────────────────────────────────────── */}
      {cancelledTodos.length > 0 && (
        <Section title="Cancelled" count={cancelledTodos.length}>
          {cancelledTodos.map(todo => (
            <div key={todo.id} className="flex items-center gap-3 px-5 py-3 group opacity-50">
              <div className="w-4 h-4 rounded border border-kk-line shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-kk-muted line-through truncate block">{todo.title}</span>
                {todo.notes && (
                  <p className="mt-0.5 text-xs text-kk-muted/60 truncate">{todo.notes}</p>
                )}
              </div>
              {todo.cancelled_at && (
                <span className="text-xs text-kk-muted shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
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
        <div className="px-5 py-3 text-sm text-kk-muted">{emptyText}</div>
      ) : (
        <div className="divide-y divide-kk-line">{children}</div>
      )}
    </div>
  )
}
