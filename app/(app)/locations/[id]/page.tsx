import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageLocations } from '@/lib/permissions'
import { updateLocation } from '@/lib/actions/locations'
import { getEntityGmailSources } from '@/lib/actions/gmail'
import LinkedEmailsSection from '@/components/ui/LinkedEmailsSection'

export const dynamic = 'force-dynamic'

export default async function LocationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManageLocations(user.role)) redirect('/today')

  const supabase = await createClient()

  // Fetch location + any linked GBP location + gmail sources
  const [locResult, gbpResult, gmailSourcesResult] = await Promise.all([
    supabase
      .from('locations')
      .select('*')
      .eq('id', id)
      .single(),
    supabase
      .from('gbp_locations')
      .select('id, store_name, store_short_name, address_summary, active, google_account_id, google_location_id')
      .eq('location_id', id),
    getEntityGmailSources('location', id),
  ])

  if (locResult.error || !locResult.data) notFound()

  const loc         = locResult.data
  const gbpLinked   = gbpResult.data ?? []
  const gmailSources = gmailSourcesResult.data ?? []

  async function handleUpdate(formData: FormData) {
    'use server'
    const name       = (formData.get('name') as string)?.trim()
    const short_name = (formData.get('short_name') as string)?.trim()
    if (!name || !short_name) return

    await updateLocation(id, {
      name,
      short_name,
      active: formData.get('active') === 'true',
    })

    redirect(`/locations/${id}`)
  }

  return (
    <div className="max-w-xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-kk-muted mb-4">
        <Link href="/locations" className="hover:text-kk-ink transition-colors">Locations</Link>
        <span>/</span>
        <span className="text-kk-ink truncate">{loc.short_name}</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">{loc.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-kk-muted">{loc.short_name}</span>
            <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
              loc.active ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted'
            }`}>
              {loc.active ? 'Active' : 'Inactive'}
            </span>
          </div>
        </div>
      </div>

      {/* Edit form */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-kk-ink mb-4">Details</h2>
        <form action={handleUpdate} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Name <span className="text-kk-bad">*</span>
            </label>
            <input
              name="name"
              required
              defaultValue={loc.name}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Short name <span className="text-kk-bad">*</span>
            </label>
            <input
              name="short_name"
              required
              defaultValue={loc.short_name}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Status</label>
            <select
              name="active"
              defaultValue={loc.active ? 'true' : 'false'}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            >
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
            >
              Save changes
            </button>
            <Link
              href="/locations"
              className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:text-kk-ink hover:border-kk-ink transition-colors"
            >
              Back to Locations
            </Link>
          </div>
        </form>
      </div>

      {/* GBP mapping */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 mt-4">
        <h2 className="text-sm font-semibold text-kk-ink mb-3">
          Google Business Profile
        </h2>
        {gbpLinked.length === 0 ? (
          <p className="text-sm text-kk-muted">
            No GBP location linked to this store yet.
          </p>
        ) : (
          <div className="space-y-2">
            {gbpLinked.map((gbp) => (
              <div key={gbp.id} className="flex items-center gap-3 p-3 bg-kk-soft rounded-xl">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-kk-ink">{gbp.store_name}</div>
                  {gbp.address_summary && (
                    <div className="text-xs text-kk-muted mt-0.5">{gbp.address_summary}</div>
                  )}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  gbp.active ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted'
                }`}>
                  {gbp.active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 mt-4">
        <div className="text-xs text-kk-muted mb-0.5">Added</div>
        <div className="text-sm text-kk-ink">
          {new Date(loc.created_at).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric',
          })}
        </div>
      </div>

      <div className="mt-4">
        <LinkedEmailsSection sources={gmailSources} />
      </div>
    </div>
  )
}
