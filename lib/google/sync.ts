/**
 * lib/google/sync.ts
 *
 * Core Calendar sync logic that can be called from both server actions
 * (lib/actions/google.ts) and other server actions (lib/actions/meetings.ts).
 *
 * These are NOT server actions — they are regular async functions importable
 * from any server-side module.  They access the database via the service
 * client and never return token values.
 *
 * Credential routing
 * ──────────────────
 * ALL Calendar writes for the KK - Upper Management calendar use the
 * designated SYSTEM management-calendar writer, identified by the
 * GOOGLE_CALENDAR_WRITER_USER_ID environment variable.
 *
 * Individual Kockpit users (e.g. Lydia) do NOT need personal Google Calendar
 * write permission.  Kockpit's own permission system is the sole gate for
 * who may create/edit/resync meetings.
 *
 *   Manager creates / edits meeting in Kockpit
 *   → Kockpit verifies Kockpit permissions
 *   → SYSTEM management-calendar writer writes event to Google Calendar
 *   → NOT the acting user's personal OAuth credential
 *
 * calendar_synced_by_user_id stores the system writer's Kockpit user ID
 * on each successful sync so that the stored reference reflects the
 * credential that actually owns the Calendar event.  Existing meetings
 * that store an individual's user ID will have that field updated on the
 * next successful resync.
 *
 * Google Meet conference resolution
 * ──────────────────────────────────
 * After a successful Calendar sync, if the event has a Meet conference (new
 * or existing), the 10-letter meeting code is resolved to the permanent
 * meet_space_name via the Meet spaces.get API and stored in the meetings row.
 *
 * If conference generation is still pending (Google's async creation has not
 * finished), the Calendar event is preserved and a meetWarning is returned.
 * The next sync will retry Meet resolution automatically.
 */

import { createServiceClient } from '@/lib/supabase/server'
import {
  getManagementCalendarClient,
  getManagementCalendarWriterUserId,
  hasMeetScope,
} from '@/lib/google/auth'
import { syncEventToCalendar, buildCalendarEventId } from '@/lib/google/calendar'
import { getMeetSpaceName, ensureMeetAutoTranscription } from '@/lib/google/meet'

// ─── Types ────────────────────────────────────────────────────────────────

export type SyncResult =
  | {
      ok: true
      eventId: string
      /** Non-empty when Calendar sync succeeded but Meet setup is not yet complete. */
      meetWarning?: string
    }
  | { ok: false; error: string; permissionDenied?: boolean }

// ─── System-credential sync ───────────────────────────────────────────────

/**
 * Syncs a meeting to Google Calendar using the SYSTEM management-calendar
 * writer credential (GOOGLE_CALENDAR_WRITER_USER_ID), NOT the acting user's
 * personal OAuth credential.
 *
 * Called:
 *   - When a meeting is first created with a scheduled time.
 *   - When an authorised editor clicks "Send to Google Calendar" or "Resync".
 *   - Automatically when scheduling, location, or attendees change.
 *
 * On success, persists the system writer's user ID as calendar_synced_by_user_id
 * so the stored reference accurately reflects which account owns the Calendar event.
 *
 * After a successful Calendar sync, attempts to resolve the Google Meet space
 * name and stores it in meet_space_name.  If Meet resolution is still pending,
 * returns a meetWarning; the Calendar event is preserved regardless.
 *
 * Does NOT throw — all errors are captured and returned in the result.
 *
 * @param meetingId    - Kockpit meeting UUID
 * @param _actorUserId - Kockpit user ID of the person who triggered this sync
 *                       (used only for context; credentials come from the system writer)
 */
