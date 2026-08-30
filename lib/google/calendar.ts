/**
 * lib/google/calendar.ts
 *
 * Typed wrappers around the Google Calendar v3 API.
 * All functions take an authenticated OAuth2Client and return a CalendarSyncResult
 * so callers can record failures without throwing.
 *
 * Event ID strategy
 * -----------------
 * We derive a deterministic Google Calendar event ID from the KK meeting UUID:
 *
 *   eventId = "kk" + uuid.replace(/-/g, "").toLowerCase()
 *
 * Example: "550e8400-e29b-41d4-a716-446655440000"
 *       →  "kk550e8400e29b41d4a716446655440000"  (34 chars)
 *
 * Google Calendar ID requirements:
 *   • 5–1024 characters
 *   • lowercase alphanumeric and hyphens only
 *   • must not start with a hyphen
 *
 * UUID hex chars (0–9, a–f) satisfy the alphanumeric requirement.
 * The "kk" prefix ensures it never starts with a hyphen and provides
 * a clear namespace. The same KK meeting always maps to the same Calendar
 * event, so patch/insert operations are idempotent.
 *
 * Privacy
 * -------
 * The Calendar event description contains only:
 *   • A link back to the KK meeting
 *   • The project name (if any)
 * It never includes working notes, published minutes, corrections,
 * or any other institutional content. Calendar is the scheduling layer;
 * KK is the meeting record.
 *
 * Google Meet conference creation
 * --------------------------------
 * When requestConference=true, buildCalendarEvent includes conferenceData.createRequest.
 * The requestId is the KK meeting UUID — stable and unique per meeting, ensuring
 * that retries never create a second conference.
 *
 * Conference generation is asynchronous. syncEventToCalendar inspects
 * createRequest.status in the response and polls for completion with a bounded
 * retry loop. The Calendar event is always preserved regardless of whether
 * Meet conference setup completes immediately.
 *
 * For existing events that already have a conference (conferenceId present in
 * the PATCH response), the existing conference is adopted — no new createRequest
 * is issued. Events without a conference get one added via a second PATCH.
 */

import { google } from 'googleapis'
import type { Auth, calendar_v3 } from 'googleapis'

const CALENDAR_ID = () => {
  const id = process.env.GOOGLE_MANAGEMENT_CALENDAR_ID
  if (!id) throw new Error('GOOGLE_MANAGEMENT_CALENDAR_ID environment variable is not set.')
  return id
}

const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL ?? 'https://kockpit.app'

// ─── Event ID ─────────────────────────────────────────────────────────────

/** Maps a KK meeting UUID to a deterministic Google Calendar event ID. */
export function buildCalendarEventId(meetingId: string): string {
  return 'kk' + meetingId.replace(/-/g, '').toLowerCase()
}

// ─── Event resource builder ───────────────────────────────────────────────

type AttendeeInput = { email?: string | null }
type MeetingInput = {
  id: string
  title: string
  scheduled_start: string
  scheduled_end: string
}
type ProjectInput = { title: string } | null

/**
 * Builds a Calendar event resource.
 *
 * @param requestConference - When true, includes conferenceData.createRequest so
 *   Google Calendar creates a fresh Google Meet conference. The KK meeting UUID
 *   is used as the requestId — idempotent across retries. Only set this for
 *   events that do not yet have a conference. Defaults to false.
 */
