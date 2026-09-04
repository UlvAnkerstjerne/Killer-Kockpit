import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditMeeting, canAssignToOthers, canManageDriveReferences, canReadTranscript } from '@/lib/permissions'
import { MeetingStatusBadge } from '@/components/ui/MeetingStatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import MeetingActions from './MeetingActions'
import EditMeetingPanel from './EditMeetingPanel'
import AgendaSection from './AgendaSection'
import WorkingNotesSection from './WorkingNotesSection'
import PublishedMinutesSection from './PublishedMinutesSection'
import OutcomesSection from './OutcomesSection'
import AttendeeSection from './AttendeeSection'
import CorrectionsSection from './CorrectionsSection'
import CalendarSection from './CalendarSection'
import RelatedFilesSection from '@/components/drive/RelatedFilesSection'
import LinkedEmailsSection from '@/components/ui/LinkedEmailsSection'
import TranscriptSection from './TranscriptSection'
import AiDraftSection from './AiDraftSection'
import { getGoogleConnectionStatus, hasDriveScope } from '@/lib/google/auth'
import { getEntityDriveFiles } from '@/lib/actions/drive'
import { getEntityGmailSources } from '@/lib/actions/gmail'
import { getTranscriptSource } from '@/lib/actions/transcripts'
import { getLatestDraft } from '@/lib/actions/ai-drafts'
import { canManageTranscript, canGenerateDraft } from '@/lib/permissions'
import type { MeetingStatus, AgendaItem, MeetingOutcome, MeetingAttendee, MeetingMinutes } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [user, { id }] = await Promise.all([getCurrentUser(), params])
  if (!user) return null

  const supabase = await createClient()

  const [meetingResult, agendaResult, outcomesResult, attendeesResult, usersResult, correctionsResult, googleStatus, projectsResult, driveFiles, gmailSourcesResult, transcriptSource, latestDraft, minutesResult] = await Promise.all([
    supabase
      .from('meetings')
      .select(`
        id, title, status, context, working_notes, scheduled_start, scheduled_end,
        actual_start, actual_end, minutes_status, created_at,
        calendar_event_id, calendar_event_url, calendar_sync_status,
        calendar_sync_error, calendar_synced_at, meet_space_name,
        owner:owner_user_id (id, display_name, email),
        project:project_id (id, title)
      `)
      .eq('id', id)
      .single(),

    supabase
      .from('agenda_items')
      .select('id, meeting_id, title, description, source_kind, related_entity_type, related_entity_id, sort_order, status, created_at')
      .eq('meeting_id', id)
      .order('sort_order'),

    supabase
      .from('meeting_outcomes')
      .select('id, meeting_id, kind, title, payload_json, status, proposed_by_user_id, published_entity_id, sort_order, created_at, updated_at')
      .eq('meeting_id', id)
      .neq('status', 'removed')
      .order('sort_order'),

    supabase
      .from('meeting_attendees')
      .select('id, meeting_id, user_id, external_name, external_email, user:user_id (id, display_name, email)')
      .eq('meeting_id', id),

    supabase
      .from('app_users')
      .select('id, display_name')
      .eq('active', true)
      .order('display_name'),

    supabase
      .from('meeting_corrections')
      .select('id, body, reason, author_id, created_at, author:author_id (display_name)')
      .eq('meeting_id', id)
      .order('created_at'),

    getGoogleConnectionStatus(user.id),

    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived")')
      .order('title'),

    getEntityDriveFiles('meeting', id),
    getEntityGmailSources('meeting', id),
    getTranscriptSource(id),
    getLatestDraft(id),

    // Canonical minutes: latest published version. May be null for legacy
    // meetings published before M5D (migration 014).
    supabase
      .from('meeting_minutes')
      .select('id, version, body, status, approved_by_user_id, approved_at, created_at, approver:approved_by_user_id (display_name)')
      .eq('meeting_id', id)
      .eq('status', 'published')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const meeting = meetingResult.data
  if (!meeting) notFound()

  const owner = Array.isArray(meeting.owner) ? meeting.owner[0] : meeting.owner
  const project = Array.isArray(meeting.project) ? meeting.project[0] : meeting.project
  const status = meeting.status as MeetingStatus
  const canEdit = canEditMeeting(user.role, owner?.id ?? null, user.id)
  const isEditable = status === 'open' || status === 'scheduled'
  const isActive = status !== 'published' && status !== 'cancelled'
  // Drive references are managed independently of meeting content — allowed on
  // published meetings but not cancelled ones.
  const canManageDriveRefs  = canManageDriveReferences(user.role, owner?.id ?? null, user.id, meeting.status)
  const driveEnabled        = googleStatus.connected && hasDriveScope(googleStatus.scopes)
  const canManageTranscriptFile = canManageTranscript(user.role, owner?.id ?? null, user.id, meeting.status)

  const agendaItems = (agendaResult.data ?? []) as AgendaItem[]
  const outcomes = (outcomesResult.data ?? []) as MeetingOutcome[]
  const attendees = (attendeesResult.data ?? []) as unknown as MeetingAttendee[]

  const isTranscriptAttendee  = attendees.some((a) => a.user_id === user.id)
  const canReadTranscriptFile = canReadTranscript(user.role, owner?.id ?? null, user.id, isTranscriptAttendee)
  const canGenerateDraftFile  = canGenerateDraft(user.role, owner?.id ?? null, user.id, meeting.status)
  // Canonical published minutes (null for legacy meetings pre-dating M5D)
  const canonicalMinutes = minutesResult.data as MeetingMinutes | null
  const gmailSources = gmailSourcesResult.data ?? []

  const corrections = (correctionsResult.data ?? []) as unknown as {
    id: string; body: string; reason: string | null; author_id: string | null;
    created_at: string; author: { display_name: string } | null
  }[]

  function formatDT(dt: string | null) {
    if (!dt) return null
    return new Date(dt).toLocaleString('en-GB', {
      timeZone: 'Europe/Copenhagen',
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
            <Link href="/meetings" className="hover:text-kk-ink transition-colors">Meetings</Link>
            <span>/</span>
            <span className="text-kk-ink">{meeting.title}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-kk-ink">{meeting.title}</h1>
            <MeetingStatusBadge status={status} />
          </div>
        </div>

        {status === 'draft' && canEdit && (
          <Link
            href={`/meetings/${id}/publish`}
            className="shrink-0 text-sm px-4 py-2 bg-kk-good-bg text-kk-good rounded-xl hover:opacity-90 transition-opacity font-medium"
          >
            Review & publish →
          </Link>
        )}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: main content */}
        <div className="col-span-2 space-y-6">
          {/* Agenda */}
          <AgendaSection
            meetingId={id}
            items={agendaItems}
            canEdit={canEdit}
            isEditable={isActive}
          />

          {/* Minutes — canonical (published) or editable (active) */}
          {status === 'published' ? (
            canonicalMinutes ? (
              // M5D canonical snapshot — the formal institutional record
              <PublishedMinutesSection
                body={canonicalMinutes.body}
                approvedAt={canonicalMinutes.approved_at}
                approverName={
                  (Array.isArray(canonicalMinutes.approver)
                    ? canonicalMinutes.approver[0]
                    : canonicalMinutes.approver)?.display_name ?? null
                }
              />
            ) : (
              // Legacy fallback: meeting published before M5D — no minutes row exists.
              // Display working_notes read-only; do not mutate the record.
              <div className="bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-kk-ink">Published Minutes</h2>
                  <span className="text-xs text-kk-muted">(legacy record)</span>
                </div>
                <div className="px-5 py-4">
                  {meeting.working_notes?.trim() ? (
                    <p className="text-sm text-kk-ink whitespace-pre-wrap">{meeting.working_notes}</p>
                  ) : (
                    <p className="text-sm text-kk-muted italic">No minutes were recorded for this meeting.</p>
                  )}
                </div>
              </div>
            )
          ) : (
            <WorkingNotesSection
              meetingId={id}
              initialNotes={meeting.working_notes ?? ''}
              isEditable={status === 'open' && canEdit}
            />
          )}

          {/* Proposed outcomes */}
          {(isActive || outcomes.some((o) => o.status === 'published')) && (
            <OutcomesSection
              meetingId={id}
              outcomes={outcomes}
              canEdit={canEdit}
              isEditable={isActive && (status === 'open' || status === 'draft')}
            />
          )}

          {/* Corrections (published meetings only) */}
          {status === 'published' && (
            <CorrectionsSection
              meetingId={id}
              corrections={corrections}
              canAdd={canEdit}
            />
          )}

          {/* Attendees */}
          <AttendeeSection
            meetingId={id}
            attendees={attendees}
            allUsers={usersResult.data ?? []}
            canEdit={canEdit && isActive}
          />

          {/* Audit history */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">History</h2>
            </div>
            <div className="px-5 py-2">
              <Suspense fallback={<div className="py-4 text-xs text-kk-muted">Loading history…</div>}>
                <AuditHistory entityType="meeting" entityId={id} />
              </Suspense>
            </div>
          </div>
        </div>

        {/* Right: info + actions */}
        <div className="space-y-4">
          {/* Meeting info */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 space-y-3">
            <div>
              <div className="text-xs text-kk-muted mb-0.5">Owner</div>
              <div className="text-sm font-medium text-kk-ink">{owner?.display_name || '—'}</div>
            </div>

            <div>
              <div className="text-xs text-kk-muted mb-0.5">Status</div>
              <MeetingStatusBadge status={status} />
            </div>

            {project && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Project</div>
                <Link href={`/projects/${project.id}`} className="text-sm text-kk-ink hover:underline">
                  {project.title}
                </Link>
              </div>
            )}

            {meeting.scheduled_start && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Scheduled</div>
                <div className="text-sm text-kk-ink">{formatDT(meeting.scheduled_start)}</div>
                {meeting.scheduled_end && (
                  <div className="text-xs text-kk-muted">to {formatDT(meeting.scheduled_end)}</div>
                )}
              </div>
            )}

            {meeting.actual_start && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Actual start</div>
                <div className="text-sm text-kk-ink">{formatDT(meeting.actual_start)}</div>
                {meeting.actual_end && (
                  <div className="text-xs text-kk-muted">ended {formatDT(meeting.actual_end)}</div>
                )}
              </div>
            )}

            {meeting.context && (
              <div className="border-t border-kk-line pt-3">
                <div className="text-xs text-kk-muted mb-0.5">Context</div>
                <p className="text-sm text-kk-ink whitespace-pre-wrap">{meeting.context}</p>
              </div>
            )}
          </div>

          {/* Edit meeting details */}
          {canEdit && isActive && (
            <EditMeetingPanel
              meetingId={id}
              initialTitle={meeting.title}
              initialStart={meeting.scheduled_start ?? null}
              initialEnd={meeting.scheduled_end ?? null}
              initialProjectId={project?.id ?? null}
              projects={projectsResult.data ?? []}
            />
          )}

          {/* Google Calendar */}
          {status !== 'cancelled' && (
            <CalendarSection
              meetingId={id}
              canEdit={canEdit && status !== 'published'}
              hasScheduledTime={!!(meeting.scheduled_start && meeting.scheduled_end)}
              googleStatus={googleStatus}
              calendarEventId={meeting.calendar_event_id}
              calendarEventUrl={meeting.calendar_event_url ?? null}
              calendarSyncStatus={(meeting.calendar_sync_status as 'synced' | 'failed' | 'pending' | null) ?? null}
              calendarSyncError={meeting.calendar_sync_error ?? null}
              calendarSyncedAt={meeting.calendar_synced_at ?? null}
              meetSpaceName={(meeting.meet_space_name as string | null) ?? null}
            />
          )}

          {/* Status actions */}
          {canEdit && (isActive || status === 'cancelled') && (
            <MeetingActions meetingId={id} status={status} canEdit={canEdit} />
          )}

          {/* Related Drive files */}
          <RelatedFilesSection
            entityType="meeting"
            entityId={id}
            initialFiles={driveFiles}
            canManage={canManageDriveRefs}
            driveEnabled={driveEnabled}
          />

          {/* Related emails */}
          <LinkedEmailsSection sources={gmailSources} />

          {/* Transcript */}
          <TranscriptSection
            meetingId={id}
            initialFile={transcriptSource}
            canManage={canManageTranscriptFile}
            canRead={canReadTranscriptFile}
            meetSpaceName={(meeting.meet_space_name as string | null) ?? null}
          />

          {/* AI Draft — only shown when there is a transcript or the user can generate */}
          {(transcriptSource || latestDraft) && (
            <AiDraftSection
              meetingId={id}
              canGenerate={canGenerateDraftFile}
              initialDraft={latestDraft}
              hasWorkingNotes={!!(meeting.working_notes?.trim())}
              meetingStatus={meeting.status}
            />
          )}
        </div>
      </div>
    </div>
  )
}
