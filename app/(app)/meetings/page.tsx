import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateMeeting, canAccessManagementView } from '@/lib/permissions'
import { MeetingStatusBadge } from '@/components/ui/MeetingStatusBadge'
import type { MeetingStatus } from '@/lib/types'

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

  function formatDateTime(dt: string | null) {
    if (!dt) return null
    return new Date(dt).toLocaleDateString('en-GB', {
      timeZone: 'Europe/Copenhagen',
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    })
  }

  type MeetingRow = { id: string; title: string; status: string; scheduled_start: string | null; scheduled_end?: string | null; owner: { display_name: string } | Array<{ display_name: string }> | undefined; project: { id: string; title: string } | Array<{ id: string; title: string }> | undefined }

  function renderMeetingRow(m: MeetingRow) {
    const owner = Array.isArray(m.owner) ? m.owner[0] : m.owner
    const project = Array.isArray(m.project) ? m.project[0] : m.project
    return (
      <Link
        key={m.id}
        href={`/meetings/${m.id}`}
        className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
              {m.title}
            </span>
            <MeetingStatusBadge status={m.status as MeetingStatus} />
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {owner && <span className="text-xs text-kk-muted">{owner.display_name}</span>}
            {project && <span className="text-xs text-kk-muted">· {project.title}</span>}
          </div>
        </div>
        {m.scheduled_start && (
          <div className="text-xs text-kk-muted shrink-0">
            {formatDateTime(m.scheduled_start)}
          </div>
        )}
      </Link>
    )
  }

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
            {(activeMeetings ?? []).map(renderMeetingRow)}
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
            <div className="divide-y divide-kk-line">
              {publishedMeetings.map(renderMeetingRow)}
            </div>
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
            <div className="divide-y divide-kk-line">
              {cancelledMeetings.map(renderMeetingRow)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
