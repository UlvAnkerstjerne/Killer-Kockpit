/**
 * lib/google/transcripts.ts
 *
 * Google Meet REST API v2 wrappers for transcript retrieval (M5E1-D).
 *
 * Responsibilities
 * ────────────────
 * • Find the conference record(s) for a given Meet space and match to a
 *   specific Kockpit meeting instance using time-based filtering.
 * • Retrieve the transcript resource and check its processing state.
 * • Fetch all transcript entries (paginated) and all participants.
 * • Assemble into a readable speaker-labelled transcript.
 *
 * This file contains NO database access and NO server-action semantics.
 * Storage is handled entirely by lib/actions/transcripts.ts.
 *
 * Required OAuth scope: meetings.space.readonly
 *
 * Key design decisions
 * ────────────────────
 * • Conference record matching: a conference record is "plausible" for a
 *   meeting if it ended AND its startTime falls within [-4h, +12h] of
 *   scheduled_start.  Multiple plausible records → 'ambiguous' (safe fail).
 * • Transcript selection: prefer FILE_GENERATED.  Multiple FILE_GENERATED
 *   transcripts → use the latest (by position in API list).
 * • Consecutive same-speaker turns are merged to avoid fragmented lines.
 * • Participant names come from signedinUser → anonymousUser → phoneUser →
 *   "Unknown speaker".  No fuzzy mapping, no Kockpit user identity inference.
 */

import { google } from 'googleapis'
import type { Auth } from 'googleapis'

// ─── Public types ─────────────────────────────────────────────────────────

export type FetchTranscriptResult =
  | {
      ok: true
      transcriptResourceName: string
      conferenceRecordName:   string
      conferenceRecordStart:  string | null  // used as occurred_at when storing
      content:                string
      metadata:               MeetTranscriptMetadata
    }
  | { ok: false; status: 'processing'; conferenceRecordName: string; transcriptName: string }
  | { ok: false; status: 'not_found'; reason: string }
  | { ok: false; status: 'ambiguous'; plausibleCount: number }
  | { ok: false; status: 'error'; error: string }

export interface MeetTranscriptMetadata {
  provider:                 'google_meet'
  meet_space_name:          string
  conference_record_name:   string
  transcript_resource_name: string
  transcript_state:         string
  language_code:            string | null
  entry_count:              number
  word_count:               number
  speaker_count:            number
  fetched_at:               string
  speakers: Array<{
    display_name:         string
    participant_resource: string
  }>
}

// ─── Internal types ───────────────────────────────────────────────────────

interface ConferenceRecord {
  name:      string
  startTime: string | null
  endTime:   string | null
}

interface RawEntry {
  participant: string   // resource name, e.g. "conferenceRecords/.../participants/..."
  text:        string
  startTime:   string | null
}

// ─── Conference record matching ────────────────────────────────────────────

// Generous window: conferences may start up to 4h early or 12h late.
const WINDOW_BEFORE_MS = 4  * 60 * 60 * 1000
const WINDOW_AFTER_MS  = 12 * 60 * 60 * 1000

/**
 * Selects the conference record that corresponds to this specific meeting.
 *
 * The three-case hierarchy mirrors the architecture: meet_space_name is a
 * per-meeting unique identifier, so the sole record on a space is always the
 * right one.  Schedule filtering only applies when there are multiple records
 * and we need to pick one.
 *
 * Case 1 — exactly ONE completed record on this space:
 *   Accept it unconditionally.  The user may have started the meeting early,
 *   late, or used the space for a quick test — the meet_space_name already
 *   scopes the result to this meeting; timing is irrelevant.
 *
 * Case 2 — ZERO completed records:
 *   Return 'none'.  The conference may still be running or may never have
 *   started.
 *
 * Case 3 — MULTIPLE completed records:
 *   Use scheduled_start + time window to pick the right one.
 *   Exactly one plausible match → return it.
 *   Zero or multiple plausible matches → 'ambiguous' (safe fail — do not
 *   silently attach the wrong transcript).
 *
 * Returns:
 *   ConferenceRecord — single unambiguous match
 *   'none'           — no completed record found
 *   'ambiguous'      — cannot confidently select one record; caller surfaces error
 *
 * Exported for unit testing.
 */
export function matchConferenceRecord(
  records: ConferenceRecord[],
  meeting: { scheduled_start: string | null; scheduled_end: string | null },
): ConferenceRecord | 'none' | 'ambiguous' {
  // Only consider records that have ended (endTime present)
  const completed = records.filter((r) => r.endTime != null)

  // Case 2: no completed session found
  if (completed.length === 0) return 'none'

  // Case 1: sole completed record — meet_space_name uniquely identifies this
  // meeting, so this must be the correct session regardless of start time
  if (completed.length === 1) return completed[0]

  // Case 3: multiple completed records — use schedule to disambiguate
  if (!meeting.scheduled_start) {
    // Cannot distinguish without a scheduled time — safe fail
    return 'ambiguous'
  }

  const scheduledMs = new Date(meeting.scheduled_start).getTime()

  const plausible = completed.filter((r) => {
    if (!r.startTime) return false
    const startMs = new Date(r.startTime).getTime()
    return (
      startMs >= scheduledMs - WINDOW_BEFORE_MS &&
      startMs <= scheduledMs + WINDOW_AFTER_MS
    )
  })

  if (plausible.length === 1) return plausible[0]

  // 0 or 2+ plausible — cannot confidently select; safe fail
  return 'ambiguous'
}

