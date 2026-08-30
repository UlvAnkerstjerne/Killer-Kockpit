import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageUsers } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import UserManagementRow from './UserManagementRow'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManageUsers(user.role)) redirect('/team')

  const supabase = await createClient()
  const { data: users } = await supabase
    .from('app_users')
    .select('id, display_name, email, role, active, google_subject_id, created_at')
    .order('display_name')

  const ROLE_ORDER = { SUPER_ADMIN: 0, UM: 1, MEMBER: 2 }
  const sorted = (users ?? []).sort((a, b) => {
    const roleOrder = (ROLE_ORDER[a.role as keyof typeof ROLE_ORDER] ?? 3) - (ROLE_ORDER[b.role as keyof typeof ROLE_ORDER] ?? 3)
    if (roleOrder !== 0) return roleOrder
    return a.display_name.localeCompare(b.display_name)
  })

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
            <Link href="/team" className="hover:text-kk-ink transition-colors">Team</Link>
            <span>›</span>
            <span>Users</span>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">User Management</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            Pre-approve users and manage roles. Users without a bound Google account will see a &ldquo;Waiting for first login&rdquo; status.
          </p>
        </div>
        <Link
          href="/team/users/new"
          className="text-sm px-4 py-2 bg-kk-ink text-white rounded-xl hover:opacity-90 transition-opacity font-medium"
        >
          + Add user
        </Link>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_120px_100px_48px] border-b border-kk-line text-xs font-semibold text-kk-muted uppercase tracking-wide">
          <div className="px-5 py-3">User</div>
          <div className="px-3 py-3">Role</div>
          <div className="px-3 py-3">Status</div>
          <div className="px-3 py-3">Access</div>
          <div className="px-3 py-3" />
        </div>

        <div className="divide-y divide-kk-line">
          {sorted.map((u) => (
            <UserManagementRow
              key={u.id}
              targetUser={u}
              currentUserId={user.id}
            />
          ))}
          {sorted.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-kk-muted">No users found.</div>
          )}
        </div>
      </div>
    </div>
  )
}
