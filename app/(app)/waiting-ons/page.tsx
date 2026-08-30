import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { WaitingOnStatusBadge } from '@/components/ui/WaitingOnStatusBadge'
import type { ViewMode, WaitingStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: 'Open', value: 'open' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Fulfilled', value: 'fulfilled' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'All', value: 'all' },
]

export default async function WaitingOnsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; status?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const canManage = canAccessManagementView(user.role)
  const statusFilter = params.status || 'open'

  const supabase = await createClient()
  const now = new Date().toISOString()

  let query = supabase
    .from('waiting_ons')
    .select(`
      id, title, status, due_at, waiting_for_name, notes,
      owner:owner_user_id (id, display_name, email),
      waiting_for_user:waiting_for_user_id (id, display_name, email),
      project:project_id (id, title)
    `)
    .is('archived_at', null)
    .order('due_at', { ascending: true, nullsFirst: false })

  if (!canManage || view === 'personal') {
    query = query.eq('owner_user_id', user.id)
  }

  if (statusFilter !== 'all') {
    // 'overdue' is a computed status — show open items past their due date
    if (statusFilter === 'overdue') {
      query = query.eq('status', 'open').lt('due_at', now)
    } else {
      query = query.eq('status', statusFilter)
    }
  }

  const { data: waitingOns } = await query.limit(100)

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Waiting On</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            {canManage && view === 'management' ? 'All waiting ons across the organisation.' : 'What you are waiting on from others.'}
          </p>
        </div>
        <Link
          href="/waiting-ons/new"
          className="text-sm px-4 py-2 bg-kk-ink text-white rounded-xl hover:opacity-90 transition-opacity font-medium"
        >
          + Waiting On
        </Link>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-5">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.value}
            href={`/waiting-ons?status=${f.value}${canManage ? `&view=${view}` : ''}`}
            className={[
              'text-sm px-3 py-1.5 rounded-lg transition-colors',
              statusFilter === f.value
                ? 'bg-kk-ink text-white font-medium'
                : 'text-kk-muted hover:bg-kk-line hover:text-kk-ink',
            ].join(' ')}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
        <div className="divide-y divide-kk-line">
          {(waitingOns ?? []).map((wo) => {
            const owner = Array.isArray(wo.owner) ? wo.owner[0] : wo.owner
            const waitingForUser = Array.isArray(wo.waiting_for_user) ? wo.waiting_for_user[0] : wo.waiting_for_user
            const project = Array.isArray(wo.project) ? wo.project[0] : wo.project
            const isOverdue = wo.status === 'open' && wo.due_at && wo.due_at < now

            return (
              <Link
                key={wo.id}
                href={`/waiting-ons/${wo.id}`}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                      {wo.title}
                    </span>
                    <WaitingOnStatusBadge status={(isOverdue ? 'overdue' : wo.status) as WaitingStatus} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {(waitingForUser?.display_name || wo.waiting_for_name) && (
                      <span className="text-xs text-kk-muted">
                        Waiting on: {waitingForUser?.display_name || wo.waiting_for_name}
                      </span>
                    )}
                    {project && (
                      <span className="text-xs text-kk-muted">· {project.title}</span>
                    )}
                    {canManage && view === 'management' && owner && (
                      <span className="text-xs text-kk-muted">· {owner.display_name}</span>
                    )}
                  </div>
                </div>
                {wo.due_at && (
                  <div className={`text-xs shrink-0 ${isOverdue ? 'text-kk-bad font-medium' : 'text-kk-muted'}`}>
                    {new Date(wo.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                )}
              </Link>
            )
          })}

          {(!waitingOns || waitingOns.length === 0) && (
            <div className="px-5 py-10 text-center text-sm text-kk-muted">
              {statusFilter === 'open' ? 'Nothing to wait on right now.' : `No ${statusFilter} waiting ons.`}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
