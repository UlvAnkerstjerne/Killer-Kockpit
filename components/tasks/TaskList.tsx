'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { completeTask, updateTask } from '@/lib/actions/tasks'
import { canEditTaskTerms } from '@/lib/permissions'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import { TaskStatusBadge } from '@/components/ui/StatusBadge'
import { PriorityDot } from '@/components/ui/PriorityDot'
import { useSaveState } from '@/lib/hooks/useSaveState'
import { SaveStatusIndicator } from '@/components/ui/SaveStatusIndicator'
import type { AppUser, TaskStatus } from '@/lib/types'

type UserOption = { id: string; display_name: string; email: string }

type TaskRow = {
  id: string
  title: string
  status: string
  priority: number
  due_at: string | null
  completed_at: string | null
  owner_user_id: string | null
  created_by_user_id: string | null
  owner?: UserOption | UserOption[]
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
        e.stopPropagation()
        startTransition(async () => { await completeTask(taskId) })
      }}
      disabled={isPending}
      className="w-4 h-4 rounded border-2 border-kk-line hover:border-kk-ink transition-colors shrink-0 disabled:opacity-40"
      title="Mark as done"
    />
  )
}

// ---------------------------------------------------------------------------
// TaskRow — isolated per-row state for inline field editing
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  canEdit,
  allUsers,
  showProject,
  saveScroll,
}: {
  task: TaskRow
  canEdit: boolean
  allUsers: UserOption[]
  showProject: boolean
  saveScroll: () => void
}) {
  const router = useRouter()
  const fieldSave = useSaveState()

  const owner = Array.isArray(task.owner) ? task.owner[0] : task.owner
  const project = Array.isArray(task.project) ? task.project[0] : task.project
  const overdue = isOverdue(task.due_at, task.status)
  const dueToday = isDueToday(task.due_at)
  const done = task.status === 'done' || task.status === 'cancelled'

  async function handleFieldSave(field: 'owner_user_id' | 'due_at', value: string | null) {
    fieldSave.start()
    const result = await updateTask(task.id, { [field]: value || undefined })
    if (result.error) {
      fieldSave.fail(result.error)
    } else {
      fieldSave.ok()
      router.refresh()
    }
  }

  const deadlineCls = [
    'text-xs font-medium',
    overdue ? 'text-kk-bad' : dueToday ? 'text-kk-warn' : 'text-kk-muted',
  ].join(' ')

  const editCtrlCls =
    'text-xs bg-transparent rounded px-1.5 py-0.5 outline-none cursor-pointer border border-transparent hover:border-kk-line hover:bg-kk-soft transition-all disabled:opacity-50 -ml-1.5'

  return (
    <div
      className="flex items-start gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group cursor-pointer"
      onClick={() => { saveScroll(); router.push(`/tasks/${task.id}`) }}
    >
      <div className="mt-1.5 shrink-0">
        <PriorityDot priority={task.priority} />
      </div>

      <div className="mt-0.5 shrink-0" onClick={e => e.stopPropagation()}>
        <TaskCompleteButton taskId={task.id} status={task.status} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          {/* Title — Link for right-click / keyboard nav; row click handles primary nav */}
          <Link
            href={`/tasks/${task.id}`}
            onClick={e => { e.stopPropagation(); saveScroll() }}
            className={[
              'text-sm group-hover:underline',
              done ? 'line-through text-kk-muted' : 'text-kk-ink font-medium',
            ].join(' ')}
          >
            {task.title}
          </Link>
          <TaskStatusBadge status={task.status as TaskStatus} />
        </div>

        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {/* Owner */}
          {canEdit ? (
            <select
              value={task.owner_user_id ?? ''}
              onChange={async e => {
                e.stopPropagation()
                await handleFieldSave('owner_user_id', e.target.value || null)
              }}
              onClick={e => e.stopPropagation()}
              disabled={fieldSave.status === 'saving'}
              className={`${editCtrlCls} text-kk-muted`}
              title="Change owner"
            >
              <option value="">Unassigned</option>
              {allUsers.map(u => (
                <option key={u.id} value={u.id}>{u.display_name}</option>
              ))}
            </select>
          ) : (
            owner && (
              <span className="text-xs text-kk-muted px-1.5 py-0.5">{owner.display_name}</span>
            )
          )}

          {/* Project */}
          {showProject && project && (
            <span className="text-xs text-kk-muted px-1.5 py-0.5">{project.title}</span>
          )}

          {/* Deadline */}
          {canEdit ? (
            <input
              type="date"
              value={task.due_at ? task.due_at.slice(0, 10) : ''}
              onChange={async e => {
                e.stopPropagation()
                await handleFieldSave('due_at', e.target.value || null)
              }}
              onClick={e => e.stopPropagation()}
              disabled={fieldSave.status === 'saving'}
              className={`${editCtrlCls} ${deadlineCls} font-medium`}
              title="Change deadline"
            />
          ) : (
            task.due_at && (
              <span className={`${deadlineCls} px-1.5 py-0.5`}>
                {overdue ? 'Overdue · ' : dueToday ? 'Due today · ' : 'Due '}
                {new Date(task.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            )
          )}

          <span className="px-1">
            <SaveStatusIndicator status={fieldSave.status} errorMsg={fieldSave.errorMsg} />
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TaskList
// ---------------------------------------------------------------------------

export default function TaskList({
  tasks,
  currentUser,
  allUsers = [],
  showProject = true,
}: {
  tasks: TaskRow[]
  currentUser?: AppUser
  allUsers?: UserOption[]
  showProject?: boolean
}) {
  const { saveScroll } = useScrollRestoration('tasks-list')

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
        const canEdit = currentUser
          ? canEditTaskTerms(currentUser.role, task.created_by_user_id, currentUser.id)
          : false

        return (
          <TaskRow
            key={task.id}
            task={task}
            canEdit={canEdit}
            allUsers={allUsers}
            showProject={showProject}
            saveScroll={saveScroll}
          />
        )
      })}
    </div>
  )
}
