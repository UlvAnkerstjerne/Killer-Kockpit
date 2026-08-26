'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { completeTask } from '@/lib/actions/tasks'
import { TaskStatusBadge, PriorityBadge } from '@/components/ui/StatusBadge'
import type { AppUser, TaskStatus } from '@/lib/types'

type TaskRow = {
  id: string
  title: string
  status: string
  priority: number
  due_at: string | null
  completed_at: string | null
  owner_user_id: string | null
  owner?: { id: string; display_name: string; email: string } | Array<{ id: string; display_name: string; email: string }>
  project?: { id: string; title: string } | Array<{ id: string; title: string }>
}

function isDueToday(due_at: string | null): boolean {
  if (!due_at) return false
  const d = new Date(due_at)
  const now = new Date()
  return d.toDateString() === now.toDateString()
}

function isOverdue(due_at: string | null, status: string): boolean {
  if (!due_at || status === 'done' || status === 'cancelled') return false
  return new Date(due_at) < new Date()
}

function TaskCompleteButton({ taskId, status }: { taskId: string; status: string }) {
  const [isPending, startTransition] = useTransition()

  if (status === 'done') {
    return (
      <div className="w-4 h-4 rounded border-2 border-kk-good bg-kk-good flex items-center justify-center shrink-0">
        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
          <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    )
  }

  if (status === 'cancelled') {
    return <div className="w-4 h-4 rounded border-2 border-kk-line shrink-0 opacity-40" />
  }

  return (
    <button
      onClick={(e) => {
        e.preventDefault()
        startTransition(async () => { await completeTask(taskId) })
      }}
      disabled={isPending}
      className="w-4 h-4 rounded border-2 border-kk-line hover:border-kk-ink transition-colors shrink-0 disabled:opacity-40"
      title="Mark as done"
    />
  )
}

export default function TaskList({
  tasks,
  showProject = true,
}: {
  tasks: TaskRow[]
  currentUser?: AppUser
  showProject?: boolean
}) {
  if (tasks.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-sm text-kk-muted">
        No tasks yet.
      </div>
    )
  }

  return (
    <div className="divide-y divide-kk-line">
      {tasks.map((task) => {
        const owner = Array.isArray(task.owner) ? task.owner[0] : task.owner
        const project = Array.isArray(task.project) ? task.project[0] : task.project
        const overdue = isOverdue(task.due_at, task.status)
        const dueToday = isDueToday(task.due_at)
        const done = task.status === 'done' || task.status === 'cancelled'

        return (
          <Link
            key={task.id}
            href={`/tasks/${task.id}`}
            className="flex items-start gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
          >
            <div
              className="mt-0.5"
              onClick={(e) => e.stopPropagation()}
            >
              <TaskCompleteButton taskId={task.id} status={task.status} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-start gap-2 flex-wrap">
                <span className={[
                  'text-sm group-hover:underline',
                  done ? 'line-through text-kk-muted' : 'text-kk-ink font-medium',
                ].join(' ')}>
                  {task.title}
                </span>
                <TaskStatusBadge status={task.status as TaskStatus} />
                {task.priority === 1 && <PriorityBadge priority={1} />}
              </div>

              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {owner && (
                  <span className="text-xs text-kk-muted">{owner.display_name}</span>
                )}
                {showProject && project && (
                  <span className="text-xs text-kk-muted">{project.title}</span>
                )}
                {task.due_at && (
                  <span className={[
                    'text-xs font-medium',
                    overdue ? 'text-kk-bad' : dueToday ? 'text-kk-warn' : 'text-kk-muted',
                  ].join(' ')}>
                    {overdue ? 'Overdue · ' : dueToday ? 'Due today · ' : 'Due '}
                    {new Date(task.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </span>
                )}
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
