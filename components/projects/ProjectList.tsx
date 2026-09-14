'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateProject, closeProject } from '@/lib/actions/projects'
import { canEditProject, canArchiveProject } from '@/lib/permissions'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { useSaveState } from '@/lib/hooks/useSaveState'
import { SaveStatusIndicator } from '@/components/ui/SaveStatusIndicator'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import type { AppUser, ProjectStatus } from '@/lib/types'

type UserOption = { id: string; display_name: string; email: string }

type ProjectRow = {
  id: string
  title: string
  status: string
  due_date: string | null
  progress: number | null
  owner_user_id: string | null
  owner?: UserOption | UserOption[]
}

// ---------------------------------------------------------------------------
// ProjectRow — isolated per-row state for inline field editing
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(['planned', 'active', 'at_risk', 'blocked'])

function ProjectRow({
  project,
  canEdit,
  canComplete,
  allUsers,
  saveScroll,
}: {
  project: ProjectRow
  canEdit: boolean
  canComplete: boolean
  allUsers: UserOption[]
  saveScroll: () => void
}) {
  const router = useRouter()
  const fieldSave = useSaveState()
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [closing, setClosing] = useState(false)

  const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner
  const isOverdue =
    !!project.due_date &&
    new Date(project.due_date) < new Date() &&
    project.status !== 'completed'

  async function handleClose() {
    setClosing(true)
    const result = await closeProject(project.id)
    setClosing(false)
    setConfirmingClose(false)
    if (result.error) {
      fieldSave.fail(result.error)
    } else {
      router.refresh()
    }
  }

  async function handleFieldSave(field: 'owner_user_id' | 'due_date', value: string | null) {
    fieldSave.start()
    const result = await updateProject(project.id, { [field]: value || undefined })
    if (result.error) {
      fieldSave.fail(result.error)
    } else {
      fieldSave.ok()
      router.refresh()
    }
  }

  const editCtrlCls =
    'text-xs bg-transparent rounded px-1.5 py-0.5 outline-none cursor-pointer border border-transparent hover:border-kk-line hover:bg-kk-soft transition-all disabled:opacity-50 -ml-1.5'

  return (
    <div
      className="flex items-center gap-4 px-5 py-4 hover:bg-kk-soft transition-colors first:rounded-t-2xl last:rounded-b-2xl group cursor-pointer"
      onClick={() => { saveScroll(); router.push(`/projects/${project.id}`) }}
    >
      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${project.id}`}
            onClick={e => { e.stopPropagation(); saveScroll() }}
            className="font-medium text-sm text-kk-ink group-hover:underline truncate"
          >
            {project.title}
          </Link>
          <ProjectStatusBadge status={project.status as ProjectStatus} />
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {/* Owner */}
          {canEdit ? (
            <select
              value={project.owner_user_id ?? ''}
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

          {/* Due date */}
          {canEdit ? (
            <input
              type="date"
              value={project.due_date ?? ''}
              onChange={async e => {
                e.stopPropagation()
                await handleFieldSave('due_date', e.target.value || null)
              }}
              onClick={e => e.stopPropagation()}
              disabled={fieldSave.status === 'saving'}
              className={[
                editCtrlCls,
                'font-medium',
                isOverdue ? 'text-kk-bad' : 'text-kk-muted',
              ].join(' ')}
              title="Change target date"
            />
          ) : (
            project.due_date && (
              <span className={`text-xs px-1.5 py-0.5 ${isOverdue ? 'text-kk-bad font-medium' : 'text-kk-muted'}`}>
                {isOverdue ? 'Overdue · ' : 'Due '}
                {new Date(project.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            )
          )}

          <span className="px-1">
            <SaveStatusIndicator status={fieldSave.status} errorMsg={fieldSave.errorMsg} />
          </span>
        </div>
      </div>

      {/* Progress bar */}
      {project.progress !== null && (
        <div className="w-24 shrink-0" onClick={e => e.stopPropagation()}>
          <div className="flex justify-end mb-1">
            <span className="text-xs text-kk-muted">{project.progress}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${project.progress}%` }} />
          </div>
        </div>
      )}

      {/* Complete button — only for active projects the user can close */}
      {canComplete && (
        <div
          className="shrink-0 flex items-center gap-1.5"
          onClick={e => e.stopPropagation()}
        >
          {confirmingClose ? (
            <>
              <span className="text-xs text-kk-muted">Complete?</span>
              <button
                onClick={handleClose}
                disabled={closing}
                className="text-xs px-2.5 py-1 rounded-lg border border-kk-good text-kk-good hover:bg-emerald-50 transition-colors disabled:opacity-40"
              >
                {closing ? '…' : 'Yes'}
              </button>
              <button
                onClick={() => setConfirmingClose(false)}
                disabled={closing}
                className="text-xs px-2.5 py-1 rounded-lg border border-kk-line text-kk-muted hover:bg-kk-soft transition-colors disabled:opacity-40"
              >
                No
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmingClose(true)}
              className="text-xs px-2.5 py-1 rounded-lg border border-kk-line text-kk-muted opacity-0 group-hover:opacity-100 hover:border-kk-good hover:text-kk-good hover:bg-emerald-50 transition-all"
            >
              Complete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectList
// ---------------------------------------------------------------------------

export default function ProjectList({
  projects,
  currentUser,
  allUsers,
}: {
  projects: ProjectRow[]
  currentUser: AppUser
  allUsers: UserOption[]
}) {
  const { saveScroll } = useScrollRestoration('projects-list')

  if (projects.length === 0) return null

  return (
    <div className="divide-y divide-kk-line">
      {projects.map(project => {
        const canEdit = canEditProject(currentUser.role, project.owner_user_id, currentUser.id)
        const canComplete =
          ACTIVE_STATUSES.has(project.status) &&
          canArchiveProject(currentUser.role, project.owner_user_id, currentUser.id)
        return (
          <ProjectRow
            key={project.id}
            project={project}
            canEdit={canEdit}
            canComplete={canComplete}
            allUsers={allUsers}
            saveScroll={saveScroll}
          />
        )
      })}
    </div>
  )
}
