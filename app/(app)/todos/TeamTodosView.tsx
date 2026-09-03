'use client'

/**
 * TeamTodosView — team-wide operational visibility into to-dos.
 *
 * Purpose: let management see what the team is working on and what has
 * moved recently, without having to ask anyone for updates.
 *
 * This view is intentionally read-only. Seeing a team member's to-do
 * does not grant authority to modify it. Mutations (complete, cancel, reopen)
 * remain strictly owner-only — enforced independently by RLS and server actions.
 *
 * Deliberately absent: rankings, completion rates, performance scores,
 * per-person counts designed as measurement, or any comparison metric.
 */

import { useState } from 'react'
import { PriorityDot } from '@/components/ui/PriorityDot'
import type { TeamTodo } from '@/lib/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPLETED_WINDOW_DAYS = 14

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface User {
  id: string
  display_name: string
}

interface Props {
  todos: TeamTodo[]
  users: User[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstName(displayName: string): string {
  return displayName.split(' ')[0]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TeamTodosView({ todos, users }: Props) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [showOlderCompleted, setShowOlderCompleted] = useState(false)

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - COMPLETED_WINDOW_DAYS)

  // Filter by selected person
  const filtered = selectedUserId
    ? todos.filter(t => t.user_id === selectedUserId)
    : todos

  // Partition: open vs completed (cancelled excluded at query level)
  const openTodos = filtered.filter(t => !t.completed_at)
  const allCompleted = [...filtered.filter(t => !!t.completed_at)].sort(
    (a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime()
  )

  const recentCompleted = allCompleted.filter(t => new Date(t.completed_at!) >= cutoff)
  const olderCompleted  = allCompleted.filter(t => new Date(t.completed_at!) < cutoff)
  const visibleCompleted = showOlderCompleted ? allCompleted : recentCompleted

  // All management users are always shown in the filter bar,
  // even if someone currently has zero todos — zero work is useful signal.
  const usersWithTodos: User[] = users

  // Label for empty open section
  const selectedName = selectedUserId
    ? firstName(users.find(u => u.id === selectedUserId)?.display_name ?? '')
    : ''

  return (
    <div className="space-y-4">

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      {usersWithTodos.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <FilterPill active={selectedUserId === null} onClick={() => setSelectedUserId(null)}>
            All
          </FilterPill>
          {usersWithTodos.map(u => (
            <FilterPill
              key={u.id}
              active={selectedUserId === u.id}
              onClick={() => setSelectedUserId(selectedUserId === u.id ? null : u.id)}
            >
              {firstName(u.display_name)}
            </FilterPill>
          ))}
        </div>
      )}

      {/* ── Open todos (primary) ────────────────────────────────────────────── */}
      <Section
        title="Open"
        count={openTodos.length}
        emptyText={selectedUserId
          ? `No open to-dos for ${selectedName || 'this person'}.`
          : 'No open team to-dos.'
        }
      >
        {openTodos.map(todo => (
          <div key={todo.id} className="flex items-center gap-3 px-5 py-2.5">
            <PriorityDot priority={todo.priority} />
            <span className="flex-1 text-sm font-semibold text-kk-ink truncate">
              {todo.title}
            </span>
            {/* Owner — hidden when filtered to single person (redundant) */}
            {!selectedUserId && (
              <span className="text-xs text-kk-muted shrink-0">
                {firstName(todo.owner.display_name)}
              </span>
            )}
          </div>
        ))}
      </Section>

      {/* ── Done (secondary, quieter) ───────────────────────────────────────── */}
      {allCompleted.length > 0 && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          {/* Section header */}
          <div className="px-5 py-4 border-b border-kk-line">
            <h2 className="text-sm font-semibold text-kk-ink">
              Done
              {visibleCompleted.length > 0 && (
                <span className="text-kk-muted font-normal ml-1">
                  · {showOlderCompleted ? 'all' : `last ${COMPLETED_WINDOW_DAYS} days`}
                  {' '}· {visibleCompleted.length}
                </span>
              )}
            </h2>
          </div>

          <div className="divide-y divide-kk-line">
            {/* No recent completions but older exist */}
            {visibleCompleted.length === 0 && !showOlderCompleted && (
              <div className="px-5 py-4 text-sm text-kk-muted">
                No completions in the last {COMPLETED_WINDOW_DAYS} days.{' '}
                <button
                  onClick={() => setShowOlderCompleted(true)}
                  className="underline hover:text-kk-ink transition-colors"
                >
                  Show older
                </button>
              </div>
            )}

            {/* Completed rows */}
            {visibleCompleted.map(todo => (
              <div
                key={todo.id}
                className="flex items-center gap-3 px-5 py-2.5 opacity-55"
              >
                {/* Completed indicator */}
                <div className="w-4 h-4 rounded border border-kk-good bg-kk-good-bg shrink-0 flex items-center justify-center">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path
                      d="M1.5 5L4 7.5L8.5 2.5"
                      stroke="#2f6d4c"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>

                <span className="flex-1 text-sm text-kk-muted line-through truncate">
                  {todo.title}
                </span>

                {/* Right-side meta: owner + date */}
                <div className="flex items-center gap-2 shrink-0 text-xs text-kk-muted">
                  {!selectedUserId && (
                    <span>{firstName(todo.owner.display_name)}</span>
                  )}
                  {todo.completed_at && (
                    <span>
                      {new Date(todo.completed_at).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  )}
                </div>
              </div>
            ))}

            {/* Expand / collapse older */}
            {!showOlderCompleted && olderCompleted.length > 0 && (
              <div className="px-5 py-3">
                <button
                  onClick={() => setShowOlderCompleted(true)}
                  className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                >
                  Show {olderCompleted.length} older →
                </button>
              </div>
            )}
            {showOlderCompleted && olderCompleted.length > 0 && (
              <div className="px-5 py-3">
                <button
                  onClick={() => setShowOlderCompleted(false)}
                  className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                >
                  ↑ Show recent only
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'text-xs px-3 py-1.5 rounded-lg transition-colors',
        active
          ? 'bg-kk-ink text-white font-medium'
          : 'text-kk-muted hover:text-kk-ink hover:bg-kk-soft',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

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
