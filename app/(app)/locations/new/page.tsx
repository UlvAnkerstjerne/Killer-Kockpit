import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { canManageLocations } from '@/lib/permissions'
import { createLocation } from '@/lib/actions/locations'

export const dynamic = 'force-dynamic'

export default async function NewLocationPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManageLocations(user.role)) redirect('/today')

  async function handleCreate(formData: FormData) {
    'use server'
    const name       = (formData.get('name') as string)?.trim()
    const short_name = (formData.get('short_name') as string)?.trim()
    if (!name || !short_name) return

    const result = await createLocation({ name, short_name })
    if (result.data?.id) {
      redirect(`/locations/${result.data.id}`)
    }
  }

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 text-sm text-kk-muted mb-4">
        <Link href="/locations" className="hover:text-kk-ink transition-colors">Locations</Link>
        <span>/</span>
        <span className="text-kk-ink">Add location</span>
      </div>

      <h1 className="text-2xl font-black tracking-tight text-kk-ink mb-6">Add location</h1>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
        <form action={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Name <span className="text-kk-bad">*</span>
            </label>
            <input
              name="name"
              required
              autoFocus
              placeholder="e.g. Killer Kebab Frederiksberg"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Short name <span className="text-kk-bad">*</span>
            </label>
            <input
              name="short_name"
              required
              placeholder="e.g. Frederiksberg"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
            <p className="text-xs text-kk-muted mt-1">
              Used in lists, dropdowns, and entity linking.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
            >
              Add location
            </button>
            <Link
              href="/locations"
              className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:text-kk-ink hover:border-kk-ink transition-colors"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