export async function syncMeetingToCalendarForUser(
  meetingId: string,
  _actorUserId?: string | null,
): Promise<SyncResult> {
  const serviceClient = createServiceClient()

  const [meetingResult, attendeesResult] = await Promise.all([
    serviceClient
      .from('meetings')
      .select('id, title, scheduled_start, scheduled_end, location, meet_space_name, project:project_id (title)')
      .eq('id', meetingId)
      .single(),
    serviceClient
      .from('meeting_attendees')
      .select('user_id, external_email, user:user_id (email)')
      .eq('meeting_id', meetingId),
  ])

  const meeting = meetingResult.data
  if (!meeting) return { ok: false, error: 'Meeting not found.' }

  if (!meeting.scheduled_start || !meeting.scheduled_end) {
    return {
      ok: false,
      error: 'Meeting must have a scheduled start and end time before syncing to Calendar.',
    }
  }

  // ── Resolve system management-calendar credential ─────────────────────────
  const oauthClient = await getManagementCalendarClient()
  if (!oauthClient) {
    const writerUserId = getManagementCalendarWriterUserId()
    const error = writerUserId
      ? 'Kockpit cannot write to the management calendar. ' +
        'The system Calendar connection needs attention — contact an admin.'
      : 'Kockpit Calendar sync is not configured. ' +
        'An admin must set GOOGLE_CALENDAR_WRITER_USER_ID and connect that account.'
    await serviceClient
      .from('meetings')
      .update({ calendar_sync_status: 'failed', calendar_sync_error: error })
      .eq('id', meetingId)
    return { ok: false, error }
  }

  const project = Array.isArray(meeting.project)
    ? meeting.project[0] ?? null
    : (meeting.project as { title: string } | null)

  const attendees = (attendeesResult.data ?? []).map((a) => {
    const u = Array.isArray(a.user) ? a.user[0] : (a.user as { email?: string } | null)
    return { email: u?.email ?? a.external_email }
  })

  // Mark pending before API call so a page refresh shows activity
  await serviceClient
    .from('meetings')
    .update({ calendar_sync_status: 'pending', calendar_sync_error: null })
    .eq('id', meetingId)

  const currentMeetSpaceName = (meeting.meet_space_name as string | null) ?? null

  const result = await syncEventToCalendar(
    oauthClient,
    {
      id:              meeting.id,
      title:           meeting.title,
      scheduled_start: meeting.scheduled_start,
      scheduled_end:   meeting.scheduled_end,
      location:        (meeting.location as string | null) ?? null,
    },
    attendees,
    project,
    currentMeetSpaceName,
  )

  if (!result.ok) {
    await serviceClient
      .from('meetings')
      .update({ calendar_sync_status: 'failed', calendar_sync_error: result.error })
      .eq('id', meetingId)
    return { ok: false, error: result.error, permissionDenied: result.permissionDenied }
  }

  // ── Calendar sync succeeded ───────────────────────────────────────────────
  // Store the system writer's user ID as the canonical credential owner.
  const systemWriterUserId = getManagementCalendarWriterUserId()

  const calendarPatch: Record<string, unknown> = {
    calendar_event_id:          result.eventId,
    calendar_event_url:         result.eventUrl ?? null,
    calendar_sync_status:       'synced',
    calendar_sync_error:        null,
    calendar_synced_at:         new Date().toISOString(),
    calendar_synced_by_user_id: systemWriterUserId,
  }

  let meetWarning: string | undefined

  // Determine the effective Meet space name after this sync
  let effectiveSpaceName: string | null = currentMeetSpaceName

  if (result.conferenceCode && currentMeetSpaceName === null) {
    // New conference created or existing conference adopted — resolve permanent space name
    const spaceName = await getMeetSpaceName(oauthClient, result.conferenceCode)
    if (spaceName) {
      calendarPatch.meet_space_name = spaceName
      effectiveSpaceName = spaceName
    } else {
      meetWarning =
        'Google Meet conference was created but space details could not be retrieved yet. ' +
        'Re-sync this meeting to complete the setup.'
      effectiveSpaceName = null
    }
  } else if (result.meetConferenceStatus === 'pending') {
    meetWarning =
      'Google Meet is still being prepared. ' +
      'Re-sync this meeting in a minute to complete the setup.'
    effectiveSpaceName = null
  }

  // ── Auto-transcription configuration ─────────────────────────────────────
  if (effectiveSpaceName && !meetWarning) {
    const scopeString =
      typeof oauthClient.credentials.scope === 'string'
        ? oauthClient.credentials.scope
        : ''
    const systemScopes = scopeString.split(' ').filter(Boolean)

    if (hasMeetScope(systemScopes)) {
      const transcriptionResult = await ensureMeetAutoTranscription(oauthClient, effectiveSpaceName)
      if (transcriptionResult === 'permission_denied') {
        meetWarning =
          'Google Meet created, but auto-transcription could not be configured — ' +
          'the system Calendar account needs meetings.space.settings permission.'
      } else if (transcriptionResult === 'error') {
        meetWarning =
          'Google Meet created. Auto-transcription configuration failed — ' +
          'try re-syncing this meeting.'
      }
      // 'enabled' and 'already_enabled' are both success states — no warning
    } else {
      meetWarning =
        'Google Meet created. The system Calendar account needs Google Meet scope ' +
        '(meetings.space.settings + meetings.space.readonly) for automatic transcription.'
    }
  }

  await serviceClient
    .from('meetings')
    .update(calendarPatch)
    .eq('id', meetingId)

  return { ok: true, eventId: result.eventId, meetWarning }
}

// ─── Automatic resync ─────────────────────────────────────────────────────

/**
 * Re-syncs a meeting that already has a Calendar event, using the SYSTEM
 * management-calendar credential.
 *
 * Used for automatic syncs triggered by scheduling, location, or attendee
 * changes — never uses any individual user's credential.
 *
 * Existing meetings where calendar_synced_by_user_id points to an individual
 * user are safe: the next successful resync updates that field to the system
 * writer's user ID without creating a duplicate event (event IDs are
 * deterministic from the meeting UUID).
 *
 * Returns { ok: true, eventId: '' } (no-op) if no Calendar event is linked.
 */
export async function resyncMeetingCalendar(meetingId: string): Promise<SyncResult> {
  const serviceClient = createServiceClient()
  const { data: row } = await serviceClient
    .from('meetings')
    .select('calendar_event_id')
    .eq('id', meetingId)
    .single()

  if (!row?.calendar_event_id) return { ok: true, eventId: '' }

  // All resyncs use the system management-calendar writer
  return syncMeetingToCalendarForUser(meetingId)
}


export { buildCalendarEventId }
