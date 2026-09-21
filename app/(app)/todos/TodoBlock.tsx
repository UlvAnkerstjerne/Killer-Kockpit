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

import { useState, useRef, useTransition, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SmartMouseSensor, SmartTouchSensor } from '@/lib/dnd/sensors'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { createTodo, completeTodo, completeRecurringTodo, cancelTodo, reopenTodo, reorderTodos } from '@/lib/actions/todos'
import type { Todo } from '@/lib/types'
import Link from 'next/link'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'
import { formatRecurrenceBadge } from '@/lib/todos/recurrence'
import UpgradeToTaskModal from './UpgradeToTaskModal'

// ---------------------------------------------------------------------------
// Drag handle icon
// ---------------------------------------------------------------------------

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="2.5" r="1.2"/>
      <circle cx="7" cy="2.5" r="1.2"/>
      <circle cx="3" cy="7" r="1.2"/>
      <circle cx="7" cy="7" r="1.2"/>
      <circle cx="3" cy="11.5" r="1.2"/>
      <circle cx="7" cy="11.5" r="1.2"/>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type UserOption    = { id: string; display_name: string; email: string }
type ProjectOption = { id: string; title: string }

interface Props {
  openTodos: Todo[]
  completedThisWeek: Todo[]
  maxItems?: number        // if set, cap visible open todos (badge still shows full count)
  showFooter?: boolean     // if true, render a footer link instead of the header "All →" link
  accentHeader?: boolean   // if true, apply warm-grey header (Today page)
  // Upgrade-to-task: when provided, shows "→ Task" action on each open todo row
  allUsers?: UserOption[]
  projects?: ProjectOption[]
  currentUserId?: string
}

// ---------------------------------------------------------------------------
// SortableOpenTodo — one draggable open todo row
// ---------------------------------------------------------------------------

interface SortableOpenTodoProps {
  todo: Todo
  isPending: boolean
  completionLoading: boolean
  completingTodoId: string | null
  completionContextText: string
  completionError: string | null
  canUpgrade: boolean
  onComplete: () => void
  onCancel: () => void
  onUpgrade: () => void
  onContextChange: (text: string) => void
  onContextConfirm: () => void
  onContextCancel: () => void
}

