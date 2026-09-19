/**
 * Tests for lib/actions/meetings.ts — createMeetingWithSetup
 *
 * Scenario covered:
 *   Calendar sync failure after Kockpit meeting creation does NOT block navigation.
 *   The action must return { data: { id } } (not { error }) so the form always
 *   redirects to the meeting detail page, preventing double-submission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const creationMocks = vi.hoisted(() => {
  const mockGetCurrentUser     = vi.fn()
  const mockCanCreate          = vi.fn()
  const mockServiceClient      = vi.fn()
  const mockSyncToCalendar     = vi.fn()
  const mockRevalidatePath     = vi.fn()

  return {
    mockGetCurrentUser,
    mockCanCreate,
    mockServiceClient,
    mockSyncToCalendar,
    mockRevalidatePath,
  }
})

vi.mock('@/lib/auth', () => ({
  getCurrentUser: creationMocks.mockGetCurrentUser,
}))

vi.mock('@/lib/permissions', () => ({
  canCreateMeeting: creationMocks.mockCanCreate,
  canEditMeeting:   vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: creationMocks.mockServiceClient,
  createClient:        vi.fn(),
}))

vi.mock('@/lib/google/sync', () => ({
  syncMeetingToCalendarForUser: creationMocks.mockSyncToCalendar,
  resyncMeetingCalendar:        vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: creationMocks.mockRevalidatePath,
}))

vi.mock('@/lib/time', () => ({
  wallToUtc: (s: string) => s,  // pass-through
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER      = { id: 'user-001', role: 'UM' }
const MEETING_ID = 'mtg-new-001'

function makeRpc(returnValue: unknown) {
  return vi.fn().mockResolvedValue(returnValue)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createMeetingWithSetup — calendar failure does not block navigation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    creationMocks.mockGetCurrentUser.mockResolvedValue(USER)
    creationMocks.mockCanCreate.mockReturnValue(true)
  })

  it('returns { data: { id } } when calendar sync fails — never returns { error }', async () => {
    const rpc = makeRpc({ data: MEETING_ID, error: null })
    creationMocks.mockServiceClient.mockReturnValue({ rpc })
    creationMocks.mockSyncToCalendar.mockResolvedValue({
      ok: false,
      error: 'Calendar API error',
    })

    const { createMeetingWithSetup } = await import('@/lib/actions/meetings')
    const result = await createMeetingWithSetup({
      title:           'Test Meeting',
      scheduled_start: '2026-09-20T09:00',
      scheduled_end:   '2026-09-20T10:00',
      attendees:       [],
      agendaItems:     [],
    })

    // Must have data.id so the form can redirect
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(MEETING_ID)
    // Calendar failure surfaced as a warning, not a hard error
    expect(result.data?.calendarWarning).toBeDefined()
    expect(result.data?.calendarWarning).toContain('Calendar API error')
  })

  it('returns { data: { id } } with no warning when calendar sync succeeds', async () => {
    const rpc = makeRpc({ data: MEETING_ID, error: null })
    creationMocks.mockServiceClient.mockReturnValue({ rpc })
    creationMocks.mockSyncToCalendar.mockResolvedValue({
      ok:          true,
      eventUrl:    'https://calendar.google.com/event/xxx',
      meetWarning: undefined,
    })

    const { createMeetingWithSetup } = await import('@/lib/actions/meetings')
    const result = await createMeetingWithSetup({
      title:           'Test Meeting',
      scheduled_start: '2026-09-20T09:00',
      scheduled_end:   '2026-09-20T10:00',
      attendees:       [],
      agendaItems:     [],
    })

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(MEETING_ID)
    expect(result.data?.calendarWarning).toBeUndefined()
  })

  it('returns { error } only when meeting DB creation itself fails — no navigation', async () => {
    const rpc = makeRpc({ data: null, error: { message: 'DB failure' } })
    creationMocks.mockServiceClient.mockReturnValue({ rpc })

    const { createMeetingWithSetup } = await import('@/lib/actions/meetings')
    const result = await createMeetingWithSetup({
      title:       'Test Meeting',
      attendees:   [],
      agendaItems: [],
    })

    expect(result.error).toBeDefined()
    expect(result.data).toBeUndefined()
    // Calendar sync must never be called if meeting creation failed
    expect(creationMocks.mockSyncToCalendar).not.toHaveBeenCalled()
  })
})
