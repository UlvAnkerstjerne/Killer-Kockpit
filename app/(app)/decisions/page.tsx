import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateDecision } from '@/lib/permissions'
import { DecisionStatusBadge } from '@/components/ui/DecisionStatusBadge'
import type { DecisionStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

const STATUS_FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Proposed', value: 'proposed' },
  { label: 'Approved', value: 'approved' },
  { label: 'Superseded', value: 'superseded' },
]

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const statusFilter = params.status || 'all'
  const query = params.q || ''
  const canCreate = canCreateDecision(user.role)

  const supabase = await createClient()

  let dbQuery = supabase
    .from('decisions')
    .select(`
      id, title, decision_text, status, decided_at, created_at,
      owner:owner_user_id (id, display_name, email),
      project:project_id (id, title),
      approved_by:approved_by_user_id (id, display_name, email)
    `)
    .is('archived_at', null)
    .order('created_at', { ascending: false })

  if (statusFilter !== 'all') {
    dbQuery = dbQuery.eq('status', statusFilter)
  }

  if (query) {
    dbQuery = dbQuery.ilike('title', `%${query}%`)
  }

  const { data: decisions } = await dbQuery.limit(100)

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Decisions</h1>
          <p className="text-sm text-kk-muted mt-0.5">The organisation&apos;s decision log. A permanent, searchable record.</p>
        </div>
        {canCreate && (
          <Link
            href="/decisions/new"
            className="text-sm px-4 py-2 bg-kk-ink text-white rounded-xl hover:opacity-90 transition-opacity font-medium"
          >
            + Decision
          </Link>
        )}
      </div>

      {/* Search + filter row */}
      <div className="flex items-center gap-3 mb-5">
        <form className="flex-1 max-w-xs" method="GET">
          <input
            name="q"
            defaultValue={query}
            placeholder="Search decisions…"
            className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
          />
          {statusFilter !== 'all' && <input type="hidden" name="status" value={statusFilter} />}
        </form>
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.value}
              href={`/decisions?status=${f.value}${query ? `&q=${encodeURIComponent(query)}` : ''}`}
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
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
        <div className="divide-y divide-kk-line">
          {(decisions ?? []).map((d) => {
            const owner = Array.isArray(d.owner) ? d.owner[0] : d.owner
            const project = Array.isArray(d.project) ? d.project[0] : d.project

            return (
              <Link
                key={d.id}
                href={`/decisions/${d.id}`}
                className="flex items-start gap-4 px-5 py-4 hover:bg-kk-soft transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-kk-ink group-hover:underline">
                      {d.title}
                    </span>
                    <DecisionStatusBadge status={d.status as DecisionStatus} />
                  </div>
                  <p className="text-xs text-kk-muted mt-0.5 line-clamp-2">{d.decision_text}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {owner && <span className="text-xs text-kk-muted">{owner.display_name}</span>}
                    {project && <span className="text-xs text-kk-muted">· {project.title}</span>}
                    {d.decided_at && (
                      <span className="text-xs text-kk-muted">
                        · {new Date(d.decided_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}

          {(!decisions || decisions.length === 0) && (
            <div className="px-5 py-10 text-center text-sm text-kk-muted">
              {query ? `No decisions matching "${query}".` : 'No decisions recorded yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
