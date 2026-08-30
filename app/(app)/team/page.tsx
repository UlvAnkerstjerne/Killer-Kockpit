import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView, canManageUsers } from '@/lib/permissions'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function TeamPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canAccessManagementView(user.role)) redirect('/today')

  const supabase = await createClient()

  // Fetch all active users with task/project/waiting-on counts
  const { data: users } = await supabase
    .from('app_users')
    .select('id, display_name, email, role, active')
    .eq('active', true)
    .order('display_name')

  // Fetch open tasks per user (status not in done/cancelled, not archived)
  const { data: openTasks } = await supabase
    .from('tasks')
    .select('owner_user_id, status, due_at')
    .not('status', 'in', '("done","cancelled")')
    .is('archived_at', null)

  // Fetch projects owned per user (not archived, not completed)
  const { data: openProjects } = await supabase
    .from('projects')
    .select('owner_user_id')
    .is('archived_at', null)
    .not('status', 'in', '("completed","archived")')

  // Fetch open waiting ons per user
  const { data: openWaitingOns } = await supabase
    .from('waiting_ons')
    .select('owner_user_id, status, due_at')
    .not('status', 'in', '("fulfilled","cancelled")')
    .is('archived_at', null)

  const now = new Date().toISOString()

  // Build per-user stat maps
  const taskCountByUser = new Map<string, number>()
  const overdueTaskCountByUser = new Map<string, number>()
  for (const task of openTasks ?? []) {
    if (!task.owner_user_id) continue
    taskCountByUser.set(task.owner_user_id, (taskCountByUser.get(task.owner_user_id) ?? 0) + 1)
    if (task.due_at && task.due_at < now) {
      overdueTaskCountByUser.set(task.owner_user_id, (overdueTaskCountByUser.get(task.owner_user_id) ?? 0) + 1)
    }
  }

  const projectCountByUser = new Map<string, number>()
  for (const project of openProjects ?? []) {
    if (!project.owner_user_id) continue
    projectCountByUser.set(project.owner_user_id, (projectCountByUser.get(project.owner_user_id) ?? 0) + 1)
  }

  const waitingOnCountByUser = new Map<string, number>()
  for (const wo of openWaitingOns ?? []) {
    if (!wo.owner_user_id) continue
    waitingOnCountByUser.set(wo.owner_user_id, (waitingOnCountByUser.get(wo.owner_user_id) ?? 0) + 1)
  }

  const isSuperAdmin = canManageUsers(user.role)

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Team</h1>
          <p className="text-sm text-kk-muted mt-0.5">Workload overview for all active team members.</p>
        </div>
        {isSuperAdmin && (
          <Link
            href="/team/users"
            className="text-sm px-4 py-2 bg-kk-ink text-white rounded-xl hover:opacity-90 transition-opacity font-medium"
          >
            Manage users
          </Link>
        )}
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[1fr_80px_80px_80px_80px] border-b border-kk-line text-xs font-semibold text-kk-muted uppercase tracking-wide">
          <div className="px-5 py-3">Member</div>
          <div className="px-3 py-3 text-center">Tasks</div>
          <div className="px-3 py-3 text-center text-kk-bad">Overdue</div>
          <div className="px-3 py-3 text-center">Projects</div>
          <div className="px-3 py-3 text-center">Waiting</div>
        </div>

        <div className="divide-y divide-kk-line">
          {(users ?? []).map((member) => {
            const tasks = taskCountByUser.get(member.id) ?? 0
            const overdue = overdueTaskCountByUser.get(member.id) ?? 0
            const projects = projectCountByUser.get(member.id) ?? 0
            const waitingOns = waitingOnCountByUser.get(member.id) ?? 0

            return (
              <div
                key={member.id}
                className="grid grid-cols-[1fr_80px_80px_80px_80px] items-center hover:bg-kk-soft transition-colors"
              >
                <div className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-kk-line flex items-center justify-center text-xs font-bold text-kk-ink shrink-0">
                      {member.display_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-kk-ink">{member.display_name}</div>
                      <div className="text-xs text-kk-muted">{member.role}</div>
                    </div>
                  </div>
                </div>
                <div className="px-3 py-4 text-center text-sm text-kk-ink">{tasks || '–'}</div>
                <div className={`px-3 py-4 text-center text-sm font-medium ${overdue > 0 ? 'text-kk-bad' : 'text-kk-muted'}`}>
                  {overdue || '–'}
                </div>
                <div className="px-3 py-4 text-center text-sm text-kk-ink">{projects || '–'}</div>
                <div className="px-3 py-4 text-center text-sm text-kk-ink">{waitingOns || '–'}</div>
              </div>
            )
          })}

          {!users || users.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-kk-muted">No active team members.</div>
          )}
        </div>
      </div>
    </div>
  )
}
