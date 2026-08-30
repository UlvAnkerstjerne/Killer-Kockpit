/**
 * Tests for lib/google/transcripts.ts
 *
 * Coverage:
 *   matchConferenceRecord    — pure function; window matching, ambiguity, no-scheduled-start
 *   assembleTranscript       — pure function; sorting, speaker merging, word/speaker counts
 *   fetchGoogleMeetTranscript — API retrieval chain with mocked googleapis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchConferenceRecord, assembleTranscript } from '@/lib/google/transcripts'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const googleMocks = vi.hoisted(() => {
  const mockConferenceRecordsList = vi.fn()
  const mockTranscriptsList       = vi.fn()
  const mockParticipantsList      = vi.fn()
  const mockEntriesList           = vi.fn()
  return {
    mockConferenceRecordsList,
    mockTranscriptsList,
    mockParticipantsList,
    mockEntriesList,
  }
})

vi.mock('googleapis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('googleapis')>()
  return {
    ...actual,
    google: {
      ...actual.google,
      meet: vi.fn().mockReturnValue({
        conferenceRecords: {
          list:        googleMocks.mockConferenceRecordsList,
          transcripts: {
            list:    googleMocks.mockTranscriptsList,
            entries: { list: googleMocks.mockEntriesList },
          },
          participants: { list: googleMocks.mockParticipantsList },
        },
      }),
    },
  }
})

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_SCHEDULED  = '2026-08-30T10:00:00Z'
const WINDOW_BEFORE_MS = 4  * 60 * 60 * 1000
const WINDOW_AFTER_MS  = 12 * 60 * 60 * 1000

function msFromBase(offsetMs: number): string {
  return new Date(new Date(BASE_SCHEDULED).getTime() + offsetMs).toISOString()
}

const MEETING = { scheduled_start: BASE_SCHEDULED, scheduled_end: null }

const RECORD = {
  name:      'conferenceRecords/rec-1',
  startTime: BASE_SCHEDULED,
  endTime:   '2026-08-30T11:00:00Z',
}

const TRANSCRIPT = {
  name:  'conferenceRecords/rec-1/transcripts/tr-1',
  state: 'FILE_GENERATED',
}

const PARTICIPANT = {
  name:         'conferenceRecords/rec-1/participants/p-1',
  signedinUser: { displayName: 'Alice Smith' },
}

const ENTRY = {
  participant: 'conferenceRecords/rec-1/participants/p-1',
  text:        'Hello world',
  startTime:   '2026-08-30T10:05:00Z',
  languageCode: 'en-US',
}

// ─── matchConferenceRecord ─────────────────────────────────────────────────────

describe('matchConferenceRecord', () => {
  it('returns none when records array is empty', () => {
    expect(matchConferenceRecord([], MEETING)).toBe('none')
  })

  it('returns none when all records have no endTime (still running)', () => {
    const rec = { name: 'cr/1', startTime: BASE_SCHEDULED, endTime: null }
    expect(matchConferenceRecord([rec], MEETING)).toBe('none')
  })

  // ── Case 1: exactly one completed record — accepted unconditionally ─────

  it('accepts sole completed record when it starts at the scheduled time', () => {
    const rec = { name: 'cr/1', startTime: msFromBase(0), endTime: msFromBase(3_600_000) }
    expect(matchConferenceRecord([rec], MEETING)).toBe(rec)
  })

  it('accepts sole completed record that started MORE than 4h before the scheduled time (real-world early-start)', () => {
    // Regression: meeting scheduled at 15:00, conference ran at 09:00 (6h early).
    // Under the old logic this returned 'none'; it must now return the record.
    const rec = {
      name:      'cr/1',
      startTime: msFromBase(-6 * 60 * 60 * 1000),  // 6h before schedule
      endTime:   msFromBase(-5 * 60 * 60 * 1000),
    }
    expect(matchConferenceRecord([rec], MEETING)).toBe(rec)
  })

  it('accepts sole completed record that started MORE than 12h after the scheduled time', () => {
    const rec = {
      name:      'cr/1',
      startTime: msFromBase(WINDOW_AFTER_MS + 3_600_000),  // 13h after schedule
      endTime:   msFromBase(WINDOW_AFTER_MS + 7_200_000),
    }
    expect(matchConferenceRecord([rec], MEETING)).toBe(rec)
  })

  it('accepts sole completed record that has a null startTime', () => {
    // With a unique Meet space the sole completed record is always the right one
    const rec = { name: 'cr/1', startTime: null, endTime: msFromBase(3_600_000) }
    expect(matchConferenceRecord([rec], MEETING)).toBe(rec)
  })

  it('accepts sole completed record when meeting has no scheduled_start', () => {
    const rec = { name: 'cr/1', startTime: BASE_SCHEDULED, endTime: msFromBase(3_600_000) }
    expect(
      matchConferenceRecord([rec], { scheduled_start: null, scheduled_end: null })
    ).toBe(rec)
  })

  it('handles mix of completed and still-running records — accepts the sole completed one', () => {
    const running   = { name: 'cr/1', startTime: msFromBase(0), endTime: null }
    const completed = { name: 'cr/2', startTime: msFromBase(0), endTime: msFromBase(3_600_000) }
    expect(matchConferenceRecord([running, completed], MEETING)).toBe(completed)
  })

  // ── Case 3: multiple completed records — schedule used to disambiguate ──

  it('returns ambiguous when two completed records both fall within the schedule window', () => {
    const rec1 = { name: 'cr/1', startTime: msFromBase(0),         endTime: msFromBase(3_600_000) }
    const rec2 = { name: 'cr/2', startTime: msFromBase(7_200_000), endTime: msFromBase(10_800_000) }
    expect(matchConferenceRecord([rec1, rec2], MEETING)).toBe('ambiguous')
  })

  it('selects the single plausible record when multiple exist and exactly one matches the schedule window', () => {
    const inWindow  = { name: 'cr/2', startTime: msFromBase(0),                            endTime: msFromBase(3_600_000) }
    const oldRecord = { name: 'cr/1', startTime: msFromBase(-WINDOW_BEFORE_MS - 86_400_000), endTime: msFromBase(-WINDOW_BEFORE_MS - 82_800_000) }
    expect(matchConferenceRecord([oldRecord, inWindow], MEETING)).toBe(inWindow)
  })

  it('returns ambiguous (safe fail) when multiple records exist but none match the schedule window', () => {
    // Both records are far outside the plausible window — cannot confidently pick one
    const rec1 = { name: 'cr/1', startTime: msFromBase(-WINDOW_BEFORE_MS - 86_400_000), endTime: msFromBase(-WINDOW_BEFORE_MS - 82_800_000) }
    const rec2 = { name: 'cr/2', startTime: msFromBase(WINDOW_AFTER_MS  + 86_400_000), endTime: msFromBase(WINDOW_AFTER_MS  + 90_000_000) }
    expect(matchConferenceRecord([rec1, rec2], MEETING)).toBe('ambiguous')
  })

  it('returns ambiguous when multiple records exist and meeting has no scheduled_start', () => {
    const rec1 = { name: 'cr/1', startTime: msFromBase(0),         endTime: msFromBase(3_600_000) }
    const rec2 = { name: 'cr/2', startTime: msFromBase(7_200_000), endTime: msFromBase(10_800_000) }
    expect(
      matchConferenceRecord([rec1, rec2], { scheduled_start: null, scheduled_end: null })
    ).toBe('ambiguous')
  })
})

// ─── assembleTranscript ───────────────────────────────────────────────────────

describe('assembleTranscript', () => {
  it('returns empty result for empty entries', () => {
    const result = assembleTranscript([], new Map())
    expect(result.text).toBe('')
    expect(result.wordCount).toBe(0)
    expect(result.speakerCount).toBe(0)
    expect(result.languageCode).toBeNull()
  })

  it('formats a single entry as "Speaker: text"', () => {
    const entries = [{ participant: 'p/1', text: 'Hello world', startTime: '2026-08-30T10:00:00Z' }]
    const names   = new Map([['p/1', 'Alice']])
    expect(assembleTranscript(entries, names).text).toBe('Alice: Hello world')
  })

  it('separates different speakers with a blank line', () => {
    const entries = [
      { participant: 'p/1', text: 'Hello', startTime: '2026-08-30T10:00:00Z' },
      { participant: 'p/2', text: 'World', startTime: '2026-08-30T10:00:05Z' },
    ]
    const names = new Map([['p/1', 'Alice'], ['p/2', 'Bob']])
    expect(assembleTranscript(entries, names).text).toBe('Alice: Hello\n\nBob: World')
  })

  it('merges consecutive same-speaker turns', () => {
    const entries = [
      { participant: 'p/1', text: 'Part one.', startTime: '2026-08-30T10:00:00Z' },
      { participant: 'p/1', text: 'Part two.', startTime: '2026-08-30T10:00:05Z' },
    ]
    const names = new Map([['p/1', 'Alice']])
    expect(assembleTranscript(entries, names).text).toBe('Alice: Part one. Part two.')
  })

  it('does NOT merge non-consecutive same-speaker turns (A–B–A pattern)', () => {
    const entries = [
      { participant: 'p/1', text: 'Hello',   startTime: '2026-08-30T10:00:00Z' },
      { participant: 'p/2', text: 'Hi',      startTime: '2026-08-30T10:00:05Z' },
      { participant: 'p/1', text: 'Goodbye', startTime: '2026-08-30T10:00:10Z' },
    ]
    const names = new Map([['p/1', 'Alice'], ['p/2', 'Bob']])
    const { text } = assembleTranscript(entries, names)
    expect(text).toBe('Alice: Hello\n\nBob: Hi\n\nAlice: Goodbye')
  })

  it('sorts entries chronologically before merging', () => {
    const entries = [
      { participant: 'p/1', text: 'Second', startTime: '2026-08-30T10:00:10Z' },
      { participant: 'p/1', text: 'First',  startTime: '2026-08-30T10:00:00Z' },
    ]
    const names = new Map([['p/1', 'Alice']])
    // Sorted and merged into one turn
    expect(assembleTranscript(entries, names).text).toBe('Alice: First Second')
  })

  it('places null-startTime entries after timed entries', () => {
    const entries = [
      { participant: 'p/1', text: 'Late',  startTime: null },
      { participant: 'p/2', text: 'First', startTime: '2026-08-30T10:00:00Z' },
    ]
    const names = new Map([['p/1', 'Alice'], ['p/2', 'Bob']])
    const { text } = assembleTranscript(entries, names)
    expect(text.startsWith('Bob: First')).toBe(true)
  })

  it('uses "Unknown speaker" for unmapped participant resource names', () => {
    const entries = [{ participant: 'p/nobody', text: 'Hello', startTime: '2026-08-30T10:00:00Z' }]
    expect(assembleTranscript(entries, new Map()).text).toMatch(/^Unknown speaker:/)
  })

  it('counts distinct speakers correctly', () => {
    const entries = [
      { participant: 'p/1', text: 'Hi',  startTime: '2026-08-30T10:00:00Z' },
      { participant: 'p/2', text: 'Hey', startTime: '2026-08-30T10:00:05Z' },
      { participant: 'p/1', text: 'Bye', startTime: '2026-08-30T10:00:10Z' },
    ]
    const names = new Map([['p/1', 'Alice'], ['p/2', 'Bob']])
    expect(assembleTranscript(entries, names).speakerCount).toBe(2)
  })

  it('counts words in the assembled output', () => {
    const entries = [
      { participant: 'p/1', text: 'one two three', startTime: '2026-08-30T10:00:00Z' },
    ]
    const names = new Map([['p/1', 'Alice']])
    // "Alice: one two three" → 4 words
    expect(assembleTranscript(entries, names).wordCount).toBe(4)
  })

  it('skips entries with empty or whitespace-only text', () => {
    const entries = [
      { participant: 'p/1', text: '',    startTime: '2026-08-30T10:00:00Z' },
      { participant: 'p/1', text: '   ', startTime: '2026-08-30T10:00:01Z' },
      { participant: 'p/1', text: 'Hi',  startTime: '2026-08-30T10:00:02Z' },
    ]
    const names = new Map([['p/1', 'Alice']])
    expect(assembleTranscript(entries, names).text).toBe('Alice: Hi')
  })
})

// ─── fetchGoogleMeetTranscript ────────────────────────────────────────────────

describe('fetchGoogleMeetTranscript', () => {
  const SPACE_NAME = 'spaces/TestSpace'

  beforeEach(() => {
    vi.clearAllMocks()
    // Default happy-path responses
    googleMocks.mockConferenceRecordsList.mockResolvedValue({
      data: { conferenceRecords: [RECORD] },
    })
    googleMocks.mockTranscriptsList.mockResolvedValue({
      data: { transcripts: [TRANSCRIPT] },
    })
    googleMocks.mockParticipantsList.mockResolvedValue({
      data: { participants: [PARTICIPANT], nextPageToken: null },
    })
    googleMocks.mockEntriesList.mockResolvedValue({
      data: { transcriptEntries: [ENTRY], nextPageToken: null },
    })
  })

  // ── Conference record matching ────────────────────────────────────────────

  it('returns not_found when no conference records exist', async () => {
    googleMocks.mockConferenceRecordsList.mockResolvedValue({ data: { conferenceRecords: [] } })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'not_found' })
  })

  it('accepts sole conference record even when it falls outside the schedule time window', async () => {
    // Regression: the old code rejected the only record when it fell >4h before schedule.
    // Since meet_space_name is unique per meeting, the sole record must be accepted.
    googleMocks.mockConferenceRecordsList.mockResolvedValue({
      data: {
        conferenceRecords: [{
          name:      'cr/1',
          startTime: msFromBase(-6 * 60 * 60 * 1000),  // 6h before schedule
          endTime:   '2026-08-30T05:00:00Z',
        }],
      },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    // Should proceed to transcript retrieval (ok: true), not be rejected
    expect(result.ok).toBe(true)
  })

  it('returns not_found when only record has no endTime (still running)', async () => {
    googleMocks.mockConferenceRecordsList.mockResolvedValue({
      data: { conferenceRecords: [{ name: 'cr/1', startTime: BASE_SCHEDULED, endTime: null }] },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'not_found' })
  })

  it('returns ambiguous when multiple completed records fall in window', async () => {
    googleMocks.mockConferenceRecordsList.mockResolvedValue({
      data: {
        conferenceRecords: [
          { name: 'cr/1', startTime: msFromBase(0),         endTime: '2026-08-30T10:30:00Z' },
          { name: 'cr/2', startTime: msFromBase(7_200_000), endTime: '2026-08-30T13:00:00Z' },
        ],
      },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'ambiguous', plausibleCount: 2 })
  })

  // ── Transcript states ─────────────────────────────────────────────────────

  it('returns not_found when no transcripts exist for the conference', async () => {
    googleMocks.mockTranscriptsList.mockResolvedValue({ data: { transcripts: [] } })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'not_found' })
  })

  it('returns processing when transcript is in ENDED state', async () => {
    googleMocks.mockTranscriptsList.mockResolvedValue({
      data: { transcripts: [{ name: 'cr/1/transcripts/tr-1', state: 'ENDED' }] },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'processing' })
  })

  it('returns processing when transcript is in STARTED state', async () => {
    googleMocks.mockTranscriptsList.mockResolvedValue({
      data: { transcripts: [{ name: 'cr/1/transcripts/tr-1', state: 'STARTED' }] },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'processing' })
  })

  it('returns processing and includes conferenceRecordName and transcriptName', async () => {
    googleMocks.mockTranscriptsList.mockResolvedValue({
      data: { transcripts: [{ name: 'cr/1/transcripts/tr-1', state: 'ENDED' }] },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    if (!result.ok && result.status === 'processing') {
      expect(result.conferenceRecordName).toBe(RECORD.name)
      expect(result.transcriptName).toBe('cr/1/transcripts/tr-1')
    }
  })

  it('returns not_found when transcript has no entries', async () => {
    googleMocks.mockEntriesList.mockResolvedValue({
      data: { transcriptEntries: [], nextPageToken: null },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'not_found' })
  })

  it('parses TranscriptEntry with real API shape — text is a plain string, not a texts array', async () => {
    // Regression: previous implementation expected texts:[{text:'...'}] (invented shape).
    // The real Google Meet API returns text:'...' (flat string on the entry).
    // Entries were silently skipped because e.texts was always undefined.
    googleMocks.mockEntriesList.mockResolvedValue({
      data: {
        transcriptEntries: [
          {
            name:         'conferenceRecords/rec-1/transcripts/tr-1/entries/e-1',
            participant:  PARTICIPANT.name,
            text:         'This is what Google actually returns.',
            startTime:    '2026-08-30T10:05:00Z',
            endTime:      '2026-08-30T10:05:10Z',
            languageCode: 'en-US',
          },
        ],
        nextPageToken: null,
      },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('This is what Google actually returns.')
    expect(result.metadata.entry_count).toBe(1)
  })

  it('uses the latest FILE_GENERATED transcript when multiple exist', async () => {
    googleMocks.mockTranscriptsList.mockResolvedValue({
      data: {
        transcripts: [
          { name: 'cr/1/transcripts/tr-1', state: 'FILE_GENERATED' },
          { name: 'cr/1/transcripts/tr-2', state: 'FILE_GENERATED' },
        ],
      },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transcriptResourceName).toBe('cr/1/transcripts/tr-2')
    }
  })

  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns ok with assembled transcript on happy path', async () => {
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.content).toBe('Alice Smith: Hello world')
    expect(result.transcriptResourceName).toBe(TRANSCRIPT.name)
    expect(result.conferenceRecordName).toBe(RECORD.name)
    expect(result.conferenceRecordStart).toBe(RECORD.startTime)
    expect(result.metadata.provider).toBe('google_meet')
    expect(result.metadata.meet_space_name).toBe(SPACE_NAME)
    expect(result.metadata.entry_count).toBe(1)
    expect(result.metadata.word_count).toBeGreaterThan(0)
    expect(result.metadata.speaker_count).toBe(1)
    expect(result.metadata.speakers).toHaveLength(1)
    expect(result.metadata.speakers[0].display_name).toBe('Alice Smith')
  })

  // ── Pagination ────────────────────────────────────────────────────────────

  it('paginates transcript entries across multiple pages', async () => {
    googleMocks.mockEntriesList
      .mockResolvedValueOnce({
        data: {
          transcriptEntries: [
            { participant: PARTICIPANT.name, text: 'Page one', startTime: '2026-08-30T10:01:00Z' },
          ],
          nextPageToken: 'PAGE2_TOKEN',
        },
      })
      .mockResolvedValueOnce({
        data: {
          transcriptEntries: [
            { participant: PARTICIPANT.name, text: 'Page two', startTime: '2026-08-30T10:02:00Z' },
          ],
          nextPageToken: null,
        },
      })

    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Consecutive same-speaker turns across pages are merged
    expect(result.content).toBe('Alice Smith: Page one Page two')
    expect(result.metadata.entry_count).toBe(2)
    expect(googleMocks.mockEntriesList).toHaveBeenCalledTimes(2)
  })

  it('paginates participant list across multiple pages', async () => {
    const PARTICIPANT_2 = {
      name:         'conferenceRecords/rec-1/participants/p-2',
      signedinUser: { displayName: 'Bob Jones' },
    }
    const ENTRY_2 = {
      participant: PARTICIPANT_2.name,
      text:        'Greetings',
      startTime:   '2026-08-30T10:06:00Z',
    }

    googleMocks.mockParticipantsList
      .mockResolvedValueOnce({ data: { participants: [PARTICIPANT], nextPageToken: 'P2_TOKEN' } })
      .mockResolvedValueOnce({ data: { participants: [PARTICIPANT_2], nextPageToken: null } })

    googleMocks.mockEntriesList.mockResolvedValue({
      data: { transcriptEntries: [ENTRY, ENTRY_2], nextPageToken: null },
    })

    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('Alice Smith: Hello world')
    expect(result.content).toContain('Bob Jones: Greetings')
    expect(result.metadata.speaker_count).toBe(2)
    expect(googleMocks.mockParticipantsList).toHaveBeenCalledTimes(2)
  })

  // ── Speaker resolution ────────────────────────────────────────────────────

  it('uses "Unknown speaker" for participants missing from participants list', async () => {
    googleMocks.mockParticipantsList.mockResolvedValue({
      data: { participants: [], nextPageToken: null },
    })
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.content).toMatch(/^Unknown speaker:/)
  })

  it('does not invent identity — uses display names from API verbatim', async () => {
    // Ensures we never do fuzzy matching to Kockpit user records
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.content).toContain('Alice Smith')
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns error with access-denied message on 403', async () => {
    googleMocks.mockConferenceRecordsList.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { code: 403 })
    )
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'error' })
    if (!result.ok && result.status === 'error') {
      expect(result.error).toMatch(/access was denied/i)
    }
  })

  it('returns error with access-denied message on 401', async () => {
    googleMocks.mockConferenceRecordsList.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { code: 401 })
    )
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'error' })
    if (!result.ok && result.status === 'error') {
      expect(result.error).toMatch(/access was denied/i)
    }
  })

  it('returns generic retrieval error on unexpected API failure', async () => {
    googleMocks.mockConferenceRecordsList.mockRejectedValue(new Error('Network timeout'))
    const { fetchGoogleMeetTranscript } = await import('@/lib/google/transcripts')
    const result = await fetchGoogleMeetTranscript({} as never, SPACE_NAME, MEETING)
    expect(result).toMatchObject({ ok: false, status: 'error' })
    if (!result.ok && result.status === 'error') {
      expect(result.error).toMatch(/failed to retrieve/i)
    }
  })
})