// ─── Transcript assembly ──────────────────────────────────────────────────

/**
 * Sorts entries chronologically, resolves participant names, merges
 * consecutive same-speaker turns, and returns a formatted transcript string.
 *
 * Example output:
 *   Adam Fullname: We need to finish the October plan before Friday.
 *
 *   Ulv Ankerstjerne: Fine. I'll handle Fisketorvet and Adam can do TikTok.
 *
 * Exported for unit testing.
 */
export function assembleTranscript(
  entries: RawEntry[],
  participantNames: Map<string, string>,
): {
  text:         string
  wordCount:    number
  speakerCount: number
  languageCode: string | null
} {
  if (entries.length === 0) {
    return { text: '', wordCount: 0, speakerCount: 0, languageCode: null }
  }

  // Sort chronologically (null startTime sorts to end)
  const sorted = [...entries].sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : Infinity
    const tb = b.startTime ? new Date(b.startTime).getTime() : Infinity
    return ta - tb
  })

  // Merge consecutive same-speaker turns
  type Turn = { speaker: string; text: string }
  const turns: Turn[] = []

  for (const entry of sorted) {
    const speaker = participantNames.get(entry.participant) ?? 'Unknown speaker'
    const text    = entry.text.trim()
    if (!text) continue

    const last = turns[turns.length - 1]
    if (last && last.speaker === speaker) {
      last.text = last.text + ' ' + text
    } else {
      turns.push({ speaker, text })
    }
  }

  const text         = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n\n')
  const wordCount    = text.split(/\s+/).filter(Boolean).length
  const speakerCount = new Set(turns.map((t) => t.speaker)).size

  return { text, wordCount, speakerCount, languageCode: null }
}

// ─── Main retrieval ───────────────────────────────────────────────────────

/**
 * Retrieves and assembles the Google Meet transcript for the given space.
 *
 * Full retrieval chain:
 *   meet_space_name
 *   → conferenceRecords.list (filter by space)
 *   → match to this meeting instance
 *   → transcripts.list (find FILE_GENERATED)
 *   → participants.list (for name resolution, paginated)
 *   → transcripts.entries.list (paginated)
 *   → assembleTranscript
 *
 * Never interacts with the Kockpit database.
 * Required scope: meetings.space.readonly
 */
