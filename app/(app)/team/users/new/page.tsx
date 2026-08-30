import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { canManageUsers } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import NewUserForm from './NewUserForm'

export default async function NewUserPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManageUsers(user.role)) redirect('/team')

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/team" className="hover:text-kk-ink transition-colors">Team</Link>
          <span>›</span>
          <Link href="/team/users" className="hover:text-kk-ink transition-colors">Users</Link>
          <span>›</span>
          <span>New</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Add user</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Pre-approve a team member. They can sign in with their @killerkebab.com Google account once added.
        </p>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-6">
        <NewUserForm />
      </div>
    </div>
  )
}
