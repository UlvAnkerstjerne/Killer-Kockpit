import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditDecision, canApproveDecision } from '@/lib/permissions'
import { notFound } from 'next/navigation'
import { DecisionStatusBadge } from '@/components/ui/DecisionStatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import DecisionActions from './DecisionActions'
import type { DecisionStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function DecisionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [user, { id }] = await Promise.all([getCurrentUser(), params])
  if (!user) return null

  const supabase = await createClient()

  const { data: d } = await supabase
    .from('decisions')
    .select(`
      id, title, decision_text, rationale, status, decided_at, created_at, supersedes_decision_id,
      owner:owner_user_id (id, display_name, email),
      approved_by:approved_by_user_id (id, display_name, email),
      project:project_id (id, title),
      superseded_decision:supersedes_decision_id (id, title),
      meeting:meeting_id (id, title)
    `)
    .eq('id', id)
    .single()

  if (!d) notFound()

  const owner = Array.isArray(d.owner) ? d.owner[0] : d.owner
  const approvedBy = Array.isArray(d.approved_by) ? d.approved_by[0] : d.approved_by
  const project = Array.isArray(d.project) ? d.project[0] : d.project
  const supersededDecision = Array.isArray(d.superseded_decision) ? d.superseded_decision[0] : d.superseded_decision
  const meeting = Array.isArray(d.meeting) ? d.meeting[0] : (d.meeting as { id: string; title: string } | null)

  const canEdit = canEditDecision(user.role, owner?.id ?? null, user.id)
  const canApprove = canApproveDecision(user.role) && d.status === 'proposed'

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/decisions" className="hover:text-kk-ink transition-colors">Decisions</Link>
          <span>›</span>
          <span className="truncate">{d.title}</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">{d.title}</h1>
          <DecisionStatusBadge status={d.status as DecisionStatus} />
        </div>
      </div>

      <div className="grid gap-5">
        {/* Decision content */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl p-5 space-y-4">
          <div>
            <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-1">Decision</div>
            <p className="text-sm text-kk-ink whitespace-pre-wrap">{d.decision_text}</p>
          </div>

          {d.rationale && (
            <div>
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-1">Rationale</div>
              <p className="text-sm text-kk-muted whitespace-pre-wrap">{d.rationale}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-kk-line">
            {owner && (
              <div>
                <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Recorded by</div>
                <div className="text-sm text-kk-ink">{owner.display_name}</div>
              </div>
            )}

            {d.decided_at && (
              <div>
                <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Date</div>
                <div className="text-sm text-kk-ink">
                  {new Date(d.decided_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
              </div>
            )}

            {approvedBy && (
              <div>
                <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Approved by</div>
                <div className="text-sm text-kk-ink">{approvedBy.display_name}</div>
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

            {meeting && (
              <div>
                <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Created from</div>
                <Link href={`/meetings/${meeting.id}`} className="text-sm text-kk-ink hover:underline">
                  {meeting.title}
                </Link>
              </div>
            )}
          </div>

          {supersededDecision && (
            <div className="pt-2 border-t border-kk-line">
              <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-0.5">Supersedes</div>
              <Link href={`/decisions/${supersededDecision.id}`} className="text-sm text-kk-muted hover:text-kk-ink hover:underline">
                {supersededDecision.title}
              </Link>
            </div>
          )}
        </div>

        {/* Actions */}
        {(canApprove || canEdit) && d.status !== 'superseded' && (
          <DecisionActions
            decisionId={d.id}
            canApprove={canApprove}
            canEdit={canEdit}
            currentStatus={d.status as DecisionStatus}
          />
        )}

        {/* Audit history */}
        <AuditHistory entityType="decision" entityId={d.id} />
      </div>
    </div>
  )
}
