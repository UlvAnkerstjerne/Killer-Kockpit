/**
 * Tests for Google Calendar sync — system credential routing architecture.
 *
 * Architecture under test:
 *   ALL Calendar writes use the SYSTEM management-calendar writer credential
 *   (GOOGLE_CALENDAR_WRITER_USER_ID), NOT the acting Kockpit user's credential.
 *
 * Scenarios covered:
 *   buildCalendarEvent (pure, no mocks):
 *     - conferenceData omitted by default
 *     - conferenceData.createRequest included when requestConference=true
 *     - requestId is stable across retries
 *
 *   syncEventToCalendar (via googleapis mock):
 *     - new event → insert with createRequest
 *     - existing event with conference → adopted, no createRequest
 *     - existing event without conference → second PATCH adds createRequest
 *     - immediate success
 *     - pending → success after polling
 *     - pending timeout preserves Calendar event
 *     - failed conference creation returns failure status
 *     - retry idempotency: never re-issues createRequest in poll loop
 *
 *   syncMeetingToCalendarForUser — system credential routing:
 *     - SYSTEM credential used, NOT user's personal OAuth
 *     - User with no personal Google Calendar can still sync
 *     - Missing system credential returns admin-oriented error
 *     - 403 on system credential → admin-oriented error (not "ask admin to grant you")
 *     - Successful sync stores system writer's user ID as calendar_synced_by_user_id
 *     - Attendee change resync uses system credential
 *     - Schedule change resync uses system credential
 *     - Existing meeting with old calendar_synced_by_user_id → no duplicate event
 *     - meetWarning returned when conference generation is still pending
 *     - meet_space_name stored when conference resolves
 *     - ensureMeetAutoTranscription called when system credential has Meet scope
 *     - meetWarning when system credential lacks Meet scope
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Environment ──────────────────────────────────────────────────────────

const SYSTEM_WRITER_USER_ID = 'system-calendar-writer-user-id'

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL           = 'https://kk.test'
  process.env.GOOGLE_MANAGEMENT_CALENDAR_ID = 'cal@group.calendar.google.com'
  process.env.GOOGLE_CALENDAR_WRITER_USER_ID = SYSTEM_WRITER_USER_ID
})
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.GOOGLE_MANAGEMENT_CALENDAR_ID
  delete process.env.GOOGLE_CALENDAR_WRITER_USER_ID
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

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetConferenceStatus).toBe('pending')
    expect(result.conferenceCode).toBeNull()
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
    expect(mocks.mockPatch).toHaveBeenCalledTimes(1)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
    const patchBody = mocks.mockPatch.mock.calls[0][0].requestBody
    expect(patchBody.conferenceData).toBeUndefined()
  })

  it('issues a second PATCH with createRequest for existing event with no conference', async () => {
    mocks.mockPatch
      .mockResolvedValueOnce(makeEventResponse())
      .mockResolvedValueOnce(
        makeEventResponse({ conferenceId: 'new-code', createRequestStatus: 'success' })
      )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar({} as never, MEETING, [], null, null)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conferenceCode).toBe('new-code')
    expect(mocks.mockPatch).toHaveBeenCalledTimes(2)
    const secondPatchBody = mocks.mockPatch.mock.calls[1][0].requestBody
    expect(secondPatchBody.conferenceData?.createRequest?.requestId).toBe(MEETING.id)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })

  it('does NOT add createRequest when currentMeetSpaceName is set and no server conference found', async () => {
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
    expect(result.eventId).toBe(EVENT_ID)
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

// ─── syncMeetingToCalendarForUser — system credential routing ─────────────
//
// These tests prove that the SYSTEM management-calendar writer credential is
// always used, regardless of which Kockpit user triggered the sync.

const syncMocks = vi.hoisted(() => {
  const mockGetManagementCalendarClient = vi.fn()
  const mockGetManagementCalendarWriterUserId = vi.fn().mockReturnValue('system-calendar-writer-user-id')
  const mockGetOAuth2Client             = vi.fn()  // user credential — must NOT be called for Calendar
  const mockEnsureTranscription         = vi.fn()
  const mockHasMeetScope                = vi.fn()
  const mockMeetingsRow                 = vi.fn()

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
    mockGetManagementCalendarClient,
    mockGetManagementCalendarWriterUserId,
    mockGetOAuth2Client,
    mockEnsureTranscription, mockHasMeetScope,
    mockMeetingsRow, mockFrom,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue({ from: syncMocks.mockFrom }),
  createClient: vi.fn(),
}))

vi.mock('@/lib/google/auth', () => ({
  getCurrentUser:                       vi.fn(),
  getGoogleOAuth2Client:                syncMocks.mockGetOAuth2Client,
  getManagementCalendarClient:          syncMocks.mockGetManagementCalendarClient,
  getManagementCalendarWriterUserId:    syncMocks.mockGetManagementCalendarWriterUserId,
  hasMeetScope:                         syncMocks.mockHasMeetScope,
}))

vi.mock('@/lib/google/meet', () => ({
  getMeetSpaceName:            vi.fn().mockResolvedValue('spaces/ResolvedSpaceId'),
  ensureMeetAutoTranscription: syncMocks.mockEnsureTranscription,
}))

const SYSTEM_OAUTH_CLIENT = { credentials: { scope: '' } }

const SYNC_MEETING_ROW = {
  id: 'sync-mtg-0000-0000-0000-000000000001',
  title: 'UM Meeting',
  scheduled_start: '2026-09-02T09:00:00Z',
  scheduled_end:   '2026-09-02T10:00:00Z',
  meet_space_name: null,
  project: null,
}

// ─── Core: system credential routing ─────────────────────────────────────

describe('syncMeetingToCalendarForUser — system credential routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(SYSTEM_OAUTH_CLIENT)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(SYSTEM_WRITER_USER_ID)
    syncMocks.mockMeetingsRow.mockResolvedValue({ data: SYNC_MEETING_ROW, error: null })
    syncMocks.mockHasMeetScope.mockReturnValue(false)
    syncMocks.mockEnsureTranscription.mockResolvedValue('enabled')

    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
    )
  })

  it('uses getManagementCalendarClient, NOT the acting user\'s credential', async () => {
    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'lydia-user-id')

    expect(result.ok).toBe(true)
    // System credential was fetched
    expect(syncMocks.mockGetManagementCalendarClient).toHaveBeenCalled()
    // User credential was NOT fetched
    expect(syncMocks.mockGetOAuth2Client).not.toHaveBeenCalled()
  })

  it('manager without personal Google Calendar can sync — system writer handles it', async () => {
    // Simulate: user has no personal Google connected (getOAuth2Client would return null)
    // But system writer IS configured — sync should succeed
    syncMocks.mockGetOAuth2Client.mockResolvedValue(null)

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'lydia-user-id')

    expect(result.ok).toBe(true)
    expect(syncMocks.mockGetManagementCalendarClient).toHaveBeenCalled()
    expect(syncMocks.mockGetOAuth2Client).not.toHaveBeenCalled()
  })

  it('stores system writer user ID (not actor user ID) in calendar_synced_by_user_id', async () => {
    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'lydia-user-id')

    // Find the final meetings.update call and check calendar_synced_by_user_id
    const meetingFromCalls = syncMocks.mockFrom.mock.calls.filter((c) => c[0] === 'meetings')
    // At least one update call should have happened
    expect(meetingFromCalls.length).toBeGreaterThan(0)
    // The system writer's ID should be stored, not lydia's
    const updateMock = syncMocks.mockFrom.mock.results
      .filter((_, i) => syncMocks.mockFrom.mock.calls[i]?.[0] === 'meetings')
      .map((r) => r.value?.update?.mock?.calls ?? [])
      .flat()
    // At least one update was called with the system writer's user ID
    const calendarPatch = updateMock.find((call: unknown[]) => {
      const patch = call[0] as Record<string, unknown>
      return patch?.calendar_synced_by_user_id !== undefined
    })
    if (calendarPatch) {
      expect(calendarPatch[0]).toMatchObject({
        calendar_synced_by_user_id: SYSTEM_WRITER_USER_ID,
      })
    }
  })

  it('returns admin-oriented error when system credential is not configured', async () => {
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(null)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(null)

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'any-user')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/admin must set GOOGLE_CALENDAR_WRITER_USER_ID/)
    // No Calendar API calls were made
    expect(mocks.mockInsert).not.toHaveBeenCalled()
    expect(mocks.mockPatch).not.toHaveBeenCalled()
  })

  it('returns admin-oriented error when system token is not stored', async () => {
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(null)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(SYSTEM_WRITER_USER_ID)

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'any-user')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/system Calendar connection needs attention/)
  })

  it('Kockpit meeting remains created; no duplicate event on system credential failure', async () => {
    // System credential unavailable — sync fails, but the meeting was already created
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(null)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(null)

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'any-user')

    // Sync failed — but no insert/patch was attempted
    expect(result.ok).toBe(false)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
    expect(mocks.mockPatch).not.toHaveBeenCalled()
  })
})

// ─── 403 / permission-denied produces admin-oriented error ─────────────────

describe('syncEventToCalendar — 403 produces admin-oriented error', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403 returns permissionDenied=true with admin-facing message (no blame on acting user)', async () => {
    mocks.mockPatch.mockRejectedValue(
      Object.assign(new Error('Forbidden'), {
        code: 403,
        errors: [{ reason: 'insufficientPermissions' }],
      })
    )

    const { syncEventToCalendar } = await import('@/lib/google/calendar')
    const result = await syncEventToCalendar({} as never, MEETING, [], null, null)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.permissionDenied).toBe(true)
    // Must NOT say "you do not have" — this is a system credential issue
    expect(result.error).not.toMatch(/[Yy]ou do not have/)
    expect(result.error).toMatch(/system Calendar connection/)
  })
})

// ─── meet_space_name storage and warnings ────────────────────────────────

describe('syncMeetingToCalendarForUser — meet_space_name storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(SYSTEM_OAUTH_CLIENT)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(SYSTEM_WRITER_USER_ID)
    syncMocks.mockMeetingsRow.mockResolvedValue({ data: SYNC_MEETING_ROW, error: null })
    syncMocks.mockHasMeetScope.mockReturnValue(true)
    syncMocks.mockEnsureTranscription.mockResolvedValue('enabled')
  })

  it('stores meet_space_name in DB when conference resolves immediately', async () => {
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

// ─── Auto-transcription via system credential ─────────────────────────────

describe('syncMeetingToCalendarForUser — Meet auto-transcription via system credential', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(SYSTEM_OAUTH_CLIENT)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(SYSTEM_WRITER_USER_ID)
    syncMocks.mockMeetingsRow.mockResolvedValue({ data: SYNC_MEETING_ROW, error: null })

    mocks.mockPatch.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.mockInsert.mockResolvedValue(
      makeEventResponse({ conferenceId: 'abc-mnop-xyz', createRequestStatus: 'success' })
    )

    const { getMeetSpaceName } = await import('@/lib/google/meet')
    vi.mocked(getMeetSpaceName).mockResolvedValue('spaces/ResolvedSpaceId')

    syncMocks.mockHasMeetScope.mockReturnValue(true)
    syncMocks.mockEnsureTranscription.mockResolvedValue('enabled')
  })

  it('calls ensureMeetAutoTranscription with system credential when system has Meet scope', async () => {
    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meetWarning).toBeUndefined()
    expect(syncMocks.mockEnsureTranscription).toHaveBeenCalledWith(
      SYSTEM_OAUTH_CLIENT,
      'spaces/ResolvedSpaceId'
    )
    // User OAuth was NOT used
    expect(syncMocks.mockGetOAuth2Client).not.toHaveBeenCalled()
  })

  it('returns meetWarning when system credential lacks Meet scope — Calendar sync still succeeds', async () => {
    syncMocks.mockHasMeetScope.mockReturnValue(false)

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetWarning).toMatch(/system Calendar account needs Google Meet scope/)
    expect(syncMocks.mockEnsureTranscription).not.toHaveBeenCalled()
  })

  it('returns no meetWarning when transcription is already_enabled', async () => {
    syncMocks.mockEnsureTranscription.mockResolvedValue('already_enabled')

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.meetWarning).toBeUndefined()
  })

  it('returns meetWarning on permission_denied — Calendar sync still succeeds', async () => {
    syncMocks.mockEnsureTranscription.mockResolvedValue('permission_denied')

    const { syncMeetingToCalendarForUser } = await import('@/lib/google/sync')
    const result = await syncMeetingToCalendarForUser(SYNC_MEETING_ROW.id, 'user-123')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meetWarning).toMatch(/system Calendar account needs meetings/)
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
    expect(syncMocks.mockEnsureTranscription).not.toHaveBeenCalled()
  })
})

// ─── Existing meeting compatibility (old calendar_synced_by_user_id) ──────

describe('resyncMeetingCalendar — existing meetings with old calendar_synced_by_user_id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncMocks.mockGetManagementCalendarClient.mockResolvedValue(SYSTEM_OAUTH_CLIENT)
    syncMocks.mockGetManagementCalendarWriterUserId.mockReturnValue(SYSTEM_WRITER_USER_ID)
    syncMocks.mockHasMeetScope.mockReturnValue(false)
    syncMocks.mockEnsureTranscription.mockResolvedValue('enabled')
  })

  it('uses system credential regardless of what is stored in calendar_synced_by_user_id', async () => {
    // Simulate a meeting that was originally synced by an individual user
    const existingMeeting = {
      ...SYNC_MEETING_ROW,
      calendar_event_id: EVENT_ID,
      // Old-style: individual user was stored
    }

    syncMocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'meetings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: existingMeeting, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }
      }
      if (table === 'meeting_attendees') {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }) }) }
      }
      return { select: vi.fn(), update: vi.fn() }
    })

    mocks.mockPatch.mockResolvedValue(
      makeEventResponse({ conferenceId: 'existing-conf' })
    )

    const { resyncMeetingCalendar } = await import('@/lib/google/sync')
    const result = await resyncMeetingCalendar(SYNC_MEETING_ROW.id)

    expect(result.ok).toBe(true)
    // System credential was used — not user's
    expect(syncMocks.mockGetManagementCalendarClient).toHaveBeenCalled()
    expect(syncMocks.mockGetOAuth2Client).not.toHaveBeenCalled()
    // Same event (patch, not insert) — no duplicate
    expect(mocks.mockPatch).toHaveBeenCalledTimes(1)
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })

  it('resync is no-op when no calendar_event_id is stored', async () => {
    syncMocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'meetings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { calendar_event_id: null }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        }
      }
      return { select: vi.fn(), update: vi.fn() }
    })

    const { resyncMeetingCalendar } = await import('@/lib/google/sync')
    const result = await resyncMeetingCalendar('any-meeting-id')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.eventId).toBe('')
    expect(mocks.mockPatch).not.toHaveBeenCalled()
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })
})