export function buildCalendarEvent(
  meeting: MeetingInput,
  attendees: AttendeeInput[],
  project: ProjectInput,
  requestConference = false,
): calendar_v3.Schema$Event {
  const descriptionLines = [
    `${APP_URL()}/meetings/${meeting.id}`,
    ...(project ? [`Project: ${project.title}`] : []),
    'Meeting managed in Killer Kockpit',
  ]

  const guestList = attendees
    .map((a) => a.email)
    .filter((e): e is string => Boolean(e))
    .map((email) => ({ email }))

  return {
    id:      buildCalendarEventId(meeting.id),
    summary: meeting.title,
    description: descriptionLines.join('\n'),
    start: { dateTime: meeting.scheduled_start, timeZone: 'Europe/Copenhagen' },
    end:   { dateTime: meeting.scheduled_end,   timeZone: 'Europe/Copenhagen' },
    ...(guestList.length > 0 ? { attendees: guestList } : {}),
    visibility:            'default',
    guestsCanModify:       false,
    guestsCanInviteOthers: false,
    ...(requestConference ? {
      conferenceData: {
        createRequest: {
          requestId:             meeting.id,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    } : {}),
  }
}

// ─── Result type ──────────────────────────────────────────────────────────

/**
 * meetConferenceStatus describes the state of the Google Meet conference
 * after a sync attempt:
 *
 *   success  — conference created (this sync) and conferenceCode is set
 *   existed  — conference was already present; conferenceCode extracted
 *   pending  — Google has not finished generating the conference yet;
 *               the Calendar event is valid but meet_space_name cannot be
 *               stored yet (caller should surface a retryable warning)
 *   failure  — Google reported a conference creation failure
 *   none     — no conference on this event and none was requested
 */
export type MeetConferenceStatus = 'success' | 'existed' | 'pending' | 'failure' | 'none'

export type CalendarSyncResult =
  | {
      ok: true
      eventId: string
      eventUrl: string | undefined
      /** 10-letter meeting code (e.g. "abc-mnop-xyz") when conference is ready. */
      conferenceCode: string | null
      meetConferenceStatus: MeetConferenceStatus
    }
  | { ok: false; error: string; permissionDenied?: boolean }

// ─── Conference helpers ───────────────────────────────────────────────────

/**
 * Extracts the Meet conference code (meeting code) from a Calendar event.
 * Returns null when no conference is attached.
 */
function extractConferenceCode(data: calendar_v3.Schema$Event): string | null {
  const cid = data.conferenceData?.conferenceId
  return typeof cid === 'string' && cid.length > 0 ? cid : null
}

/**
 * Interprets the conference state from a Calendar event response.
 *
 * Google Calendar may return:
 *   - An existing conference (conferenceId present, no createRequest status)
 *   - A pending createRequest (status = 'pending')
 *   - A succeeded createRequest (status = 'success')
 *   - A failed createRequest (status = 'failure')
 *   - No conference at all
 */
function interpretConferenceState(
  data: calendar_v3.Schema$Event,
  wasCreateRequested: boolean,
): { status: MeetConferenceStatus; code: string | null } {
  const code = extractConferenceCode(data)
  const statusCode = data.conferenceData?.createRequest?.status?.statusCode

  if (code && !statusCode) {
    // conferenceId present but no createRequest status → pre-existing conference
    return { status: 'existed', code }
  }
  if (statusCode === 'success' && code) {
    return { status: 'success', code }
  }
  if (statusCode === 'pending') {
    return { status: 'pending', code: null }
  }
  if (statusCode === 'failure') {
    return { status: 'failure', code: null }
  }
  if (wasCreateRequested) {
    // createRequest issued but no recognisable status in response; treat as pending
    return { status: 'pending', code: null }
  }
  return { status: 'none', code: null }
}

/**
 * Polls for Meet conference creation completion after a createRequest.
 * Re-fetches the same Calendar event with exponential backoff (500ms → 1s → 2s).
 * Returns the first non-pending result, or { status: 'pending' } if all attempts
 * are exhausted.
 *
 * IMPORTANT: never re-issues a createRequest; only calls events.get.
 */
async function pollForConferenceCode(
  cal: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
): Promise<{ status: 'success' | 'pending' | 'failure'; code: string | null }> {
  const delays = [500, 1000, 2000]
  for (const delay of delays) {
    await new Promise<void>((r) => setTimeout(r, delay))
    try {
      const { data } = await cal.events.get({
        calendarId,
        eventId,
        fields: 'conferenceData',
      })
      const code = extractConferenceCode(data)
      const statusCode = data.conferenceData?.createRequest?.status?.statusCode
      if (statusCode === 'success' && code) return { status: 'success', code }
      if (statusCode === 'failure')           return { status: 'failure', code: null }
      // still pending — continue
    } catch {
      // transient network error during poll; continue
    }
  }
  return { status: 'pending', code: null }
}

// ─── API calls ────────────────────────────────────────────────────────────

/**
 * Creates or updates the Calendar event for a meeting, including Meet
 * conference creation when appropriate.
 *
 * Conference strategy:
 *   1. Try events.patch — succeeds if the event already exists.
 *      - conferenceDataVersion=1 is always included so Google knows this app
 *        can handle conferenceData (required per Calendar API docs).
 *      - conferenceData body is intentionally OMITTED from the patch so the
 *        existing Meet link (if any) is not disturbed.
 *   2. Inspect the PATCH response for existing conferenceData:
 *      - conferenceId present → adopt the existing conference (no createRequest).
 *      - No conferenceId AND currentMeetSpaceName is null → this event has no
 *        Meet link; issue a second PATCH with conferenceData.createRequest to add one.
 *      - No conferenceId AND currentMeetSpaceName is set → inconsistent state;
 *        the KK DB says there should be a conference but Calendar disagrees.
 *        Return meetConferenceStatus='none' so the caller can investigate.
 *   3. If patch returns 404 → event absent on Google side → insert with
 *      conferenceData.createRequest and conferenceDataVersion=1.
 *   4. After insert or second PATCH with createRequest: inspect response status.
 *      - success → conference ready; return conferenceCode.
 *      - pending → poll events.get up to 3×; return final state.
 *      - failure → return meetConferenceStatus='failure'; Calendar event is still valid.
 *
 * @param currentMeetSpaceName - the value of meetings.meet_space_name in the KK
 *   database. Used to decide whether to request a new Meet conference on patch.
 *   Null means no conference is known to exist yet.
 */
export async function syncEventToCalendar(
  client: Auth.OAuth2Client,
  meeting: MeetingInput,
  attendees: AttendeeInput[],
  project: ProjectInput,
  currentMeetSpaceName: string | null = null,
): Promise<CalendarSyncResult> {
  const calendarId = CALENDAR_ID()
  const cal = google.calendar({ version: 'v3', auth: client })
  const eventId = buildCalendarEventId(meeting.id)

  // Build base event — no conferenceData (preserves existing conference on PATCH)
  const baseEvent = buildCalendarEvent(meeting, attendees, project, false)

  // ── Step 1: attempt PATCH of existing event ──────────────────────────────
  let patchData: calendar_v3.Schema$Event | null = null
  let insertFallback = false

  try {
    const { data } = await cal.events.patch({
      calendarId,
      eventId,
      requestBody: baseEvent,
      sendUpdates: 'all',
      conferenceDataVersion: 1,   // required to preserve/inspect conferenceData
    })
    patchData = data
  } catch (patchErr) {
    if (getErrorStatus(patchErr) === 404) {
      insertFallback = true
    } else {
      return toCalendarError(patchErr)
    }
  }

  // ── Step 2a: INSERT (new event) ───────────────────────────────────────────
  if (insertFallback) {
    const eventWithConference = buildCalendarEvent(meeting, attendees, project, true)
    try {
      const { data } = await cal.events.insert({
        calendarId,
        requestBody: eventWithConference,
        sendUpdates: 'all',
        conferenceDataVersion: 1,
      })
      const { status, code } = interpretConferenceState(data, true)
      if (status === 'pending') {
        const pollResult = await pollForConferenceCode(cal, calendarId, eventId)
        return {
          ok: true,
          eventId,
          eventUrl: data.htmlLink ?? undefined,
          conferenceCode: pollResult.code,
          meetConferenceStatus: pollResult.status,
        }
      }
      return {
        ok: true,
        eventId,
        eventUrl: data.htmlLink ?? undefined,
        conferenceCode: code,
        meetConferenceStatus: status,
      }
    } catch (insertErr) {
      return toCalendarError(insertErr)
    }
  }

  // ── Step 2b: PATCH succeeded — inspect conference state ──────────────────
  const { status: patchStatus, code: patchCode } = interpretConferenceState(patchData!, false)

  if (patchStatus === 'existed' || patchStatus === 'success') {
    // Conference already on this event — adopt it, no createRequest needed
    return {
      ok: true,
      eventId,
      eventUrl: patchData!.htmlLink ?? undefined,
      conferenceCode: patchCode,
      meetConferenceStatus: 'existed',
    }
  }

  if (patchStatus === 'none' && currentMeetSpaceName !== null) {
    // KK DB says there's a conference but Calendar disagrees. Preserve the
    // event as-is; caller can investigate.  Do not issue createRequest.
    return {
      ok: true,
      eventId,
      eventUrl: patchData!.htmlLink ?? undefined,
      conferenceCode: null,
      meetConferenceStatus: 'none',
    }
  }

  // No conference exists and none is recorded in KK → add one via second PATCH
  // (patchStatus === 'none' && currentMeetSpaceName === null)
  const eventWithConference = buildCalendarEvent(meeting, attendees, project, true)
  try {
    const { data } = await cal.events.patch({
      calendarId,
      eventId,
      requestBody: eventWithConference,
      sendUpdates: 'none',         // attendees already notified by the first patch
      conferenceDataVersion: 1,
    })
    const { status: addStatus, code: addCode } = interpretConferenceState(data, true)
    if (addStatus === 'pending') {
      const pollResult = await pollForConferenceCode(cal, calendarId, eventId)
      return {
        ok: true,
        eventId,
        eventUrl: patchData!.htmlLink ?? undefined,
        conferenceCode: pollResult.code,
        meetConferenceStatus: pollResult.status,
      }
    }
    return {
      ok: true,
      eventId,
      eventUrl: patchData!.htmlLink ?? undefined,
      conferenceCode: addCode,
      meetConferenceStatus: addStatus === 'existed' ? 'success' : addStatus,
    }
  } catch (addErr) {
    // Failed to add conference, but Calendar sync itself succeeded
    console.error('[calendar] Failed to add Meet conference to existing event:', getErrorMessage(addErr))
    return {
      ok: true,
      eventId,
      eventUrl: patchData!.htmlLink ?? undefined,
      conferenceCode: null,
      meetConferenceStatus: 'failure',
    }
  }
}

/**
 * Cancels (deletes) the Google Calendar event for a meeting.
 * Idempotent: 404 and 410 (already deleted) are treated as success.
 */
export async function cancelCalendarEvent(
  client: Auth.OAuth2Client,
  eventId: string
): Promise<{ ok: true } | { ok: false; error: string; permissionDenied?: boolean }> {
  const calendarId = CALENDAR_ID()
  const cal = google.calendar({ version: 'v3', auth: client })
  try {
    await cal.events.delete({ calendarId, eventId, sendUpdates: 'all' })
    return { ok: true }
  } catch (err) {
    const status = getErrorStatus(err)
    if (status === 404 || status === 410) {
      return { ok: true }
    }
    return toCalendarError(err)
  }
}

// ─── Error helpers ────────────────────────────────────────────────────────

function getErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.code === 'number') return e.code
  if (typeof e.status === 'number') return e.status
  const resp = e.response as Record<string, unknown> | undefined
  if (typeof resp?.status === 'number') return resp.status
  return undefined
}

function getErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err)
  const e = err as Record<string, unknown>
  if (typeof e.message === 'string') return e.message
  return 'Unknown Calendar API error'
}

function toCalendarError(err: unknown): CalendarSyncResult {
  const status = getErrorStatus(err)
  const message = getErrorMessage(err)
  const e = err as { errors?: { reason?: string }[] }

  if (status === 403) {
    const reason = e.errors?.[0]?.reason
    if (reason === 'forbidden' || reason === 'insufficientPermissions' || !reason) {
      return {
        ok: false,
        permissionDenied: true,
        error:
          'You do not have write access to the management calendar. ' +
          'Ask a Google Calendar admin to grant you "Make changes to events" permission on the shared calendar.',
      }
    }
    return { ok: false, error: `Calendar access denied: ${message}` }
  }

  if (status === 401) {
    return {
      ok: false,
      error: 'Google Calendar authorisation expired. Please reconnect in Settings → Google Calendar.',
    }
  }

  return { ok: false, error: `Calendar sync failed: ${message}` }
}