function SortableOpenTodo({
  todo,
  isPending,
  completionLoading,
  completingTodoId,
  completionContextText,
  completionError,
  canUpgrade,
  onComplete,
  onCancel,
  onUpgrade,
  onContextChange,
  onContextConfirm,
  onContextCancel,
}: SortableOpenTodoProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={`group${isDragging ? ' opacity-50 relative z-10 bg-kraft-light ring-1 ring-[#171717]/20' : ''}`}
    >
      <div className="flex items-stretch">
        {/* ── Drag affordance (decorative only — whole row is draggable) ── */}
        <div
          aria-hidden="true"
          className="flex items-center justify-center w-5 shrink-0
                     opacity-20 sm:opacity-0 sm:group-hover:opacity-30
                     text-kk-muted pointer-events-none"
        >
          <GripIcon />
        </div>

        {/* ── Row content ───────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 pr-4 py-1.5">
          <div className="flex items-center gap-3">
            {/* Complete button */}
            <button
              onClick={onComplete}
              disabled={isPending || completionLoading}
              className="w-4 h-4 rounded border border-kk-line hover:border-kk-good hover:bg-kk-good-bg transition-colors shrink-0 disabled:opacity-40 flex items-center justify-center"
              title="Mark complete"
              aria-label="Mark complete"
            />

            {/* Title + recurrence indicator */}
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <PriorityDot priority={todo.priority} />
              <span className="text-sm font-semibold text-kk-ink truncate">{todo.title}</span>
              {todo.recurrence_rule && (
                <span className="text-[10px] text-kk-brand/60 shrink-0">
                  ↻ {formatRecurrenceBadge(todo.recurrence_rule, todo.recurrence_day)}
                </span>
              )}
            </div>

            {/* Priority label */}
            <span className="text-[10px] text-kk-muted shrink-0">
              {PRIORITY_CONFIG[todo.priority]?.label}
            </span>

            {/* Upgrade to Task — visible on hover */}
            {canUpgrade && (
              <button
                onClick={onUpgrade}
                disabled={isPending || completionLoading}
                className="text-[10px] text-kk-muted sm:opacity-0 sm:group-hover:opacity-100 hover:text-kk-ink transition-all disabled:opacity-0 shrink-0 font-medium"
                title="Upgrade to Task"
                aria-label="Upgrade to Task"
              >
                → Task
              </button>
            )}

            {/* Cancel button — visible on hover */}
            <button
              onClick={onCancel}
              disabled={isPending}
              className="text-xs text-kk-muted opacity-0 group-hover:opacity-100 hover:text-kk-bad transition-all disabled:opacity-0 shrink-0"
              title="Cancel"
              aria-label="Cancel"
            >
              ×
            </button>
          </div>

          {/* Completion context box */}
          {completingTodoId === todo.id && (
            <div className="mt-2 pt-2 border-t border-[#171717]/20 space-y-1.5">
              <div>
                <p className="text-xs font-semibold text-kk-ink">Add context</p>
                <p className="text-[10px] text-kk-muted">What happened / what was the outcome?</p>
              </div>
              <textarea
                value={completionContextText}
                onChange={e => onContextChange(e.target.value)}
                rows={2}
                placeholder="e.g. Confirmed with the team, all done."
                className="w-full text-xs text-kk-ink bg-kk-soft rounded-lg px-3 py-1.5 outline-none resize-none placeholder:text-kk-muted"
                disabled={completionLoading}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    onContextConfirm()
                  }
                  if (e.key === 'Escape') onContextCancel()
                }}
              />
              {completionError && (
                <p className="text-xs text-kk-bad">{completionError}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onContextConfirm}
                  disabled={!completionContextText.trim() || completionLoading}
                  className="text-xs px-3 py-1 bg-kk-ink text-white rounded-lg disabled:opacity-30 hover:opacity-80 transition-opacity"
                >
                  {completionLoading ? 'Saving…' : 'Done'}
                </button>
                <button
                  type="button"
                  onClick={onContextCancel}
                  disabled={completionLoading}
                  className="text-xs px-3 py-1 border border-[#171717]/30 text-kk-muted rounded-lg hover:bg-[#B7A486]/20 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TodoBlock({
  openTodos, completedThisWeek, maxItems, showFooter, accentHeader,
  allUsers, projects, currentUserId,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<1 | 2 | 3 | 4>(2)
  const [createError, setCreateError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Completion context box
  const [completingTodoId,      setCompletingTodoId]      = useState<string | null>(null)
  const [completionContextText, setCompletionContextText] = useState('')
  const [completionLoading,     setCompletionLoading]     = useState(false)
  const [completionError,       setCompletionError]       = useState<string | null>(null)

  // Upgrade to task modal
  const [upgradingTodo, setUpgradingTodo] = useState<Todo | null>(null)
  const canUpgrade = !!(allUsers && projects !== undefined && currentUserId)

  // ── Drag-and-drop ordering ─────────────────────────────────────────────
  // localOpenTodos mirrors openTodos prop and supports optimistic DnD reorder.
  const [localOpenTodos, setLocalOpenTodos] = useState<Todo[]>(openTodos)
  // Sync with server when props change (after router.refresh())
  useEffect(() => { setLocalOpenTodos(openTodos) }, [openTodos])

  const sensors = useSensors(
    useSensor(SmartMouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(SmartTouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = localOpenTodos.findIndex(t => t.id === active.id)
    const newIndex = localOpenTodos.findIndex(t => t.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(localOpenTodos, oldIndex, newIndex)
    setLocalOpenTodos(reordered)

    // Persist asynchronously — no await, fire-and-forget from UI perspective
    startTransition(async () => {
      await reorderTodos(reordered.map(t => t.id))
    })
  }, [localOpenTodos, startTransition])

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

  function openCompletionBox(todo: Todo) {
    setCompletingTodoId(todo.id)
    setCompletionContextText('')
    setCompletionError(null)
  }

  async function handleCompleteConfirm(todoId: string, isRecurring: boolean) {
    if (!completionContextText.trim() || completionLoading) return
    setCompletionError(null)
    setCompletionLoading(true)
    const result = await (isRecurring
      ? completeRecurringTodo(todoId, completionContextText)
      : completeTodo(todoId, completionContextText))
    if (result.error) {
      setCompletionError(result.error)
      setCompletionLoading(false)
      return
    }
    setCompletingTodoId(null)
    setCompletionLoading(false)
    startTransition(() => router.refresh())
  }

  return (
    <div className="bg-kraft-light border border-[#171717] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-[#171717] flex items-center justify-between bg-kraft-brown">
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
      <form onSubmit={handleCreate} className="px-4 py-2 border-b border-[#171717] flex items-center gap-2">
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
          className="text-xs text-kk-muted bg-transparent border border-[#171717]/30 rounded-lg px-2 py-1 outline-none cursor-pointer hover:border-kk-ink transition-colors shrink-0"
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
      {localOpenTodos.length === 0 && completedThisWeek.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-kk-muted">
          No to-dos. Add one above.
        </div>
      ) : (
        <div className="divide-y divide-[#171717]/15">
          {/* ── Sortable open todos ─────────────────────────────────────────── */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext
              items={(maxItems ? localOpenTodos.slice(0, maxItems) : localOpenTodos).map(t => t.id)}
              strategy={verticalListSortingStrategy}
            >
              {(maxItems ? localOpenTodos.slice(0, maxItems) : localOpenTodos).map(todo => (
                <SortableOpenTodo
                  key={todo.id}
                  todo={todo}
                  isPending={isPending}
                  completionLoading={completionLoading}
                  completingTodoId={completingTodoId}
                  completionContextText={completionContextText}
                  completionError={completionError}
                  canUpgrade={canUpgrade}
                  onComplete={() => openCompletionBox(todo)}
                  onCancel={() => handleAction(() => cancelTodo(todo.id))}
                  onUpgrade={() => setUpgradingTodo(todo)}
                  onContextChange={setCompletionContextText}
                  onContextConfirm={() => handleCompleteConfirm(todo.id, !!todo.recurrence_rule)}
                  onContextCancel={() => setCompletingTodoId(null)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Completed this week */}
          {completedThisWeek.length > 0 && (
            <>
              <div className="px-5 py-2 bg-kraft-brown/40">
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
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-kk-muted line-through truncate block">{todo.title}</span>
                    {todo.completion_context && (
                      <p className="text-[10px] text-kk-good/80 truncate mt-0.5">✓ {todo.completion_context}</p>
                    )}
                  </div>
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
        <div className="px-5 py-2 border-t border-[#171717]/20 text-xs text-kk-bad">{actionError}</div>
      )}

      {showFooter && (
        <div className="px-4 py-1.5 border-t border-[#171717]/20 flex justify-end">
          <Link href="/todos" className="text-xs text-kk-brand font-medium hover:opacity-70 transition-opacity">
            View all to-dos →
          </Link>
        </div>
      )}

      {/* Upgrade-to-Task modal — rendered outside the card scroll context */}
      {upgradingTodo && canUpgrade && (
        <UpgradeToTaskModal
          todo={upgradingTodo}
          allUsers={allUsers!}
          projects={projects!}
          currentUserId={currentUserId!}
          onClose={() => setUpgradingTodo(null)}
          onSuccess={() => {
            setUpgradingTodo(null)
            startTransition(() => router.refresh())
          }}
        />
      )}
    </div>
  )
}
