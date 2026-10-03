'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { reopenTodo } from '@/lib/actions/todos'

type CompletedTodoItem = {
  id: string
  title: string
  completed_at: string
  completion_context: string | null
  notes: string | null
  upgraded_to_task_id: string | null
}

/**
 * Returns the Monday 00:00 and Sunday 23:59:59.999 for the week containing
 * the given date, in Europe/Copenhagen time.
 */
function getWeekBounds(date: Date): { start: Date; end: Date; label: string } {
  // Format to Copenhagen date parts
  const cph = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
  })
  const parts = cph.formatToParts(date)
  const year = Number(parts.find(p => p.type === 'year')!.value)
  const month = Number(parts.find(p => p.type === 'month')!.value) - 1
  const day = Number(parts.find(p => p.type === 'day')!.value)

  // JS getDay: 0=Sun…6=Sat. We want Monday=0.
  const local = new Date(year, month, day)
  const jsDay = local.getDay()
  const mondayOffset = jsDay === 0 ? -6 : 1 - jsDay
  const monday = new Date(year, month, day + mondayOffset)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)

  const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
  const label = `${fmt.format(monday)} – ${fmt.format(sunday)} ${sunday.getFullYear()}`

  return {
    start: monday,
    end: new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 23, 59, 59, 999),
    label,
  }
}

function shiftWeek(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta * 7)
}

function formatCompletionDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    timeZone: 'Europe/Copenhagen',
  })
}

export default function CompletedTodosSection({
  todos,
}: {
  todos: CompletedTodoItem[]
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [isOpen, setIsOpen] = useState(false)
  const [weekAnchor, setWeekAnchor] = useState(() => new Date())
  const [reopeningId, setReopeningId] = useState<string | null>(null)

  const week = useMemo(() => getWeekBounds(weekAnchor), [weekAnchor])

  const weekTodos = useMemo(() => {
    return todos.filter(t => {
      const d = new Date(t.completed_at)
      return d >= week.start && d <= week.end
    })
  }, [todos, week])

  // Check if there are any todos before the current week (for "Previous" button)
  const hasOlderTodos = useMemo(() => {
    return todos.some(t => new Date(t.completed_at) < week.start)
  }, [todos, week])

  // Check if week is current week or future (disable "Next" if so)
  const isCurrentOrFuture = useMemo(() => {
    const now = getWeekBounds(new Date())
    return week.start >= now.start
  }, [week])

  async function handleReopen(todoId: string) {
    if (reopeningId) return
    setReopeningId(todoId)
    await reopenTodo(todoId)
    setReopeningId(null)
    startTransition(() => router.refresh())
  }

  if (todos.length === 0) return null

  return (
    <div className="mt-6">
      <button
        onClick={() => setIsOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-kraft-dark hover:text-kraft-light transition-colors"
      >
        <span className="text-[10px]">{isOpen ? '▾' : '▸'}</span>
        <span className="font-bold uppercase tracking-wide">Completed</span>
        <span className="opacity-60">· {todos.length}</span>
      </button>

      {isOpen && (
        <div className="mt-3">
          {/* Week navigation */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => setWeekAnchor(d => shiftWeek(d, -1))}
              disabled={!hasOlderTodos}
              className="text-xs px-2.5 py-1 bg-kraft-light/20 text-kraft-light border border-kraft-dark/30 rounded-lg disabled:opacity-30 hover:bg-kraft-light/30 transition-colors"
            >
              ‹ Previous
            </button>
            <span className="text-xs text-kraft-light font-medium flex-1 text-center">
              {week.label}
            </span>
            <button
              onClick={() => setWeekAnchor(d => shiftWeek(d, 1))}
              disabled={isCurrentOrFuture}
              className="text-xs px-2.5 py-1 bg-kraft-light/20 text-kraft-light border border-kraft-dark/30 rounded-lg disabled:opacity-30 hover:bg-kraft-light/30 transition-colors"
            >
              Next ›
            </button>
          </div>

          {/* Items for this week */}
          {weekTodos.length === 0 ? (
            <div className="bg-kraft-light/10 border border-kraft-dark/20 rounded-lg px-4 py-5 text-center">
              <span className="text-xs text-kraft-dark">No completed to-dos this week</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {weekTodos.map(todo => (
                <div
                  key={todo.id}
                  className="bg-kraft-light/60 border border-[#171717]/30 rounded-lg px-3 py-2 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    {/* Checked checkbox — click to restore */}
                    <button
                      onClick={() => handleReopen(todo.id)}
                      disabled={reopeningId === todo.id}
                      className="w-4 h-4 rounded border-2 border-[#171717]/40 bg-[#171717] shrink-0 flex items-center justify-center disabled:opacity-40 hover:border-[#171717] transition-colors"
                      title="Restore to active"
                    >
                      <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M2 5.5L4.5 8L8.5 2.5" stroke="#D2C3A7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                    <span className="text-sm text-kk-muted line-through truncate flex-1 min-w-0">
                      {todo.title}
                    </span>
                    <span className="text-[10px] text-kraft-dark shrink-0">
                      {formatCompletionDate(todo.completed_at)}
                    </span>
                  </div>

                  {/* Context / notes */}
                  {(todo.completion_context || todo.notes) && (
                    <div className="pl-6 space-y-0.5">
                      {todo.completion_context && (
                        <p className="text-xs text-kraft-dark">{todo.completion_context}</p>
                      )}
                      {todo.notes && !todo.completion_context?.includes(todo.notes) && (
                        <p className="text-xs text-kraft-dark/60">{todo.notes}</p>
                      )}
                    </div>
                  )}

                  {/* Linked task */}
                  {todo.upgraded_to_task_id && (
                    <div className="pl-6">
                      <Link
                        href={`/tasks/${todo.upgraded_to_task_id}`}
                        className="text-[10px] text-kraft-light/60 hover:text-kraft-light transition-colors"
                      >
                        → Upgraded to task
                      </Link>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
