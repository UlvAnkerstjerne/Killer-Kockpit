'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateProject } from '@/lib/actions/projects'
import { canEditProject } from '@/lib/permissions'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
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

function ProjectRow({
  project,
  canEdit,
  allUsers,
}: {
  project: ProjectRow
  canEdit: boolean
  allUsers: UserOption[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner
  const isOverdue =
    !!project.due_date &&
    new Date(project.due_date) < new Date() &&
    project.status !== 'completed'

  async function handleFieldSave(field: 'owner_user_id' | 'due_date', value: string | null) {
    setSaving(true)
    setSaveError(null)
    const result = await updateProject(project.id, { [field]: value || undefined })
    setSaving(false)
    if (result.error) {
      setSaveError(result.error)
    } else {
      router.refresh()
    }
  }

  const editCtrlCls =
    'text-xs bg-transparent rounded px-1.5 py-0.5 outline-none cursor-pointer border border-transparent hover:border-kk-line hover:bg-kk-soft transition-all disabled:opacity-50 -ml-1.5'

  return (
    <div
      className="flex items-center gap-4 px-5 py-4 hover:bg-kk-soft transition-colors first:rounded-t-2xl last:rounded-b-2xl group cursor-pointer"
      onClick={() => router.push(`/projects/${project.id}`)}
    >
      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${project.id}`}
            onClick={e => e.stopPropagation()}
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
              disabled={saving}
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
              disabled={saving}
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

          {saving && (
            <span className="text-[10px] text-kk-muted px-1">Saving…</span>
          )}
        </div>

        {saveError && (
          <p className="text-[10px] text-kk-bad mt-0.5 px-1.5">{saveError}</p>
        )}
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
  if (projects.length === 0) return null

  return (
    <div className="divide-y divide-kk-line">
      {projects.map(project => {
        const canEdit = canEditProject(currentUser.role, project.owner_user_id, currentUser.id)
        return (
          <ProjectRow
            key={project.id}
            project={project}
            canEdit={canEdit}
            allUsers={allUsers}
          />
        )
      })}
    </div>
  )
}
