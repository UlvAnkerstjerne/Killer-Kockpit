import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManagePeople } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManagePeople(user.role)) redirect('/today')

  const { view } = await searchParams
  const showFormer = view === 'former'

  const supabase = await createClient()

  const [listResult, countsResult] = await Promise.all([
    supabase
      .from('employees')
      .select('id, name, role_title, store_or_team, employment_status, linked_user_id')
      .eq('employment_status', showFormer ? 'left' : 'active')
      .order('name'),
    supabase
      .from('employees')
      .select('employment_status'),
  ])

  if (listResult.error) {
    return (
      <div className="p-4 rounded-xl bg-kk-bad-bg border border-red-200 text-kk-bad text-sm">
        Failed to load people. Please refresh.
      </div>
    )
  }

  const employees   = listResult.data ?? []
  const allStatuses = countsResult.data ?? []
  const activeCount = allStatuses.filter(e => e.employment_status === 'active').length
  const formerCount = allStatuses.filter(e => e.employment_status === 'left').length

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">People</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            Killer Kebab team directory. Management access only.
          </p>
        </div>
        <Link
          href="/people/new"
          className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
        >
          + Add person
        </Link>
      </div>

      {/* Summary + view toggle */}
      <div className="flex items-center gap-3 mb-6">
        <div className="grid grid-cols-2 gap-3 flex-1">
          <div className="bg-kk-panel border border-kk-line rounded-xl p-4">
            <div className="text-xs text-kk-muted">Active</div>
            <div className="text-2xl font-black tracking-tight text-kk-ink mt-0.5">{activeCount}</div>
          </div>
          <div className="bg-kk-panel border border-kk-line rounded-xl p-4">
            <div className="text-xs text-kk-muted">Former</div>
            <div className="text-2xl font-black tracking-tight text-kk-ink mt-0.5">{formerCount}</div>
          </div>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex gap-2 mb-4">
        <Link
          href="/people"
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            !showFormer
              ? 'bg-kk-ink text-white'
              : 'bg-kk-panel border border-kk-line text-kk-muted hover:text-kk-ink'
          }`}
        >
          Active
        </Link>
        <Link
          href="/people?view=former"
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            showFormer
              ? 'bg-kk-ink text-white'
              : 'bg-kk-panel border border-kk-line text-kk-muted hover:text-kk-ink'
          }`}
        >
          Former
        </Link>
      </div>

      {employees.length === 0 ? (
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-12 text-center">
          <p className="text-sm text-kk-muted">
            {showFormer ? 'No former people on record.' : 'No people added yet.'}
          </p>
          {!showFormer && (
            <Link
              href="/people/new"
              className="inline-block mt-3 text-sm text-kk-ink font-medium hover:underline"
            >
              Add the first person →
            </Link>
          )}
        </div>
      ) : (
        <div className="bg-kk-panel border border-kk-line rounded-2xl divide-y divide-kk-line">
          {/* Header */}
          <div className="grid grid-cols-[1fr_160px_140px] text-xs font-semibold text-kk-muted uppercase tracking-wide border-b border-kk-line">
            <div className="px-5 py-3">Name</div>
            <div className="px-3 py-3">Role</div>
            <div className="px-3 py-3">Store / Team</div>
          </div>

          {employees.map((emp) => (
            <Link
              key={emp.id}
              href={`/people/${emp.id}`}
              className="grid grid-cols-[1fr_160px_140px] items-center hover:bg-kk-soft transition-colors last:rounded-b-2xl group"
            >
              <div className="px-5 py-3.5">
                <span className="text-sm font-medium text-kk-ink group-hover:underline">
                  {emp.name}
                </span>
                {emp.linked_user_id && (
                  <span className="ml-2 text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full font-medium">
                    App user
                  </span>
                )}
                {showFormer && (
                  <span className="ml-2 text-[10px] bg-kk-soft text-kk-muted px-1.5 py-0.5 rounded-full font-medium">
                    Former
                  </span>
                )}
              </div>
              <div className="px-3 py-3.5 text-sm text-kk-muted truncate">
                {emp.role_title || '—'}
              </div>
              <div className="px-3 py-3.5 text-sm text-kk-muted truncate">
                {emp.store_or_team || '—'}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
