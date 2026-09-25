'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateTask, binTask } from '@/lib/actions/tasks'
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

function TaskBinButton({ taskId }: { taskId: string }) {
  const [isPending, startTransition] = useTransition()
  const [confirm, setConfirm] = useState(false)

  return (
    <button
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!confirm) {
          setConfirm(true)
          setTimeout(() => setConfirm(false), 2500)
          return
        }
        startTransition(async () => { await binTask(taskId) })
      }}
      disabled={isPending}
      className={[
        'w-5 h-5 flex items-center justify-center shrink-0 transition-colors',
        confirm ? 'text-kk-bad' : 'text-kraft-dark hover:text-kraft-light',
      ].join(' ')}
      title={confirm ? 'Click again to bin' : 'Bin task'}
    >
      <svg width="18" height="20" viewBox="0 0 12 13" fill="none">
        <path d="M1.5 3.5h9M4.5 3.5V2.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M3 3.5l.5 7.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-7.5M5 6v3.5M7 6v3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
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
    'text-xs bg-kraft-bg/50 rounded-full px-2.5 py-1 outline-none cursor-pointer border border-kraft-dark/30 hover:border-[#171717]/50 hover:bg-kraft-bg transition-all disabled:opacity-50'

  return (
    <div
      className="border-2 border-[#171717] rounded-lg overflow-hidden group cursor-pointer [box-shadow:3px_3px_0_#555555]"
      onClick={() => { saveScroll(); router.push(`/tasks/${task.id}?returnTo=/tasks`) }}
    >
      {/* Header — black with kraft title */}
      <div className="bg-[#171717] px-4 py-2.5 flex items-center gap-2">
        <div className="shrink-0">
          <PriorityDot priority={task.priority} />
        </div>
        <Link
          href={`/tasks/${task.id}?returnTo=/tasks`}
          onClick={e => { e.stopPropagation(); saveScroll() }}
          className={[
            'text-base font-semibold group-hover:underline flex-1 min-w-0 truncate',
            done ? 'line-through text-kraft-dark' : 'text-kraft-light',
          ].join(' ')}
        >
          {task.title}
        </Link>
        <TaskStatusBadge status={task.status as TaskStatus} />
        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
          <TaskBinButton taskId={task.id} />
        </div>
      </div>

      {/* Sub — kraft with pills */}
      <div className="bg-kraft-light px-4 py-2.5">
        <div className="flex items-center gap-1.5 flex-wrap">
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
              className={`${editCtrlCls} text-kk-ink`}
              title="Change owner"
            >
              <option value="">Unassigned</option>
              {allUsers.map(u => (
                <option key={u.id} value={u.id}>{u.display_name}</option>
              ))}
            </select>
          ) : (
            owner && (
              <span className="text-xs text-kk-ink bg-kraft-bg/50 border border-kraft-dark/30 rounded-full px-2.5 py-1">{owner.display_name}</span>
            )
          )}

          {/* Project */}
          {showProject && project && (
            <span className="text-xs text-kk-muted bg-kraft-bg/50 border border-kraft-dark/30 rounded-full px-2.5 py-1">{project.title}</span>
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
              <span className={`${deadlineCls} bg-kraft-bg/50 border border-kraft-dark/30 rounded-full px-2.5 py-1`}>
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
    <div className="space-y-2 max-w-lg">
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
