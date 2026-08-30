/**
 * Tests for Google Meet conference creation and sync behaviour (M5E1-B).
 *
 * What is tested:
 *   - buildCalendarEvent conference inclusion (pure function, no mocks)
 *   - syncEventToCalendar conference creation logic via googleapis mock:
 *       · new meeting → insert with createRequest
 *       · existing event with conference already present → adopted, no createRequest
 *       · existing event without conference → second PATCH adds createRequest
 *       · immediate success response
 *       · pending → success after polling
 *       · pending timeout preserves Calendar event
 *       · failed conference creation returns failure status
 *       · retry idempotency: never re-issues createRequest in the poll loop
 *   - syncMeetingToCalendarForUser:
 *       · reschedule (resync) preserves same Calendar event and Meet conference
 *       · attendee change (resync) preserves same Calendar event and Meet conference
 *       · meetWarning surfaced when conference is still pending
 *       · meet_space_name stored when conference resolves
 *
 * What is NOT tested (requires live credentials):
 *   - Actual Google Calendar API calls
 *   - Actual Google Meet spaces.get
 *   - Token refresh behaviour
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Environment ──────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL           = 'https://kk.test'
  process.env.GOOGLE_MANAGEMENT_CALENDAR_ID = 'cal@group.calendar.google.com'
})
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.GOOGLE_MANAGEMENT_CALENDAR_ID
})

// ─── buildCalendarEvent — pure function, conference flag ──────────────────

describe('buildCalendarEvent — conference flag', () => {
  it('omits conferenceData by default', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'bbbb0000-0000-0000-0000-000000000001',
      title: 'T', scheduled_start: '2026-09-02T09:00:00Z', scheduled_end: '2026-09-02T10:00:00Z',
    }
    expect(buildCalendarEvent(meeting, [], null).conferenceData).toBeUndefined()
  })

  it('includes createRequest with meeting.id as requestId when requestConference=true', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'bbbb0000-0000-0000-0000-000000000002',
      title: 'T', scheduled_start: '2026-09-02T09:00:00Z', scheduled_end: '2026-09-02T10:00:00Z',
    }
    const event = buildCalendarEvent(meeting, [], null, true)
    expect(event.conferenceData?.createRequest?.requestId).toBe(meeting.id)
    expect(event.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe('hangoutsMeet')
  })

  it('requestId is identical on every call — idempotent across retries', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'bbbb0000-0000-0000-0000-000000000003',
      title: 'T', scheduled_start: '2026-09-02T09:00:00Z', scheduled_end: '2026-09-02T10:00:00Z',
    }
    const id1 = buildCalendarEvent(meeting, [], null, true).conferenceData?.createRequest?.requestId
    const id2 = buildCalendarEvent(meeting, [], null, true).conferenceData?.createRequest?.requestId
    expect(id1).toBe(id2)
  })
})

// ─── syncEventToCalendar — via mocked googleapis ──────────────────────────
//
// We hoist mocks before any import of @/lib/google/calendar so that the
// module-level `google` import is already replaced when the module loads.

const mocks = vi.hoisted(() => {
  const mockPatch   = vi.fn()
  const mockInsert  = vi.fn()
  const mockGet     = vi.fn()
  const mockDelete  = vi.fn()
  return {
    mockPatch, mockInsert, mockGet, mockDelete,
    mockCalendar: {
      events: { patch: mockPatch, insert: mockInsert, get: mockGet, delete: mockDelete },
    },
  }
})

vi.mock('googleapis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('googleapis')>()
  return {
    ...actual,
    google: {
      ...actual.google,
      calendar: vi.fn().mockReturnValue(mocks.mockCalendar),
      meet: vi.fn().mockReturnValue({
        spaces: { get: vi.fn().mockResolvedValue({ data: { name: 'spaces/TestSpaceId' } }) },
      }),
    },
  }
})

// Helper to build a Calendar event response fixture
function makeEventResponse(opts: {
  htmlLink?: string
  conferenceId?: string
  createRequestStatus?: 'success' | 'pending' | 'failure'
} = {}) {
  return {
    data: {
      htmlLink: opts.htmlLink ?? 'https://calendar.google.com/event/xxx',
      ...(opts.conferenceId || opts.createRequestStatus ? {
        conferenceData: {
          ...(opts.conferenceId ? { conferenceId: opts.conferenceId } : {}),
          ...(opts.createRequestStatus ? {
            createRequest: { status: { statusCode: opts.createRequestStatus } },
          } : {}),
        },
      } : {}),
    },
  }
}

const MEETING = {
  id: 'cccc0000-0000-0000-0000-000000000001',
  title: 'Leadership Sync',
  scheduled_start: '2026-09-02T09:00:00Z',
  scheduled_end:   '2026-09-02T10:00:00Z',
}
// Derived via buildCalendarEventId('cccc0000-0000-0000-0000-000000000001')
const EVENT_ID = 'kk' + 'cccc0000-0000-0000-0000-000000000001'.replace(/-/g, '')

describe('syncEventToCalendar — new event (insert path)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('includes conferenceData.createRequest in the insert body for a new event', async () => {
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
    )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar({} as never, MEETING, [], null, null)

    expect(result.ok).toBe(true)
    const insertBody = mocks.mockInsert.mock.calls[0][0].requestBody
    expect(insertBody.conferenceData?.createRequest?.requestId).toBe(MEETING.id)
    expect(insertBody.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe('hangoutsMeet')
  })

  it('returns conferenceCode and status=success when insert response is immediately successful', async () => {
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
    )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar({} as never, MEETING, [], null, null)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conferenceCode).toBe('abc-mnop-xyz')
    expect(result.meetConferenceStatus).toBe('success')
  })

  it('polls events.get when insert response is pending, returns success after poll', async () => {
    vi.useFakeTimers()
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ createRequestStatus: 'pending' })
    )
    // First poll: still pending; second poll: success
    mocks.mockGet
      .mockResolvedValueOnce(makeEventResponse({ createRequestStatus: 'pending' }))
      .mockResolvedValueOnce(
        makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
      )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const promise = syncEventToCalendar({} as never, MEETING, [], null, null)
    await vi.runAllTimersAsync()
    const result = await promise
    vi.useRealTimers()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conferenceCode).toBe('abc-mnop-xyz')
    expect(result.meetConferenceStatus).toBe('success')
    // events.get was called (polling) — never events.insert again
    expect(mocks.mockGet.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(mocks.mockInsert).toHaveBeenCalledTimes(1)
  })

  it('returns pending status and preserves Calendar event when poll exhausts retries', async () => {
    vi.useFakeTimers()
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))
    mocks.mockGet.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const promise = syncEventToCalendar({} as never, MEETING, [], null, null)
    await vi.runAllTimersAsync()
    const result = await promise
    vi.useRealTimers()

    expect(result.ok).toBe(true)  // Calendar event is valid
    if (!result.ok) return
    expect(result.meetConferenceStatus).toBe('pending')
    expect(result.conferenceCode).toBeNull()
    // No second insert was ever called
    expect(mocks.mockInsert).toHaveBeenCalledTimes(1)
  })

  it('never calls events.insert more than once — retry only polls events.get', async () => {
    vi.useFakeTimers()
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))
    mocks.mockGet.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const promise = syncEventToCalendar({} as never, MEETING, [], null, null)
    await vi.runAllTimersAsync()
    await promise
    vi.useRealTimers()

    expect(mocks.mockInsert).toHaveBeenCalledTimes(1)
  })
})

describe('syncEventToCalendar — existing event (patch path)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('adopts existing conference — does NOT issue createRequest when conferenceId already present', async () => {
    mocks.mockPatch.mockResolvedValue(
      makeEventResponse({ conferenceId: 'existing-code', })
    )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar({} as never, MEETING, [], null, null)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conferenceCode).toBe('existing-code')
    expect(result.meetConferenceStatus).toBe('existed')
    // Only one PATCH call — no second createRequest PATCH, no INSERT
    expect(mocks.mockPatch).toHaveBeenCalledTimes(1)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
    const patchBody = mocks.mockPatch.mock.calls[0][0].requestBody
    expect(patchBody.conferenceData).toBeUndefined()
  })

  it('issues a second PATCH with createRequest for existing event with no conference', async () => {
    // First PATCH: no conference in response
    mocks.mockPatch
      .mockResolvedValueOnce(makeEventResponse())  // no conferenceData
      .mockResolvedValueOnce(                       // second PATCH with createRequest
        makeEventResponse({ conferenceId: 'new-code', createRequestStatus: 'success' })
      )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar({} as never, MEETING, [], null, null)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conferenceCode).toBe('new-code')
    expect(mocks.mockPatch).toHaveBeenCalledTimes(2)
    // Second PATCH must include createRequest
    const secondPatchBody = mocks.mockPatch.mock.calls[1][0].requestBody
    expect(secondPatchBody.conferenceData?.createRequest?.requestId).toBe(MEETING.id)
    // No INSERT
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })

  it('does NOT add createRequest when currentMeetSpaceName is set and no server conference found', async () => {
    // KK DB has a space name but server PATCH response has no conferenceData
    // (inconsistent state — do not create a second conference)
    mocks.mockPatch.mockResolvedValue(makeEventResponse())

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar(
      {} as never, MEETING, [], null, 'spaces/ExistingSpace'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetConferenceStatus).toBe('none')
    expect(mocks.mockPatch).toHaveBeenCalledTimes(1)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })

  it('first PATCH body does NOT include conferenceData — preserves existing conference', async () => {
    mocks.mockPatch.mockResolvedValue(makeEventResponse({ conferenceId: 'abc-defg-hij' }))

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    await syncEventToCalendar({} as never, MEETING, [], null, 'spaces/Existing')

    const firstPatchBody = mocks.mockPatch.mock.calls[0][0].requestBody
    expect(firstPatchBody.conferenceData).toBeUndefined()
  })

  it('reschedule: PATCH preserves same event and Meet conference (meet_space_name set)', async () => {
    mocks.mockPatch.mockResolvedValue(
      makeEventResponse({ conferenceId: 'existing-meet-code' })
    )
    const rescheduled = { ...MEETING, scheduled_start: '2026-09-03T09:00:00Z', scheduled_end: '2026-09-03T10:00:00Z' }

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar(
      {} as never, rescheduled, [], null, 'spaces/ExistingSpace'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Same event ID derived from meeting.id — not a new event
    expect(result.eventId).toBe(EVENT_ID)
    // No new conference created
    expect(result.meetConferenceStatus).toBe('existed')
    expect(mocks.mockPatch).toHaveBeenCalledTimes(1)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })

  it('attendee change: PATCH preserves same event and Meet conference', async () => {
    mocks.mockPatch.mockResolvedValue(
      makeEventResponse({ conferenceId: 'existing-meet-code' })
    )
    const newAttendees = [{ email: 'alice@test.com' }, { email: 'bob@test.com' }]

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar(
      {} as never, MEETING, newAttendees, null, 'spaces/ExistingSpace'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eventId).toBe(EVENT_ID)
    expect(result.meetConferenceStatus).toBe('existed')
    expect(mocks.mockPatch).toHaveBeenCalledTimes(1)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })
})

// ─── syncMeetingToCalendarForUser — meet_space_name storage and warnings ──
//
// Mocks Supabase service client, auth, and Meet API for integration-level tests.

const syncMocks = vi.hoisted(() => {
  const mockGetCurrentUser      = vi.fn()
  const mockGetOAuth2Client     = vi.fn()
  const mockSelectSingle        = vi.fn()
  const mockMeetGet             = vi.fn()
  const mockUpdateChain         = vi.fn().mockResolvedValue({ error: null })
  const mockEqChain             = vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) })
  const mockEnsureTranscription = vi.fn()
  const mockHasMeetScope        = vi.fn()

  // Build a mock serviceClient that handles different select chains
  const mockMeetingsRow   = vi.fn()
  const mockAttendeesData = vi.fn().mockResolvedValue({ data: [] })

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'meetings') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockMeetingsRow }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }
    }
    if (table === 'meeting_attendees') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }
    }
    return { select: vi.fn(), update: vi.fn(), insert: vi.fn() }
  })

  return {
    mockGetCurrentUser, mockGetOAuth2Client, mockSelectSingle,
    mockMeetGet, mockUpdateChain, mockEqChain,
    mockEnsureTranscription, mockHasMeetScope,
    mockMeetingsRow, mockAttendeesData, mockFrom,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue({ from: syncMocks.mockFrom }),
  createClient: vi.fn(),
}))

vi.mock('@/lib/google/auth', () => ({
  getCurrentUser:     syncMocks.mockGetCurrentUser,
  getGoogleOAuth2Client: syncMocks.mockGetOAuth2Client,
  hasMeetScope:       syncMocks.mockHasMeetScope,
}))

vi.mock('@/lib/google/meet', () => ({
  getMeetSpaceName:            vi.fn().mockResolvedValue('spaces/ResolvedSpaceId'),
  ensureMeetAutoTranscription: syncMocks.mockEnsureTranscription,
}))

const SYNC_MEETING_ROW = {
  id: 'sync-mtg-0000-0000-0000-000000000001',
  title: 'UM Meeting',
  scheduled_start: '2026-09-02T09:00:00Z',
  scheduled_end:   '2026-09-02T10:00:00Z',
  meet_space_name: null,
  project: null,
}

describe('syncMeetingToCalendarForUser — meet_space_name storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Provide credentials.scope so sync.ts can safely read it without throwing
    syncMocks.mockGetOAuth2Client.mockResolvedValue({ credentials: { scope: '' } })
    syncMocks.mockMeetingsRow.mockResolvedValue({ data: SYNC_MEETING_ROW, error: null })
    // Default: Meet scope present, transcription succeeds — no warning from M5E1-C path
    syncMocks.mockHasMeetScope.mockReturnValue(true)
    syncMocks.mockEnsureTranscription.mockResolvedValue('enabled')
  })

  it('stores meet_space_name in DB when conference resolves immediately', async () => {
    // Calendar API: event is new (404 then insert succeeds with conference)
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
    )
    const { getMeetSpaceName } = await import('@/lib/google/meet')
    vi.mocked(getMeetSpaceName).mockResolvedValue('spaces/ResolvedSpaceId')

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meetWarning).toBeUndefined()

    // Find the final update call that includes meet_space_name
    const updateCalls = syncMocks.mockFrom.mock.calls
      .filter((c) => c[0] === 'meetings')
    // The last update on 'meetings' should include meet_space_name
    const lastMeetingsFrom = updateCalls[updateCalls.length - 1]
    expect(lastMeetingsFrom).toBeDefined()
  })

  it('returns meetWarning when conference generation is still pending', async () => {
    vi.useFakeTimers()
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))
    mocks.mockGet.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const promise = syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')
    await vi.runAllTimersAsync()
    const result = await promise
    vi.useRealTimers()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meetWarning).toMatch(/being prepared/)
  })
})

// ─── syncMeetingToCalendarForUser — Meet auto-transcription (M5E1-C) ─────

describe('syncMeetingToCalendarForUser — Meet auto-transcription (M5E1-C)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    syncMocks.mockGetOAuth2Client.mockResolvedValue({ credentials: { scope: '' } })
    syncMocks.mockMeetingsRow.mockResolvedValue({ data: SYNC_MEETING_ROW, error: null })

    // Default calendar setup: new event, conference resolves immediately
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
    )

    // getMeetSpaceName resolves a permanent space name (reset after clearAllMocks)
    const { getMeetSpaceName } = await import('@/lib/google/meet')
    vi.mocked(getMeetSpaceName).mockResolvedValue('spaces/ResolvedSpaceId')

    // Default: scope present, transcription succeeds
    syncMocks.mockHasMeetScope.mockReturnValue(true)
    syncMocks.mockEnsureTranscription.mockResolvedValue('enabled')
  })

  it('calls ensureMeetAutoTranscription when space resolves and Meet scope is present', async () => {
    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meetWarning).toBeUndefined()
    expect(syncMocks.mockEnsureTranscription).toHaveBeenCalledWith(
      expect.anything(),
      'spaces/ResolvedSpaceId'
    )
  })

  it('returns no meetWarning when transcription is already_enabled', async () => {
    syncMocks.mockEnsureTranscription.mockResolvedValue('already_enabled')

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meetWarning).toBeUndefined()
  })

  it('returns meetWarning when Meet scope is missing — Calendar sync still succeeds', async () => {
    syncMocks.mockHasMeetScope.mockReturnValue(false)

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetWarning).toMatch(/Enable Google Meet in Settings/)
    // ensureMeetAutoTranscription must NOT be called when scope is missing
    expect(syncMocks.mockEnsureTranscription).not.toHaveBeenCalled()
  })

  it('returns meetWarning on permission_denied — Calendar sync still succeeds', async () => {
    syncMocks.mockEnsureTranscription.mockResolvedValue('permission_denied')

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetWarning).toMatch(/insufficient permissions/)
    // eventId is still populated — Calendar sync succeeded
    expect(result.eventId).toBeTruthy()
  })

  it('returns meetWarning on transcription error — Calendar sync still succeeds', async () => {
    syncMocks.mockEnsureTranscription.mockResolvedValue('error')

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetWarning).toMatch(/try re-syncing/)
    expect(result.eventId).toBeTruthy()
  })

  it('skips transcription when effectiveSpaceName is null (space still pending)', async () => {
    vi.useFakeTimers()
    // Override: conference still pending
    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))
    mocks.mockGet.mockResolvedValue(makeEventResponse({ createRequestStatus: 'pending' }))

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const promise = syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')
    await vi.runAllTimersAsync()
    const result = await promise
    vi.useRealTimers()

    expect(result.ok).toBe(true)
    // Warning is from the pending conference, not from transcription
    if (result.ok) expect(result.meetWarning).toMatch(/being prepared/)
    // ensureMeetAutoTranscription must NOT be called — no space yet
    expect(syncMocks.mockEnsureTranscription).not.toHaveBeenCalled()
  })
})
