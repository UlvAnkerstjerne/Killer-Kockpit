import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAssignToOthers } from '@/lib/permissions'
import WaitingOnForm from './WaitingOnForm'

export default async function NewWaitingOnPage({
  searchParams,
}: {
  searchParams: Promise<{ project_id?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const supabase = await createClient()
  const canAssign = canAssignToOthers(user.role)

  const [usersResult, projectsResult] = await Promise.all([
    canAssign
      ? supabase.from('app_users').select('id, display_name').eq('active', true).order('display_name')
      : Promise.resolve({ data: [] }),
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived")')
      .order('title'),
  ])

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/waiting-ons" className="hover:text-kk-ink transition-colors">Waiting On</Link>
          <span>›</span>
          <span>New</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">New Waiting On</h1>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-6">
        <WaitingOnForm
          currentUserId={user.id}
          canAssign={canAssign}
          users={usersResult.data ?? []}
          projects={projectsResult.data ?? []}
          defaultProjectId={params.project_id}
        />
      </div>
    </div>
  )
}
