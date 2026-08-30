/**
 * Tests for lib/actions/meeting-outcomes.ts server actions.
 *
 * Verifies permission gates, rpc name/args, and error propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockMeetingSelectSingle = vi.fn()
  const mockOutcomeSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'meetings') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockMeetingSelectSingle }),
        }),
      }
    }
    if (table === 'meeting_outcomes') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockOutcomeSelectSingle }),
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
    mockOutcomeSelectSingle,
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

const MEETING_OPEN = {
  id: 'meeting-uuid',
  status: 'open',
  owner_user_id: SUPER_ADMIN_USER.id,
}

const MEETING_DRAFT = { ...MEETING_OPEN, status: 'draft' }
const MEETING_PUBLISHED = { ...MEETING_OPEN, status: 'published' }

// ---- createMeetingOutcome ---------------------------------------------------

describe('createMeetingOutcome', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await createMeetingOutcome('meeting-uuid', { kind: 'task', title: 'Follow up' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER (non-owner) tries to add outcome', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const { createMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await createMeetingOutcome('meeting-uuid', { kind: 'task', title: 'Follow up' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when meeting is published', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING_PUBLISHED, error: null })
    const { createMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await createMeetingOutcome('meeting-uuid', { kind: 'task', title: 'Follow up' })
    expect(result.error).toContain('open or draft')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('allows creating outcomes on a draft meeting', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING_DRAFT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'outcome-uuid', error: null })
    const { createMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await createMeetingOutcome('meeting-uuid', { kind: 'decision', title: 'We decided X' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('outcome-uuid')
  })

  it('calls create_meeting_outcome_and_audit with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'outcome-uuid', error: null })
    const { createMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    await createMeetingOutcome('meeting-uuid', { kind: 'task', title: 'Assign budget', sort_order: 1 })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_meeting_outcome_and_audit',
      expect.objectContaining({
        p_meeting_id: 'meeting-uuid',
        p_kind: 'task',
        p_title: 'Assign budget',
        p_sort_order: 1,
        p_proposed_by_user_id: SUPER_ADMIN_USER.id,
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })
})

// ---- removeMeetingOutcome ---------------------------------------------------

describe('removeMeetingOutcome', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { removeMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await removeMeetingOutcome('outcome-uuid', 'meeting-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER (non-owner) tries to remove outcome', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    const { removeMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await removeMeetingOutcome('outcome-uuid', 'meeting-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls remove_meeting_outcome_and_audit on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockMeetingSelectSingle.mockResolvedValue({ data: MEETING_OPEN, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { removeMeetingOutcome } = await import('@/lib/actions/meeting-outcomes')
    const result = await removeMeetingOutcome('outcome-uuid', 'meeting-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'remove_meeting_outcome_and_audit',
      expect.objectContaining({
        p_outcome_id: 'outcome-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })
})
