'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateWaitingOn } from '@/lib/actions/waiting-ons'
import { canEditWaitingOn } from '@/lib/permissions'
import { WaitingOnStatusBadge } from '@/components/ui/WaitingOnStatusBadge'
import { PriorityDot, PRIORITY_CONFIG } from '@/components/ui/PriorityDot'
import { WaitingOnDoneButton } from '@/app/(app)/waiting-ons/WaitingOnDoneButton'
import type { AppUser, WaitingStatus } from '@/lib/types'

type UserOption = { id: string; display_name: string; email: string }

type WORow = {
  id: string
  title: string
  status: string
  priority: number | null
  due_at: string | null
  owner_user_id: string | null
  waiting_for_name: string | null
  owner?: UserOption | UserOption[]
  waiting_for_user?: UserOption | UserOption[]
  project?: { id: string; title: string } | Array<{ id: string; title: string }>
}

// ---------------------------------------------------------------------------
// WaitingOnRow — isolated per-row state for inline field editing
// ---------------------------------------------------------------------------

function WaitingOnRow({
  wo,
  now,
  canEdit,
  allUsers,
  isManagementView,
}: {
  wo: WORow
  now: string
  canEdit: boolean
  allUsers: UserOption[]
  isManagementView: boolean
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const owner = Array.isArray(wo.owner) ? wo.owner[0] : wo.owner
  const waitingForUser = Array.isArray(wo.waiting_for_user) ? wo.waiting_for_user[0] : wo.waiting_for_user
  const project = Array.isArray(wo.project) ? wo.project[0] : wo.project
  const isOverdue = wo.status === 'open' && !!wo.due_at && wo.due_at < now
  const isActionable = wo.status === 'open' || wo.status === 'overdue'

  async function handleFieldSave(field: 'owner_user_id' | 'due_at', value: string | null) {
    setSaving(true)
    setSaveError(null)
    const result = await updateWaitingOn(wo.id, { [field]: value || undefined })
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
      className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group cursor-pointer"
      onClick={() => router.push(`/waiting-ons/${wo.id}`)}
    >
      <div className="shrink-0" onClick={e => e.stopPropagation()}>
        <PriorityDot priority={wo.priority ?? 2} />
      </div>

      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/waiting-ons/${wo.id}`}
            onClick={e => e.stopPropagation()}
            className="text-sm font-medium text-kk-ink group-hover:underline truncate"
          >
            {wo.title}
          </Link>
          <WaitingOnStatusBadge status={(isOverdue ? 'overdue' : wo.status) as WaitingStatus} />
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {(waitingForUser?.display_name || wo.waiting_for_name) && (
            <span className="text-xs text-kk-muted px-1.5 py-0.5">
              Waiting on: {waitingForUser?.display_name || wo.waiting_for_name}
            </span>
          )}
          {project && (
            <span className="text-xs text-kk-muted px-1.5 py-0.5">· {project.title}</span>
          )}

          {/* Owner — shown in management view; editable select when canEdit */}
          {isManagementView && (
            canEdit ? (
              <select
                value={wo.owner_user_id ?? ''}
                onChange={async e => {
                  e.stopPropagation()
                  await handleFieldSave('owner_user_id', e.target.value || null)
                }}
                onClick={e => e.stopPropagation()}
                disabled={saving}
                className={`${editCtrlCls} text-kk-muted`}
                title="Change responsible person"
              >
                <option value="">Unassigned</option>
                {allUsers.map(u => (
                  <option key={u.id} value={u.id}>{u.display_name}</option>
                ))}
              </select>
            ) : (
              owner && (
                <span className="text-xs text-kk-muted px-1.5 py-0.5">· {owner.display_name}</span>
              )
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

      {/* Priority label */}
      <span className="text-[10px] text-kk-muted shrink-0">
        {PRIORITY_CONFIG[wo.priority ?? 2]?.label}
      </span>

      {/* Deadline — editable date input when canEdit */}
      {canEdit ? (
        <input
          type="date"
          value={wo.due_at ? wo.due_at.slice(0, 10) : ''}
          onChange={async e => {
            e.stopPropagation()
            await handleFieldSave('due_at', e.target.value || null)
          }}
          onClick={e => e.stopPropagation()}
          disabled={saving}
          className={[
            editCtrlCls,
            'shrink-0 font-medium',
            isOverdue ? 'text-kk-bad' : 'text-kk-muted',
          ].join(' ')}
          title="Change follow-up date"
        />
      ) : (
        wo.due_at && (
          <div className={`text-xs shrink-0 ${isOverdue ? 'text-kk-bad font-medium' : 'text-kk-muted'}`}>
            {new Date(wo.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </div>
        )
      )}

      {/* Done button */}
      {isActionable && (
        <div onClick={e => e.stopPropagation()}>
          <WaitingOnDoneButton id={wo.id} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WaitingOnList
// ---------------------------------------------------------------------------

export default function WaitingOnList({
  waitingOns,
  currentUser,
  allUsers,
  isManagementView,
  statusFilter,
}: {
  waitingOns: WORow[]
  currentUser: AppUser
  allUsers: UserOption[]
  isManagementView: boolean
  statusFilter: string
}) {
  const now = new Date().toISOString()

  if (waitingOns.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-kk-muted">
        {statusFilter === 'open' ? 'Nothing to wait on right now.' : `No ${statusFilter} waiting ons.`}
      </div>
    )
  }

  return (
    <div className="divide-y divide-kk-line">
      {waitingOns.map(wo => {
        const canEdit = canEditWaitingOn(currentUser.role, wo.owner_user_id, currentUser.id)
        return (
          <WaitingOnRow
            key={wo.id}
            wo={wo}
            now={now}
            canEdit={canEdit}
            allUsers={allUsers}
            isManagementView={isManagementView}
          />
        )
      })}
    </div>
  )
}
