import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAssignToOthers } from '@/lib/permissions'
import ProjectForm from '@/components/projects/ProjectForm'

export default async function NewProjectPage() {
  const [user, users] = await Promise.all([getCurrentUser(), getActiveUsers()])
  if (!user) return null

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">New project</h1>
        <p className="text-sm text-kk-muted mt-0.5">Create a new project to track a body of work.</p>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-6">
        <ProjectForm
          mode="create"
          currentUser={user}
          allUsers={canAssignToOthers(user.role) ? users : [{ id: user.id, display_name: user.display_name, email: user.email }]}
        />
      </div>
    </div>
  )
}