export async function fetchGoogleMeetTranscript(
  client: Auth.OAuth2Client,
  meetSpaceName: string,
  meeting: { scheduled_start: string | null; scheduled_end: string | null },
): Promise<FetchTranscriptResult> {
  try {
    const meet = google.meet({ version: 'v2', auth: client })

    // ── 1. List conference records for this space ─────────────────────────
    const recordsResp = await meet.conferenceRecords.list({
      filter:   `space.name = "${meetSpaceName}"`,
      pageSize: 25,
    })

    const rawRecords = (recordsResp.data.conferenceRecords ?? []) as Array<{
      name?:      string | null
      startTime?: string | null
      endTime?:   string | null
    }>

    const records: ConferenceRecord[] = rawRecords
      .filter((r): r is typeof r & { name: string } => typeof r.name === 'string')
      .map((r) => ({
        name:      r.name,
        startTime: r.startTime ?? null,
        endTime:   r.endTime   ?? null,
      }))

    if (records.length === 0) {
      return {
        ok:     false,
        status: 'not_found',
        reason: 'No conference record was found for this meeting. The meeting may not have started yet, or the Meet space may not be linked correctly.',
      }
    }

    // ── 2. Match to this specific meeting instance ─────────────────────────
    const matchResult = matchConferenceRecord(records, meeting)

    if (matchResult === 'none') {
      return {
        ok:     false,
        status: 'not_found',
        reason: 'No completed Google Meet session was found for this meeting. The meeting may not have started yet.',
      }
    }

    if (matchResult === 'ambiguous') {
      return {
        ok:            false,
        status:        'ambiguous',
        plausibleCount: records.filter((r) => r.endTime != null).length,
      }
    }

    const conferenceRecord     = matchResult
    const conferenceRecordName = conferenceRecord.name

    // ── 3. List transcripts for this conference record ────────────────────
    const transcriptsResp = await meet.conferenceRecords.transcripts.list({
      parent:   conferenceRecordName,
      pageSize: 10,
    })

    const rawTranscripts = (transcriptsResp.data.transcripts ?? []) as Array<{
      name?:  string | null
      state?: string | null
    }>

    if (rawTranscripts.length === 0) {
      return {
        ok:     false,
        status: 'not_found',
        reason: 'No transcript was found for this conference. Transcription may not have been enabled for this meeting.',
      }
    }

    // Prefer FILE_GENERATED; if none, surface the most recent non-generated state
    const generated = rawTranscripts.filter((t) => t.state === 'FILE_GENERATED' && t.name)
    const ended     = rawTranscripts.filter((t) => t.state === 'ENDED' && t.name)

    if (generated.length === 0) {
      // ENDED = Google is still processing; STARTED = meeting not yet over
      const bestRaw   = ended[ended.length - 1] ?? rawTranscripts[rawTranscripts.length - 1]
      const transcriptName = bestRaw.name ?? `${conferenceRecordName}/transcripts/unknown`
      return {
        ok:                  false,
        status:              'processing',
        conferenceRecordName,
        transcriptName,
      }
    }

    // Use the latest FILE_GENERATED transcript
    const transcriptName = generated[generated.length - 1].name!

    // ── 4. Fetch participants (paginated) for name resolution ─────────────
    const participantNames = new Map<string, string>()
    let participantsToken: string | undefined

    do {
      const participantsResp = await meet.conferenceRecords.participants.list({
        parent:    conferenceRecordName,
        pageSize:  100,
        pageToken: participantsToken,
      })

      const rawParticipants = (participantsResp.data.participants ?? []) as Array<{
        name?:          string | null
        signedinUser?:  { displayName?: string | null } | null
        anonymousUser?: { displayName?: string | null } | null
        phoneUser?:     { displayName?: string | null } | null
      }>

      for (const p of rawParticipants) {
        if (!p.name) continue
        const displayName =
          p.signedinUser?.displayName  ||
          p.anonymousUser?.displayName ||
          p.phoneUser?.displayName     ||
          'Unknown speaker'
        participantNames.set(p.name, displayName)
      }

      participantsToken =
        (participantsResp.data.nextPageToken as string | undefined) ?? undefined
    } while (participantsToken)

    // ── 5. Fetch all transcript entries (paginated) ───────────────────────
    const rawEntries: RawEntry[] = []
    let entriesToken: string | undefined

    do {
      const entriesResp = await meet.conferenceRecords.transcripts.entries.list({
        parent:    transcriptName,
        pageSize:  100,
        pageToken: entriesToken,
      })

      const page = (entriesResp.data.transcriptEntries ?? []) as Array<{
        participant?:  string | null
        text?:         string | null   // TranscriptEntry.text is a plain string
        startTime?:    string | null
        languageCode?: string | null
      }>

      for (const e of page) {
        if (!e.participant) continue
        const text = (e.text ?? '').trim()
        if (!text) continue
        rawEntries.push({
          participant: e.participant,
          text,
          startTime:   e.startTime ?? null,
        })
      }

      entriesToken =
        (entriesResp.data.nextPageToken as string | undefined) ?? undefined
    } while (entriesToken)

    if (rawEntries.length === 0) {
      return {
        ok:     false,
        status: 'not_found',
        reason: 'The Google Meet transcript exists but contains no transcript entries.',
      }
    }

    // ── 6. Assemble transcript ────────────────────────────────────────────
    const { text, wordCount, speakerCount, languageCode } = assembleTranscript(
      rawEntries,
      participantNames,
    )

    const speakers = Array.from(participantNames.entries()).map(
      ([participant_resource, display_name]) => ({ display_name, participant_resource }),
    )

    const metadata: MeetTranscriptMetadata = {
      provider:                 'google_meet',
      meet_space_name:          meetSpaceName,
      conference_record_name:   conferenceRecordName,
      transcript_resource_name: transcriptName,
      transcript_state:         'FILE_GENERATED',
      language_code:            languageCode,
      entry_count:              rawEntries.length,
      word_count:               wordCount,
      speaker_count:            speakerCount,
      fetched_at:               new Date().toISOString(),
      speakers,
    }

    return {
      ok:                     true,
      transcriptResourceName: transcriptName,
      conferenceRecordName,
      conferenceRecordStart:  conferenceRecord.startTime,
      content:                text,
      metadata,
    }
  } catch (err) {
    const e      = err as Record<string, unknown>
    const resp   = e.response as Record<string, unknown> | undefined
    const status =
      typeof e.code === 'number'     ? e.code :
      typeof e.status === 'number'   ? e.status :
      typeof resp?.status === 'number' ? resp.status :
      undefined

    if (status === 401 || status === 403) {
      console.warn(
        '[google/transcripts] Access denied — status', status,
        'for space', meetSpaceName,
      )
      return {
        ok:     false,
        status: 'error',
        error:
          'Google Meet access was denied. Make sure the Google Meet scope is authorised in Settings → Google Workspace.',
      }
    }

    console.error(
      '[google/transcripts] fetchGoogleMeetTranscript failed for space', meetSpaceName,
      ':', (err as Error).message,
    )
    return {
      ok:     false,
      status: 'error',
      error:  'Failed to retrieve the Google Meet transcript. Please try again.',
    }
  }
}
