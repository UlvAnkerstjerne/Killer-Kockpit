import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canManagePeople } from '@/lib/permissions'
import { createEmployee } from '@/lib/actions/employees'

export const dynamic = 'force-dynamic'

export default async function NewPersonPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManagePeople(user.role)) redirect('/today')

  const allUsers = await getActiveUsers()

  async function handleCreate(formData: FormData) {
    'use server'
    const name       = (formData.get('name') as string)?.trim()
    if (!name) return

    const result = await createEmployee({
      name,
      role_title:      formData.get('role_title') as string || undefined,
      store_or_team:   formData.get('store_or_team') as string || undefined,
      employment_status: formData.get('employment_status') as string || 'active',
      linked_user_id:  formData.get('linked_user_id') as string || null,
    })

    if (result.data?.id) {
      redirect(`/people/${result.data.id}`)
    }
  }

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 text-sm text-kk-muted mb-4">
        <Link href="/people" className="hover:text-kk-ink transition-colors">People</Link>
        <span>/</span>
        <span className="text-kk-ink">Add person</span>
      </div>

      <h1 className="text-2xl font-black tracking-tight text-kk-ink mb-6">Add person</h1>

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
              placeholder="e.g. Ronnie Hansen"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Role / Title</label>
            <input
              name="role_title"
              placeholder="e.g. Store Manager"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Store / Team</label>
            <input
              name="store_or_team"
              placeholder="e.g. Frederiksberg"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Status</label>
            <select
              name="employment_status"
              defaultValue="active"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="left">Left</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Linked Kockpit account
              <span className="ml-1 text-kk-muted font-normal">(optional)</span>
            </label>
            <select
              name="linked_user_id"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            >
              <option value="">None</option>
              {allUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.email})
                </option>
              ))}
            </select>
            <p className="text-xs text-kk-muted mt-1">
              Links this person to a Kockpit login account.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
            >
              Add person
            </button>
            <Link
              href="/people"
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
