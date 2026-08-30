/**
 * Tests for lib/actions/change-requests.ts server actions.
 *
 * All mutations go through SECURITY DEFINER stored procedures via the
 * service client's rpc(). Each test verifies:
 *   - authentication gate fires first
 *   - input validation fires before any DB call
 *   - permission check fires BEFORE the rpc is called (security regression)
 *   - rpc failures propagate as action errors
 *   - rpc is called with the correct arguments on the happy path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  // Separate single() endpoints for tasks and change_requests tables
  const mockTaskSelectSingle = vi.fn()
  const mockCrSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'tasks') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockTaskSelectSingle }),
        }),
      }
    }
    if (table === 'change_requests') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: mockCrSelectSingle }),
          }),
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
    mockTaskSelectSingle,
    mockCrSelectSingle,
    mockFrom,
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

// Task created by SUPER_ADMIN, assigned to MEMBER
const TASK = {
  id: 'task-uuid',
  created_by_user_id: SUPER_ADMIN_USER.id,
  owner_user_id: MEMBER_USER.id,
  status: 'in_progress' as const,
}

// Pending change request submitted by MEMBER for SUPER_ADMIN's task
const CHANGE_REQUEST = {
  id: 'cr-uuid',
  entity_type: 'task',
  entity_id: TASK.id,
  requester_id: MEMBER_USER.id,
  proposed_changes: { due_at: '2025-12-31T12:00:00Z' },
  reason: 'I need more time',
  status: 'pending' as const,
  reviewed_by_id: null,
  review_note: null,
  reviewed_at: null,
  task: { created_by_user_id: SUPER_ADMIN_USER.id },
}

// ---- createTaskChangeRequest ------------------------------------------------

describe('createTaskChangeRequest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, 'Need time')
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
  })

  it('returns error when reason is empty', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, '   ')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when no changes are proposed', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', {}, 'Some reason')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when task is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockTaskSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, 'Need time')
    expect(result.error).toBeTruthy()
  })

  it('returns error when task is already done or cancelled', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockTaskSelectSingle.mockResolvedValue({ data: { ...TASK, status: 'done' }, error: null })
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, 'Need time')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Security regression: creator already has full edit authority — the change-request
  // path is for users who CANNOT directly edit the task's commitment terms.
  it('returns error when the creator (SUPER_ADMIN) tries to submit a change request', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockTaskSelectSingle.mockResolvedValue({ data: TASK, error: null })
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, 'Need time')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('assignee (MEMBER) can submit a change request', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockTaskSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'new-cr-uuid', error: null })
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, 'Need time')
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-cr-uuid')
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockTaskSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31' }, 'Need time')
    expect(result.error).toBeTruthy()
  })

  it('calls create_change_request_and_audit rpc with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockTaskSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockRpc.mockResolvedValue({ data: 'new-cr-uuid', error: null })
    const { createTaskChangeRequest } = await import('@/lib/actions/change-requests')
    await createTaskChangeRequest('task-uuid', { due_at: '2025-12-31T00:00:00Z' }, 'Need more time')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_change_request_and_audit',
      expect.objectContaining({
        p_entity_type:      'task',
        p_entity_id:        'task-uuid',
        p_requester_id:     MEMBER_USER.id,
        p_proposed_changes: { due_at: '2025-12-31T00:00:00Z' },
        p_reason:           'Need more time',
      })
    )
  })
})

// ---- approveChangeRequest ---------------------------------------------------

describe('approveChangeRequest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { approveChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await approveChangeRequest('cr-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when change request is not found or already reviewed', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { approveChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await approveChangeRequest('cr-uuid')
    expect(result.error).toBeTruthy()
  })

  // Security regression: MEMBER who is not the task creator must not approve.
  it('returns error when MEMBER (non-creator) tries to approve', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    const { approveChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await approveChangeRequest('cr-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can approve any change request', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { approveChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await approveChangeRequest('cr-uuid')
    expect(result.error).toBeUndefined()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { approveChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await approveChangeRequest('cr-uuid')
    expect(result.error).toBeTruthy()
  })

  it('calls approve_change_request_and_audit rpc with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { approveChangeRequest } = await import('@/lib/actions/change-requests')
    await approveChangeRequest('cr-uuid', 'Approved, looks good')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'approve_change_request_and_audit',
      expect.objectContaining({
        p_change_request_id: 'cr-uuid',
        p_reviewer_id:       SUPER_ADMIN_USER.id,
        p_review_note:       'Approved, looks good',
      })
    )
  })
})

// ---- rejectChangeRequest ----------------------------------------------------

describe('rejectChangeRequest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { rejectChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await rejectChangeRequest('cr-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when change request is not found or already reviewed', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { rejectChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await rejectChangeRequest('cr-uuid')
    expect(result.error).toBeTruthy()
  })

  // Security regression: MEMBER who is not the task creator must not reject.
  it('returns error when MEMBER (non-creator) tries to reject', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    const { rejectChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await rejectChangeRequest('cr-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can reject any change request', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { rejectChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await rejectChangeRequest('cr-uuid')
    expect(result.error).toBeUndefined()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { rejectChangeRequest } = await import('@/lib/actions/change-requests')
    const result = await rejectChangeRequest('cr-uuid')
    expect(result.error).toBeTruthy()
  })

  it('calls reject_change_request_and_audit rpc with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCrSelectSingle.mockResolvedValue({ data: CHANGE_REQUEST, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { rejectChangeRequest } = await import('@/lib/actions/change-requests')
    await rejectChangeRequest('cr-uuid', 'Not justified')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'reject_change_request_and_audit',
      expect.objectContaining({
        p_change_request_id: 'cr-uuid',
        p_reviewer_id:       SUPER_ADMIN_USER.id,
        p_review_note:       'Not justified',
      })
    )
  })
})
