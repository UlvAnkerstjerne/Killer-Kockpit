import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAssignToOthers } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'
import TaskForm from '@/components/tasks/TaskForm'

export const dynamic = 'force-dynamic'

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ project_id?: string }>
}) {
  const [user, allUsers, params] = await Promise.all([
    getCurrentUser(),
    getActiveUsers(),
    searchParams,
  ])
  if (!user) return null

  const supabase = await createClient()
  const { data: projects } = await supabase
    .from('projects')
    .select('id, title')
    .is('archived_at', null)
    .not('status', 'eq', 'completed')
    .order('title')

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">New task</h1>
        <p className="text-sm text-kk-muted mt-0.5">Create a task and assign a responsible person.</p>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-6">
        <TaskForm
          mode="create"
          currentUser={user}
          allUsers={canAssignToOthers(user.role) ? allUsers : [{ id: user.id, display_name: user.display_name, email: user.email }]}
          projects={projects || []}
          defaultProjectId={params.project_id}
        />
      </div>
    </div>
  )
}
