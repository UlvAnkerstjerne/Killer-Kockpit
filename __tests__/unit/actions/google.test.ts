/**
 * Tests for lib/actions/google.ts server actions.
 * Tests the auth/permission gates. Live API calls (syncMeetingToCalendarForUser)
 * are mocked at the module level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser      = vi.fn()
  const mockRevalidatePath      = vi.fn()
  const mockGetConnectionStatus = vi.fn()
  const mockDeleteTokens        = vi.fn()
  const mockSyncForUser         = vi.fn()
  const mockSelectSingle        = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'meetings') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
      }),
    }
  })

  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockGetConnectionStatus,
    mockDeleteTokens,
    mockSyncForUser,
    mockSelectSingle,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/google/auth', () => ({
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  deleteGoogleTokens:        mocks.mockDeleteTokens,
}))
vi.mock('@/lib/google/sync', () => ({
  syncMeetingToCalendarForUser: mocks.mockSyncForUser,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  id: 'admin-uuid', role: 'SUPER_ADMIN' as const,
  display_name: 'Admin', email: 'admin@kk.com', active: true,
}
const MEMBER = {
  id: 'member-uuid', role: 'MEMBER' as const,
  display_name: 'Member', email: 'member@kk.com', active: true,
}
const MEETING = {
  id: 'meeting-uuid',
  owner_user_id:   SUPER_ADMIN.id,
  scheduled_start: '2026-09-01T10:00:00+02:00',
  scheduled_end:   '2026-09-01T11:00:00+02:00',
}

// ── getMyGoogleConnectionStatus ───────────────────────────────────────────

describe('getMyGoogleConnectionStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not-connected when unauthenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: false })
    const { getMyGoogleConnectionStatus } = await import('@/lib/actions/google')
    const result = await getMyGoogleConnectionStatus()
    expect(result).toEqual({ connected: false })
  })

  it('returns connection status for authenticated user', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    const statusPayload = { connected: true, scopes: ['calendar.events'], expiresAt: '2026-09-01T12:00:00Z', healthy: true }
    mocks.mockGetConnectionStatus.mockResolvedValue(statusPayload)
    const { getMyGoogleConnectionStatus } = await import('@/lib/actions/google')
    const result = await getMyGoogleConnectionStatus()
    expect(result).toEqual(statusPayload)
    expect(mocks.mockGetConnectionStatus).toHaveBeenCalledWith(SUPER_ADMIN.id)
  })
})

// ── disconnectGoogleCalendar ──────────────────────────────────────────────

describe('disconnectGoogleCalendar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when unauthenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { disconnectGoogleCalendar } = await import('@/lib/actions/google')
    const result = await disconnectGoogleCalendar()
    expect(result.error).toBeTruthy()
    expect(mocks.mockDeleteTokens).not.toHaveBeenCalled()
  })

  it('deletes tokens and revalidates on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockDeleteTokens.mockResolvedValue(undefined)
    const { disconnectGoogleCalendar } = await import('@/lib/actions/google')
    const result = await disconnectGoogleCalendar()
    expect(result.error).toBeUndefined()
    expect(mocks.mockDeleteTokens).toHaveBeenCalledWith(SUPER_ADMIN.id)
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/settings')
  })
})

// ── syncMeetingToCalendar ─────────────────────────────────────────────────

describe('syncMeetingToCalendar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when unauthenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { syncMeetingToCalendar } = await import('@/lib/actions/google')
    const result = await syncMeetingToCalendar('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockSyncForUser).not.toHaveBeenCalled()
  })

  it('returns error when meeting not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { syncMeetingToCalendar } = await import('@/lib/actions/google')
    const result = await syncMeetingToCalendar('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockSyncForUser).not.toHaveBeenCalled()
  })

  it('returns error when MEMBER tries to sync another user\'s meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    const { syncMeetingToCalendar } = await import('@/lib/actions/google')
    const result = await syncMeetingToCalendar('meeting-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockSyncForUser).not.toHaveBeenCalled()
  })

  it('returns error when meeting has no scheduled time', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...MEETING, scheduled_start: null, scheduled_end: null },
      error: null,
    })
    const { syncMeetingToCalendar } = await import('@/lib/actions/google')
    const result = await syncMeetingToCalendar('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockSyncForUser).not.toHaveBeenCalled()
  })

  it('calls syncMeetingToCalendarForUser and returns eventId on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    mocks.mockSyncForUser.mockResolvedValue({ ok: true, eventId: 'kkmeeting-uuid' })
    const { syncMeetingToCalendar } = await import('@/lib/actions/google')
    const result = await syncMeetingToCalendar('meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(result.data?.eventId).toBe('kkmeeting-uuid')
    expect(mocks.mockSyncForUser).toHaveBeenCalledWith('meeting-uuid', SUPER_ADMIN.id)
  })

  it('surfaces the error string when sync fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    mocks.mockSyncForUser.mockResolvedValue({ ok: false, error: 'Insufficient permissions' })
    const { syncMeetingToCalendar } = await import('@/lib/actions/google')
    const result = await syncMeetingToCalendar('meeting-uuid')
    expect(result.error).toBe('Insufficient permissions')
    expect(result.data).toBeUndefined()
  })
})
