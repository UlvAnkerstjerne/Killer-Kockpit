/**
 * Tests for lib/actions/agenda-items.ts server actions.
 *
 * Verifies permission gates, rpc name/args, and error propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockMeetingSelectSingle = vi.fn()
  const mockItemSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'meetings') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockMeetingSelectSingle }),
        }),
      }
    }
    if (table === 'agenda_items') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockItemSelectSingle }),
        }),
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  })

  const mockClient = { from: mockFrom }
  const mockRpc = vi.fn()
  const mockServiceClient = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockMeetingSelectSingle,
    mockItemSelectSingle,
    mockClient,
    mockRpc,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockClient),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

// ---- Fixtures ----------------------------------------------------------------

const SUPER_ADMIN_USER = {
  id: 'admin-uuid',
  role: 'SUPER_ADMIN' as const,
  display_name: 'Admin',
  email: 'admin@killerkebab.com',
  active: true,
}

const MEMBER_USER = {
  id: 'member-uuid',
  role: 'MEMBER' as const,
  display_name: 'Member',
  email: 'member@killerkebab.com',
  active: true,
}

const MEETING = {
  id: 'meeting-uuid',
  status: 'open',
  owner_user_id: SUPER_ADMIN_USER.id,
}

// Agenda editable only in scheduled status
const SCHEDULED_MEETING = {
  id: 'meeting-uuid',
  status: 'scheduled',
  owner_user_id: SUPER_ADMIN_USER.id,
}

// ---- createAgendaItem -------------------------------------------------------

describe('createAgendaItem', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Item 1' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when meeting not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Item 1' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER (non-owner) tries to add agenda item', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Item 1' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is open (agenda locked after start)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Item' })
    expect(result.error).toMatch(/cannot be modified/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is published (agenda locked)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({
      data: { ...MEETING, status: 'published' },
      error: null,
    })
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Item' })
    expect(result.error).toMatch(/cannot be modified/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls create_agenda_item_and_audit with correct args for scheduled meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: SCHEDULED_MEETING, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'item-uuid', error: null })
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Budget review', sortOrder: 2 })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_agenda_item_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_title: 'Budget review',
        p_sort_order: 2,
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { createAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await createAgendaItem('meeting-uuid', { title: 'Item' })
    expect(result.error).toBeTruthy()
  })
})

// ---- updateAgendaItem -------------------------------------------------------

describe('updateAgendaItem', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await updateAgendaItem('item-uuid', 'meeting-uuid', { status: 'done' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when meeting is open (agenda locked after start)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING, error: null })
    const { updateAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await updateAgendaItem('item-uuid', 'meeting-uuid', { status: 'done' })
    expect(result.error).toMatch(/cannot be modified/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when unauthorized user tries to update item', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: SCHEDULED_MEETING, error: null })
    const { updateAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await updateAgendaItem('item-uuid', 'meeting-uuid', { title: 'Hack' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: SCHEDULED_MEETING, error: null })
    mocks.mockItemSelectSingle.mockResolvedValue({
      data: { title: 'Original', description: null, status: 'open' },
      error: null,
    })
    const { updateAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await updateAgendaItem('item-uuid', 'meeting-uuid', { title: 'Original' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls update_agenda_item_and_audit rpc with patch and before for scheduled meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: SCHEDULED_MEETING, error: null })
    mocks.mockItemSelectSingle.mockResolvedValue({
      data: { title: 'Original', description: null, status: 'open' },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateAgendaItem } = await import('@/lib/actions/agenda-items')
    await updateAgendaItem('item-uuid', 'meeting-uuid', { title: 'New title' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_agenda_item_and_audit',
      expect.objectContaining({
        p_agenda_item_id: 'item-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_patch: { title: 'New title' },
        p_before: { title: 'Original' },
      })
    )
  })

  it('location independence: updateMeeting location does not affect agenda lock', async () => {
    // The agenda lock is purely based on meeting.status, not location.
    // A meeting with a location set is still locked once status === 'open'.
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({
      data: { ...MEETING, status: 'open', location: 'Killer Kebab office' },
      error: null,
    })
    const { updateAgendaItem } = await import('@/lib/actions/agenda-items')
    const result = await updateAgendaItem('item-uuid', 'meeting-uuid', { title: 'X' })
    expect(result.error).toMatch(/cannot be modified/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })
})
