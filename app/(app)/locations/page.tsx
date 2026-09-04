import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageLocations } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function LocationsPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManageLocations(user.role)) redirect('/today')

  const supabase = await createClient()

  const { data: locations, error } = await supabase
    .from('locations')
    .select('id, name, short_name, active, created_at')
    .order('name')

  if (error) {
    return (
      <div className="p-4 rounded-xl bg-kk-bad-bg border border-red-200 text-kk-bad text-sm">
        Failed to load locations. Please refresh.
      </div>
    )
  }

  const active   = locations?.filter(l => l.active)  ?? []
  const inactive = locations?.filter(l => !l.active) ?? []

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Locations</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            Killer Kebab store locations. Foundation for entity linking.
          </p>
        </div>
        <Link
          href="/locations/new"
          className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
        >
          + Add location
        </Link>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-kk-panel border border-kk-line rounded-xl p-4">
          <div className="text-xs text-kk-muted">Active</div>
          <div className="text-2xl font-black tracking-tight text-kk-ink mt-0.5">{active.length}</div>
        </div>
        <div className="bg-kk-panel border border-kk-line rounded-xl p-4">
          <div className="text-xs text-kk-muted">Inactive</div>
          <div className="text-2xl font-black tracking-tight text-kk-ink mt-0.5">{inactive.length}</div>
        </div>
      </div>

      {!locations || locations.length === 0 ? (
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-12 text-center">
          <p className="text-sm text-kk-muted">No locations added yet.</p>
          <Link
            href="/locations/new"
            className="inline-block mt-3 text-sm text-kk-ink font-medium hover:underline"
          >
            Add the first location →
          </Link>
        </div>
      ) : (
        <div className="bg-kk-panel border border-kk-line rounded-2xl divide-y divide-kk-line">
          <div className="grid grid-cols-[1fr_120px_80px] text-xs font-semibold text-kk-muted uppercase tracking-wide border-b border-kk-line">
            <div className="px-5 py-3">Name</div>
            <div className="px-3 py-3">Short name</div>
            <div className="px-3 py-3">Status</div>
          </div>

          {locations.map((loc) => (
            <Link
              key={loc.id}
              href={`/locations/${loc.id}`}
              className="grid grid-cols-[1fr_120px_80px] items-center hover:bg-kk-soft transition-colors last:rounded-b-2xl group"
            >
              <div className="px-5 py-3.5">
                <span className="text-sm font-medium text-kk-ink group-hover:underline">
                  {loc.name}
                </span>
              </div>
              <div className="px-3 py-3.5 text-sm text-kk-muted">
                {loc.short_name}
              </div>
              <div className="px-3 py-3.5">
                <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
                  loc.active ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted'
                }`}>
                  {loc.active ? 'Active' : 'Inactive'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
