import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateMeeting, canAccessManagementView } from '@/lib/permissions'
import MeetingList from '@/components/meetings/MeetingList'

export const dynamic = 'force-dynamic'

export default async function MeetingsPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const supabase = await createClient()
  const canCreate = canCreateMeeting(user.role)
  const canManage = canAccessManagementView(user.role)

  // Active meetings (scheduled, open, draft) - ordered by scheduled_start
  const { data: activeMeetings } = await supabase
    .from('meetings')
    .select(`
      id, title, status, scheduled_start, scheduled_end,
      owner:owner_user_id (id, display_name),
      project:project_id (id, title)
    `)
    .in('status', ['scheduled', 'open', 'draft'])
    .order('scheduled_start', { ascending: true, nullsFirst: false })

  // Published meetings - most recent first
  const { data: publishedMeetings } = await supabase
    .from('meetings')
    .select(`
      id, title, status, scheduled_start,
      owner:owner_user_id (id, display_name),
      project:project_id (id, title)
    `)
    .eq('status', 'published')
    .order('scheduled_start', { ascending: false })
    .limit(20)

  // Cancelled meetings - most recent first, limit to keep the page scannable
  const { data: cancelledMeetings } = await supabase
    .from('meetings')
    .select(`
      id, title, status, scheduled_start,
      owner:owner_user_id (id, display_name),
      project:project_id (id, title)
    `)
    .eq('status', 'cancelled')
    .order('scheduled_start', { ascending: false })
    .limit(20)

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Meetings</h1>
        {canCreate && (
          <Link
            href="/meetings/new"
            className="text-sm px-4 py-2 bg-kk-ink text-white rounded-xl hover:opacity-90 transition-opacity"
          >
            + New meeting
          </Link>
        )}
      </div>

      <div className="space-y-6">
        {/* Active meetings */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line">
            <h2 className="text-sm font-semibold text-kk-ink">
              Active <span className="text-kk-muted font-normal">· {activeMeetings?.length || 0}</span>
            </h2>
          </div>
          <div className="divide-y divide-kk-line">
            {activeMeetings && activeMeetings.length > 0 && (
              <MeetingList meetings={activeMeetings} />
            )}
            {(!activeMeetings || activeMeetings.length === 0) && (
              <div className="px-5 py-8 text-center text-sm text-kk-muted">
                No active meetings.
                {canCreate && (
                  <> <Link href="/meetings/new" className="text-kk-ink underline">Schedule one.</Link></>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Published meetings */}
        {(publishedMeetings && publishedMeetings.length > 0) && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Published <span className="text-kk-muted font-normal">· {publishedMeetings.length}</span>
              </h2>
            </div>
            <MeetingList meetings={publishedMeetings} />
          </div>
        )}

        {/* Cancelled meetings */}
        {(cancelledMeetings && cancelledMeetings.length > 0) && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Cancelled <span className="text-kk-muted font-normal">· {cancelledMeetings.length}</span>
              </h2>
            </div>
            <MeetingList meetings={cancelledMeetings} />
          </div>
        )}
      </div>
    </div>
  )
}
