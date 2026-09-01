import { Suspense } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditWaitingOn, canAssignToOthers } from '@/lib/permissions'
import { notFound } from 'next/navigation'
import { WaitingOnStatusBadge } from '@/components/ui/WaitingOnStatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import WaitingOnActions from './WaitingOnActions'
import WaitingOnEditForm from './WaitingOnEditForm'
import GmailProvenance from '@/components/ui/GmailProvenance'
import type { WaitingStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function WaitingOnDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [user, { id }] = await Promise.all([getCurrentUser(), params])
  if (!user) return null

  const supabase = await createClient()
  const canAssign = canAssignToOthers(user.role)

  const [woResult, usersResult, projectsResult] = await Promise.all([
    supabase
      .from('waiting_ons')
      .select(`
        id, title, status, due_at, waiting_for_name, notes, created_at, updated_at,
        owner:owner_user_id (id, display_name, email),
        waiting_for_user:waiting_for_user_id (id, display_name, email),
        project:project_id (id, title),
        meeting:meeting_id (id, title)
      `)
      .eq('id', id)
      .single(),
    supabase.from('app_users').select('id, display_name').eq('active', true).order('display_name'),
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived","cancelled")')
      .order('title'),
  ])

  const wo = woResult.data
  if (!wo) notFound()

  const owner = Array.isArray(wo.owner) ? wo.owner[0] : wo.owner
  const waitingForUser = Array.isArray(wo.waiting_for_user) ? wo.waiting_for_user[0] : wo.waiting_for_user
  const project = Array.isArray(wo.project) ? wo.project[0] : wo.project
  const meeting = Array.isArray(wo.meeting) ? wo.meeting[0] : (wo.meeting as { id: string; title: string } | null)
  const now = new Date().toISOString()
  const isOverdue = wo.status === 'open' && wo.due_at && wo.due_at < now
  const displayStatus = (isOverdue ? 'overdue' : wo.status) as WaitingStatus
  const canEdit = canEditWaitingOn(user.role, owner?.id ?? null, user.id)

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/waiting-ons" className="hover:text-kk-ink transition-colors">Waiting On</Link>
          <span>›</span>
          <span className="truncate">{wo.title}</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">{wo.title}</h1>
          <WaitingOnStatusBadge status={displayStatus} />
        </div>
      </div>

      <div className="grid gap-5">
        {/* Detail card */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl p-5 space-y-3">
          {(waitingForUser || wo.waiting_for_name) && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Waiting on</div>
              <div className="text-sm text-kk-ink">{waitingForUser?.display_name || wo.waiting_for_name}</div>
            </div>
          )}

          {owner && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Owner</div>
              <div className="text-sm text-kk-ink">{owner.display_name}</div>
            </div>
          )}

          {wo.due_at && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Due</div>
              <div className={`text-sm ${isOverdue ? 'text-kk-bad font-medium' : 'text-kk-ink'}`}>
                {new Date(wo.due_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
            </div>
          )}

          {project && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Project</div>
              <Link href={`/projects/${project.id}`} className="text-sm text-kk-ink hover:underline">
                {project.title}
              </Link>
            </div>
          )}

          {wo.notes && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Notes</div>
              <p className="text-sm text-kk-ink whitespace-pre-wrap">{wo.notes}</p>
            </div>
          )}

          {meeting && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Created from</div>
              <Link href={`/meetings/${meeting.id}`} className="text-sm text-kk-ink hover:underline">
                {meeting.title}
              </Link>
            </div>
          )}

          <Suspense fallback={null}>
            <GmailProvenance entityType="waiting_on" entityId={wo.id} />
          </Suspense>
        </div>

        {/* Edit form */}
        {canEdit && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">Edit waiting on</h2>
            </div>
            <div className="p-5">
              <WaitingOnEditForm
                waitingOnId={wo.id}
                currentUserId={user.id}
                canAssign={canAssign}
                initialTitle={wo.title}
                initialWaitingForUserId={waitingForUser?.id ?? ''}
                initialWaitingForName={wo.waiting_for_name ?? ''}
                initialUseExternalName={!waitingForUser && !!wo.waiting_for_name}
                initialOwnerId={owner?.id ?? user.id}
                initialProjectId={project?.id ?? ''}
                initialDueAt={wo.due_at ? wo.due_at.slice(0, 16) : ''}
                initialNotes={wo.notes ?? ''}
                users={usersResult.data ?? []}
                projects={projectsResult.data ?? []}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        {canEdit && (
          <WaitingOnActions waitingOnId={wo.id} status={wo.status as WaitingStatus} />
        )}

        {/* Audit history */}
        <Suspense fallback={null}>
          <AuditHistory entityType="waiting_on" entityId={wo.id} />
        </Suspense>
      </div>
    </div>
  )
}
