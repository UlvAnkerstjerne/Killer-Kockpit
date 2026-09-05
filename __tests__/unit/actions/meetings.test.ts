/**
 * Tests for lib/actions/meetings.ts server actions.
 *
 * All consequential mutations go through SECURITY DEFINER stored procedures
 * via the service client's rpc(). Each test verifies:
 *   - authentication gate fires before rpc is called
 *   - permission checks fire BEFORE the rpc is called
 *   - rpc failures propagate as action errors
 *   - correct rpc name and arguments are used
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'meetings') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
      }),
    }
  })

  const mockClient = { from: mockFrom }

  const mockRpc = vi.fn()
  const mockServiceClient = { rpc: mockRpc }

  const mockResyncMeetingCalendar = vi.fn().mockResolvedValue({ ok: true, eventId: '' })

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockSelectSingle,
    mockFrom,
    mockClient,
    mockRpc,
    mockServiceClient,
    mockResyncMeetingCalendar,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockClient),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/google/sync', () => ({ resyncMeetingCalendar: mocks.mockResyncMeetingCalendar }))

// ---- Fixtures ----------------------------------------------------------------

const SUPER_ADMIN_USER = {
  id: 'admin-uuid',
  role: 'SUPER_ADMIN' as const,
  display_name: 'Admin',
  email: 'admin@killerkebab.com',
  active: true,
}

const UM_USER = {
  id: 'um-uuid',
  role: 'UM' as const,
  display_name: 'UM',
  email: 'um@killerkebab.com',
  active: true,
}

const MEMBER_USER = {
  id: 'member-uuid',
  role: 'MEMBER' as const,
  display_name: 'Member',
  email: 'member@killerkebab.com',
  active: true,
}

const MEETING_SCHEDULED = {
  id: 'meeting-uuid',
  title: 'Test Meeting',
  status: 'scheduled',
  owner_user_id: SUPER_ADMIN_USER.id,
}

const MEETING_OPEN = { ...MEETING_SCHEDULED, status: 'open' }
const MEETING_DRAFT = { ...MEETING_SCHEDULED, status: 'draft' }

// ---- createMeeting ----------------------------------------------------------

describe('createMeeting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createMeeting } = await import('@/lib/actions/meetings')
    const result = await createMeeting({ title: 'New Meeting' })
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
  })

  it('returns error when MEMBER tries to create a meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { createMeeting } = await import('@/lib/actions/meetings')
    const result = await createMeeting({ title: 'New Meeting' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('UM can create a meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    const result = await createMeeting({ title: 'UM Meeting' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-meeting-uuid')
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'insert failed' } })
    const { createMeeting } = await import('@/lib/actions/meetings')
    const result = await createMeeting({ title: 'New Meeting' })
    expect(result.error).toBeTruthy()
  })

  it('calls create_meeting_and_audit rpc with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    await createMeeting({
      title: 'Q4 Review',
      project_id: 'proj-uuid',
      scheduled_start: '2026-09-01T09:00',
    })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({
        p_title: 'Q4 Review',
        p_owner_user_id: SUPER_ADMIN_USER.id,
        p_project_id: 'proj-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_created_by_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('converts scheduled_start wall time (Copenhagen) to UTC before storing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    // Summer: 09:00 Copenhagen CEST (UTC+2) → 07:00 UTC
    await createMeeting({ title: 'Summer meeting', scheduled_start: '2026-09-01T09:00' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({ p_scheduled_start: '2026-09-01T07:00:00.000Z' })
    )
  })

  it('converts scheduled_start wall time (winter Copenhagen) to UTC before storing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    // Winter: 12:00 Copenhagen CET (UTC+1) → 11:00 UTC
    await createMeeting({ title: 'Winter meeting', scheduled_start: '2026-12-01T12:00' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({ p_scheduled_start: '2026-12-01T11:00:00.000Z' })
    )
  })

  it('passes null for omitted scheduled_start', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    await createMeeting({ title: 'No time' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({ p_scheduled_start: null, p_scheduled_end: null })
    )
  })
})

// ---- openMeeting ------------------------------------------------------------

describe('openMeeting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { openMeeting } = await import('@/lib/actions/meetings')
    const result = await openMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when meeting not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { openMeeting } = await import('@/lib/actions/meetings')
    const result = await openMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when meeting is not scheduled', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const { openMeeting } = await import('@/lib/actions/meetings')
    const result = await openMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-owner MEMBER tries to open', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_SCHEDULED, error: null })
    const { openMeeting } = await import('@/lib/actions/meetings')
    const result = await openMeeting('meeting-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls open_meeting_and_audit rpc on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_SCHEDULED, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { openMeeting } = await import('@/lib/actions/meetings')
    const result = await openMeeting('meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'open_meeting_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })
})

// ---- closeMeeting -----------------------------------------------------------

describe('closeMeeting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { closeMeeting } = await import('@/lib/actions/meetings')
    const result = await closeMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when meeting is not open', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    const { closeMeeting } = await import('@/lib/actions/meetings')
    const result = await closeMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls close_meeting_and_audit rpc on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { closeMeeting } = await import('@/lib/actions/meetings')
    const result = await closeMeeting('meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'close_meeting_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })
})

// ---- cancelMeeting ----------------------------------------------------------

describe('cancelMeeting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { cancelMeeting } = await import('@/lib/actions/meetings')
    const result = await cancelMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when meeting is already published', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...MEETING_SCHEDULED, status: 'published' }, error: null,
    })
    const { cancelMeeting } = await import('@/lib/actions/meetings')
    const result = await cancelMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is already cancelled', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...MEETING_SCHEDULED, status: 'cancelled' }, error: null,
    })
    const { cancelMeeting } = await import('@/lib/actions/meetings')
    const result = await cancelMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls cancel_meeting_and_audit rpc with before status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { cancelMeeting } = await import('@/lib/actions/meetings')
    const result = await cancelMeeting('meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'cancel_meeting_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_before_status: 'draft',
      })
    )
  })
})

// ---- publishMeeting ---------------------------------------------------------

// ---- addMeetingCorrection ---------------------------------------------------

const MEETING_PUBLISHED = { ...MEETING_SCHEDULED, status: 'published' }

describe('addMeetingCorrection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix text' })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix text' })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-owner MEMBER tries to add correction', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix text' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is not published', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix text' })
    expect(result.error).toContain('published')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when body is empty', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: '   ' })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls add_meeting_correction_and_audit rpc on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'correction-uuid', error: null })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix text', reason: 'Typo' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('correction-uuid')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'add_meeting_correction_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_body: 'Fix text',
        p_reason: 'Typo',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { addMeetingCorrection } = await import('@/lib/actions/meetings')
    const result = await addMeetingCorrection('meeting-uuid', { body: 'Fix text' })
    expect(result.error).toBeTruthy()
  })
})

// ---- publishMeeting ---------------------------------------------------------

describe('publishMeeting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to publish', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is not in draft status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toContain('draft')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-owner UM tries to publish', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    // MEETING_DRAFT.owner_user_id = SUPER_ADMIN_USER.id, not UM_USER.id
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls publish_meeting_and_audit rpc on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'publish_meeting_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { publishMeeting } = await import('@/lib/actions/meetings')
    const result = await publishMeeting('meeting-uuid')
    expect(result.error).toBeTruthy()
  })
})

// ---- createMeeting — location field -----------------------------------------

describe('createMeeting — location', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes location to create_meeting_and_audit rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    await createMeeting({ title: 'All-hands', location: 'Killer Kebab office' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({ p_location: 'Killer Kebab office' })
    )
  })

  it('passes null for omitted location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    await createMeeting({ title: 'No location' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({ p_location: null })
    )
  })

  it('passes null for blank location string', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-meeting-uuid', error: null })
    const { createMeeting } = await import('@/lib/actions/meetings')
    await createMeeting({ title: 'Blanked', location: '   ' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_and_audit',
      expect.objectContaining({ p_location: null })
    )
  })
})

// ---- updateMeeting ----------------------------------------------------------

describe('updateMeeting', () => {
  beforeEach(() => vi.clearAllMocks())

  const MEETING_WITH_CALENDAR = {
    ...MEETING_SCHEDULED,
    calendar_event_id: 'cal-event-id',
    location: null,
  }

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateMeeting } = await import('@/lib/actions/meetings')
    const result = await updateMeeting('meeting-uuid', { title: 'New title' })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    const result = await updateMeeting('meeting-uuid', { title: 'New title' })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-owner MEMBER tries to edit', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_SCHEDULED, error: null })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    const result = await updateMeeting('meeting-uuid', { title: 'Hack' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('updates location via update_meeting_and_audit rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: { ...MEETING_SCHEDULED, location: null }, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    const result = await updateMeeting('meeting-uuid', { location: 'Borgergade' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_meeting_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_patch: expect.objectContaining({ location: 'Borgergade' }),
      })
    )
  })

  it('accepts null location (clearing the field)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: { ...MEETING_SCHEDULED, location: 'Old place' }, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    // Passing empty string clears the field (coerced to null)
    const result = await updateMeeting('meeting-uuid', { location: '' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_meeting_and_audit',
      expect.objectContaining({
        p_patch: expect.objectContaining({ location: null }),
      })
    )
  })

  it('skips rpc when no fields changed', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    // location in DB is already 'Same place'
    mocks.mockSelectSingle.mockResolvedValue({ data: { ...MEETING_SCHEDULED, location: 'Same place' }, error: null })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    const result = await updateMeeting('meeting-uuid', { location: 'Same place' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('triggers calendar resync when location changes and calendar event exists', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: MEETING_WITH_CALENDAR, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    mocks.mockResyncMeetingCalendar.mockResolvedValue({ ok: true, eventId: 'cal-event-id' })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    await updateMeeting('meeting-uuid', { location: 'Google Meet' })
    expect(mocks.mockResyncMeetingCalendar).toHaveBeenCalledWith('meeting-uuid')
  })

  it('does NOT trigger calendar resync when location changes but no calendar event', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: { ...MEETING_SCHEDULED, location: null }, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    await updateMeeting('meeting-uuid', { location: 'Restaurant X' })
    expect(mocks.mockResyncMeetingCalendar).not.toHaveBeenCalled()
  })

  it('agenda locking is independent: location editable even when agenda is locked', async () => {
    // After a meeting is published (agenda read-only), location can still be edited
    // via the normal edit permission path (canEditMeeting). The working_notes
    // restriction does NOT apply to location.
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const publishedMeeting = { ...MEETING_SCHEDULED, status: 'published', location: null }
    mocks.mockSelectSingle.mockResolvedValue({ data: publishedMeeting, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    // Location update on a published meeting — should succeed (no working_notes restriction)
    const result = await updateMeeting('meeting-uuid', { location: 'Viktoriagade' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_meeting_and_audit',
      expect.objectContaining({ p_patch: expect.objectContaining({ location: 'Viktoriagade' }) })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: { ...MEETING_SCHEDULED, location: null }, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { updateMeeting } = await import('@/lib/actions/meetings')
    const result = await updateMeeting('meeting-uuid', { location: 'Somewhere' })
    expect(result.error).toBeTruthy()
  })
})
