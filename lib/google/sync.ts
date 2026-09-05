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
 * Calendar events are owned by the user who first pressed "Send to Google
 * Calendar".  Their user ID is persisted in calendar_synced_by_user_id.
 * All subsequent automatic syncs (scheduling changes, attendee changes,
 * cancellation) use that stored credential — not whichever user happened
 * to trigger the Kockpit mutation.  If that connection is gone, we write
 * an actionable error to the meeting row; any authorised editor can take
 * over by clicking "Send to Google Calendar" (patch-before-insert ensures
 * the existing Google event is updated, not duplicated).
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
import { getGoogleOAuth2Client, hasMeetScope } from '@/lib/google/auth'
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

// ─── User-triggered sync ──────────────────────────────────────────────────

/**
 * Syncs a meeting to Google Calendar using the specified user's credentials.
 * Called when a user explicitly clicks "Send to Google Calendar".
 * Persists the user as calendar_synced_by_user_id on success so that
 * subsequent automatic syncs use the same credential.
 *
 * After a successful Calendar sync, attempts to resolve the Google Meet space
 * name and stores it in meet_space_name.  If Meet resolution is still pending,
 * returns a meetWarning; the Calendar event is preserved regardless.
 *
 * Does NOT throw — all errors are captured and returned in the result.
 */
export async function syncMeetingToCalendarForUser(
  meetingId: string,
  userId: string
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

  const oauthClient = await getGoogleOAuth2Client(userId)
  if (!oauthClient) {
    return {
      ok: false,
      error: 'Google Calendar is not connected. Please connect in Settings → Google Calendar.',
    }
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
  // Attempt to resolve the Meet space name and update in the same write when possible.

  const calendarPatch: Record<string, unknown> = {
    calendar_event_id:          result.eventId,
    calendar_event_url:         result.eventUrl ?? null,
    calendar_sync_status:       'synced',
    calendar_sync_error:        null,
    calendar_synced_at:         new Date().toISOString(),
    calendar_synced_by_user_id: userId,
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
      // getMeetSpaceName logs the error; treat as retryable
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
  // Runs whenever we have a known Meet space — whether newly resolved or already
  // known from a previous sync.  Safe to repeat (ensureMeetAutoTranscription is
  // idempotent).  Never rolls back Calendar sync on failure.

  if (effectiveSpaceName && !meetWarning) {
    const scopeString =
      typeof oauthClient.credentials.scope === 'string'
        ? oauthClient.credentials.scope
        : ''
    const userScopes = scopeString.split(' ').filter(Boolean)

    if (hasMeetScope(userScopes)) {
      const transcriptionResult = await ensureMeetAutoTranscription(oauthClient, effectiveSpaceName)
      if (transcriptionResult === 'permission_denied') {
        meetWarning =
          'Google Meet created, but auto-transcription could not be configured — ' +
          'insufficient permissions on this Meet space.'
      } else if (transcriptionResult === 'error') {
        meetWarning =
          'Google Meet created. Auto-transcription configuration failed — ' +
          'try re-syncing this meeting.'
      }
      // 'enabled' and 'already_enabled' are both success states — no warning
    } else {
      meetWarning =
        'Google Meet created. Enable Google Meet in Settings → Google Workspace ' +
        'to configure automatic transcription.'
    }
  }

  await serviceClient
    .from('meetings')
    .update(calendarPatch)
    .eq('id', meetingId)

  return { ok: true, eventId: result.eventId, meetWarning }
}

// ─── Automatic resync (uses stored credential) ────────────────────────────

/**
 * Re-syncs a meeting that already has a Calendar event, using the credential
 * of the user stored in calendar_synced_by_user_id.
 *
 * Used for automatic syncs triggered by scheduling or attendee changes —
 * never uses the acting user's credential, which may not exist.
 *
 * Also completes Meet conference resolution for meetings where the previous
 * sync left meet_space_name null (e.g. conference was still pending).
 *
 * Returns { ok: true, eventId: '' } (no-op) if no Calendar event is linked.
 */
export async function resyncMeetingCalendar(meetingId: string): Promise<SyncResult> {
  const serviceClient = createServiceClient()
  const { data: row } = await serviceClient
    .from('meetings')
    .select('calendar_event_id, calendar_synced_by_user_id')
    .eq('id', meetingId)
    .single()

  if (!row?.calendar_event_id) return { ok: true, eventId: '' }

  const credentialUserId = row.calendar_synced_by_user_id
  if (!credentialUserId) {
    const error =
      'Google Calendar sync failed: no connection on record for this meeting. ' +
      'Open this meeting and click "Send to Google Calendar" to reconnect.'
    await serviceClient
      .from('meetings')
      .update({ calendar_sync_status: 'failed', calendar_sync_error: error })
      .eq('id', meetingId)
    return { ok: false, error }
  }

  const oauthClient = await getGoogleOAuth2Client(credentialUserId)
  if (!oauthClient) {
    const error =
      'Google Calendar sync failed: the connection used for this meeting has been ' +
      'disconnected. Any authorised editor can click "Send to Google Calendar" to take over.'
    await serviceClient
      .from('meetings')
      .update({ calendar_sync_status: 'failed', calendar_sync_error: error })
      .eq('id', meetingId)
    return { ok: false, error }
  }

  return syncMeetingToCalendarForUser(meetingId, credentialUserId)
}


export { buildCalendarEventId }
