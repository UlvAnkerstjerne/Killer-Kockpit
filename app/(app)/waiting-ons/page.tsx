import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import WaitingOnList from '@/components/waiting-ons/WaitingOnList'
import type { ViewMode } from '@/lib/types'

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
  const [user, params, allUsers] = await Promise.all([getCurrentUser(), searchParams, getActiveUsers()])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const canManage = canAccessManagementView(user.role)
  const statusFilter = params.status || 'open'

  const supabase = await createClient()
  const now = new Date().toISOString()

  let query = supabase
    .from('waiting_ons')
    .select(`
      id, title, status, priority, due_at, waiting_for_name, owner_user_id,
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
        <WaitingOnList
          waitingOns={waitingOns ?? []}
          currentUser={user}
          allUsers={allUsers}
          isManagementView={canManage && view === 'management'}
          statusFilter={statusFilter}
        />
      </div>
    </div>
  )
}
