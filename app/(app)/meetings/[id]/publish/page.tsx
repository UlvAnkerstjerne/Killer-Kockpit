import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditMeeting } from '@/lib/permissions'
import ReviewPanel from './ReviewPanel'

export const dynamic = 'force-dynamic'

export default async function PublishMeetingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [user, { id }] = await Promise.all([getCurrentUser(), params])
  if (!user) return null

  const supabase = await createClient()

  const [meetingResult, outcomesResult, usersResult, projectsResult] = await Promise.all([
    supabase
      .from('meetings')
      .select(`
        id, title, status, working_notes,
        owner:owner_user_id (id, display_name)
      `)
      .eq('id', id)
      .single(),

    supabase
      .from('meeting_outcomes')
      .select('id, kind, title, payload_json, sort_order, ai_draft_id')
      .eq('meeting_id', id)
      .eq('status', 'proposed')
      .order('sort_order'),

    supabase
      .from('app_users')
      .select('id, display_name')
      .eq('active', true)
      .order('display_name'),

    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .in('status', ['planned', 'active', 'at_risk', 'blocked'])
      .order('title'),
  ])

  const meeting = meetingResult.data
  if (!meeting) notFound()

  const owner = Array.isArray(meeting.owner) ? meeting.owner[0] : meeting.owner

  if (meeting.status !== 'draft') redirect(`/meetings/${id}`)
  if (!canEditMeeting(user.role, owner?.id ?? null, user.id)) redirect(`/meetings/${id}`)

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/meetings" className="hover:text-kk-ink transition-colors">Meetings</Link>
          <span>/</span>
          <Link href={`/meetings/${id}`} className="hover:text-kk-ink transition-colors">{meeting.title}</Link>
          <span>/</span>
          <span className="text-kk-ink">Publish</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Review & Publish</h1>
        <p className="text-sm text-kk-muted mt-1">
          Review and correct outcomes and notes before publishing. Changes here are saved immediately
          but nothing becomes institutional history until you click Publish.
        </p>
      </div>

      <ReviewPanel
        meetingId={id}
        initialNotes={meeting.working_notes ?? ''}
        initialOutcomes={outcomesResult.data ?? []}
        allUsers={usersResult.data ?? []}
        allProjects={projectsResult.data ?? []}
      />
    </div>
  )
}
