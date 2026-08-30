/**
 * Tests for lib/actions/decisions.ts server actions.
 *
 * All consequential mutations go through SECURITY DEFINER stored procedures
 * via the service client's rpc(). Each test verifies:
 *   - management-only permission gate fires before rpc is called
 *   - rpc failures propagate as action errors
 *   - rpc is NOT called when a permission check fails (security regression)
 *   - historical integrity: decisions are never hard-deleted (no delete action exists)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'decisions') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
      }),
    }
  })

  const mockClient = { from: mockFrom }

  const mockRpc = vi.fn()
  const mockServiceClient = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockSelectSingle,
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

const DECISION = {
  id: 'decision-uuid',
  title: 'Test Decision',
  decision_text: 'We decided to do X.',
  rationale: null,
  owner_user_id: SUPER_ADMIN_USER.id,
  project_id: null,
  decided_at: null,
  status: 'proposed' as const,
}

// ---- createDecision ---------------------------------------------------------

describe('createDecision', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createDecision } = await import('@/lib/actions/decisions')
    const result = await createDecision({ title: 'New', decision_text: 'We decided.' })
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
  })

  it('returns error when MEMBER tries to create a decision', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { createDecision } = await import('@/lib/actions/decisions')
    const result = await createDecision({ title: 'New', decision_text: 'We decided.' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'insert failed' } })
    const { createDecision } = await import('@/lib/actions/decisions')
    const result = await createDecision({ title: 'New', decision_text: 'We decided.' })
    expect(result.error).toBeTruthy()
  })

  it('returns the new decision id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-decision-uuid', error: null })
    const { createDecision } = await import('@/lib/actions/decisions')
    const result = await createDecision({ title: 'New', decision_text: 'We decided.' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-decision-uuid')
  })

  it('calls create_decision_and_audit rpc with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-uuid', error: null })
    const { createDecision } = await import('@/lib/actions/decisions')
    await createDecision({ title: 'New Decision', decision_text: 'We decided to proceed.', status: 'approved' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_decision_and_audit',
      expect.objectContaining({
        p_title:         'New Decision',
        p_decision_text: 'We decided to proceed.',
        p_status:        'approved',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_owner_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('defaults status to proposed when not specified', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'uuid', error: null })
    const { createDecision } = await import('@/lib/actions/decisions')
    await createDecision({ title: 'New', decision_text: 'Text.' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_decision_and_audit',
      expect.objectContaining({ p_status: 'proposed' })
    )
  })
})

// ---- updateDecision ---------------------------------------------------------

describe('updateDecision', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: 'Updated' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to update a decision', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    // Ownership check now happens after fetch; provide the decision record
    mocks.mockSelectSingle.mockResolvedValue({ data: DECISION, error: null })
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Accountability regression: UM must not silently rewrite another user's decision.
  it('UM cannot update a decision owned by someone else', async () => {
    const UM_USER = { id: 'um-uuid', role: 'UM' as const, display_name: 'UM', email: 'um@kk.com', active: true }
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...DECISION, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: 'Rewritten' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Supersession (preferred over silent edits) still available to management.
  it('SUPER_ADMIN can edit any decision (override) and calls the atomic _as_admin rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...DECISION, owner_user_id: MEMBER_USER.id },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: 'Override' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_decision_and_audit_as_admin',
      expect.objectContaining({ p_override_note: expect.any(String) })
    )
  })

  it('SUPER_ADMIN editing their own decision calls the standard (non-override) rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: DECISION, error: null })  // DECISION.owner = SUPER_ADMIN
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateDecision } = await import('@/lib/actions/decisions')
    await updateDecision('decision-uuid', { title: 'Own Decision' })
    expect(mocks.mockRpc).toHaveBeenCalledWith('update_decision_and_audit', expect.any(Object))
    expect(mocks.mockRpc).not.toHaveBeenCalledWith('update_decision_and_audit_as_admin', expect.any(Object))
  })

  it('returns error when decision not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: 'Updated' })
    expect(result.error).toBeTruthy()
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: DECISION, error: null })
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: DECISION.title })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls update_decision_and_audit rpc with patch and before objects', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: DECISION, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateDecision } = await import('@/lib/actions/decisions')
    await updateDecision('decision-uuid', { title: 'New Title' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_decision_and_audit',
      expect.objectContaining({
        p_decision_id:   'decision-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_patch:  { title: 'New Title' },
        p_before: { title: DECISION.title },
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: DECISION, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { updateDecision } = await import('@/lib/actions/decisions')
    const result = await updateDecision('decision-uuid', { title: 'New Title' })
    expect(result.error).toBeTruthy()
  })
})

// ---- approveDecision --------------------------------------------------------

describe('approveDecision', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { approveDecision } = await import('@/lib/actions/decisions')
    const result = await approveDecision('decision-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to approve', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { approveDecision } = await import('@/lib/actions/decisions')
    const result = await approveDecision('decision-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when decision not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { approveDecision } = await import('@/lib/actions/decisions')
    const result = await approveDecision('decision-uuid')
    expect(result.error).toBeTruthy()
  })

  it('calls approve_decision_and_audit rpc with before status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'decision-uuid', status: 'proposed', project_id: null },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { approveDecision } = await import('@/lib/actions/decisions')
    const result = await approveDecision('decision-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'approve_decision_and_audit',
      expect.objectContaining({
        p_decision_id:          'decision-uuid',
        p_actor_user_id:        SUPER_ADMIN_USER.id,
        p_approved_by_user_id:  SUPER_ADMIN_USER.id,
        p_before_status:        'proposed',
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'decision-uuid', status: 'proposed', project_id: null },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { approveDecision } = await import('@/lib/actions/decisions')
    const result = await approveDecision('decision-uuid')
    expect(result.error).toBeTruthy()
  })
})
