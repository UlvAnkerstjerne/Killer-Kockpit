import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageTranscript } from '@/lib/permissions'
import type { MeetingAttendee } from '@/lib/types'
import RecordingClient from './RecordingClient'

export const dynamic = 'force-dynamic'

export default async function RecordMeetingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [user, { id }] = await Promise.all([getCurrentUser(), params])
  if (!user) return null

  const supabase = await createClient()

  const [meetingResult, attendeesResult] = await Promise.all([
    supabase
      .from('meetings')
      .select(`
        id, title, status,
        owner:owner_user_id (id, display_name)
      `)
      .eq('id', id)
      .single(),

    supabase
      .from('meeting_attendees')
      .select('id, user_id, external_name, user:user_id (id, display_name)')
      .eq('meeting_id', id),
  ])

  const meeting = meetingResult.data
  if (!meeting) notFound()

  const owner = Array.isArray(meeting.owner) ? meeting.owner[0] : meeting.owner

  const allowedStatuses = ['scheduled', 'open', 'draft']
  if (!allowedStatuses.includes(meeting.status)) redirect(`/meetings/${id}`)

  if (!canManageTranscript(user.role, owner?.id ?? null, user.id, meeting.status)) {
    redirect(`/meetings/${id}`)
  }

  const attendees = (attendeesResult.data ?? []) as unknown as MeetingAttendee[]

  const attendeeNames = attendees
    .map((a) => {
      const u = Array.isArray(a.user) ? a.user[0] : a.user
      return u?.display_name ?? a.external_name ?? null
    })
    .filter((name): name is string => !!name)

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/meetings" className="hover:text-kk-ink transition-colors">← Meetings</Link>
          <span>/</span>
          <Link href={`/meetings/${id}`} className="hover:text-kk-ink transition-colors">{meeting.title}</Link>
          <span>/</span>
          <span className="text-kk-ink">Record</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Record in person</h1>
      </div>

      <RecordingClient
        meetingId={id}
        meetingTitle={meeting.title}
        attendeeNames={attendeeNames}
      />
    </div>
  )
}
