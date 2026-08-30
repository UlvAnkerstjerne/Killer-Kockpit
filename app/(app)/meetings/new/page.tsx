import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateMeeting, canAssignToOthers } from '@/lib/permissions'
import MeetingForm from './MeetingForm'

export const dynamic = 'force-dynamic'

export default async function NewMeetingPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canCreateMeeting(user.role)) redirect('/meetings')

  const supabase = await createClient()
  const [usersResult, projectsResult] = await Promise.all([
    supabase.from('app_users').select('id, display_name').eq('active', true).order('display_name'),
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived")')
      .order('title'),
  ])

  return (
    <div className="max-w-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">New meeting</h1>
        <p className="text-sm text-kk-muted mt-1">Schedule a meeting and set it up for collaborative note-taking.</p>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
        <MeetingForm
          currentUserId={user.id}
          canAssign={canAssignToOthers(user.role)}
          users={usersResult.data ?? []}
          projects={projectsResult.data ?? []}
        />
      </div>
    </div>
  )
}
