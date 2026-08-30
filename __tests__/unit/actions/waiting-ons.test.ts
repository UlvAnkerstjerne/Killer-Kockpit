/**
 * Tests for lib/actions/waiting-ons.ts server actions.
 *
 * All consequential mutations go through SECURITY DEFINER stored procedures
 * via the service client's rpc(). Each test verifies:
 *   - the correct rpc name and arguments are used
 *   - a rpc failure propagates as an action error
 *   - permission checks fire BEFORE the rpc is ever called (security
 *     regression: EXECUTE is also revoked from non-service roles at the
 *     SQL level, preventing direct bypass via the Supabase REST API)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'waiting_ons') throw new Error(`Unexpected table: ${table}`)
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

const WAITING_ON = {
  id: 'wo-uuid',
  title: 'Test Waiting On',
  owner_user_id: SUPER_ADMIN_USER.id,
  status: 'open' as const,
  waiting_for_name: 'External Person',
  project_id: null,
  due_at: null,
  notes: null,
}

// ---- createWaitingOn --------------------------------------------------------

describe('createWaitingOn', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await createWaitingOn({ title: 'New WO' })
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'insert failed' } })
    const { createWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await createWaitingOn({ title: 'New WO' })
    expect(result.error).toBeTruthy()
  })

  it('returns the new waiting on id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-wo-uuid', error: null })
    const { createWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await createWaitingOn({ title: 'New WO' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-wo-uuid')
  })

  it('calls create_waiting_on_and_audit rpc via the service client', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-wo-uuid', error: null })
    const { createWaitingOn } = await import('@/lib/actions/waiting-ons')
    await createWaitingOn({ title: 'New WO', waiting_for_name: 'Bob' })
    expect(mocks.mockRpc).toHaveBeenCalledOnce()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_waiting_on_and_audit',
      expect.objectContaining({
        p_title:           'New WO',
        p_actor_user_id:   SUPER_ADMIN_USER.id,
        p_owner_user_id:   SUPER_ADMIN_USER.id,
        p_waiting_for_name: 'Bob',
      })
    )
  })
})

// ---- updateWaitingOn --------------------------------------------------------

describe('updateWaitingOn', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: 'Updated' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when waiting on not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: 'Updated' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to edit a waiting on they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...WAITING_ON, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
  })

  it('does not call rpc when permission check fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...WAITING_ON, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    await updateWaitingOn('wo-uuid', { title: 'Hacked' })
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Accountability regression: UM visibility does not grant edit authority.
  it('UM cannot edit a waiting on owned by someone else', async () => {
    const UM_USER = { id: 'um-uuid', role: 'UM' as const, display_name: 'UM', email: 'um@kk.com', active: true }
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...WAITING_ON, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: 'Hijacked' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: WAITING_ON, error: null })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: WAITING_ON.title })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can edit a waiting on owned by someone else and calls the atomic _as_admin rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...WAITING_ON, owner_user_id: MEMBER_USER.id },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: 'Override' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_waiting_on_and_audit_as_admin',
      expect.objectContaining({ p_override_note: expect.any(String) })
    )
  })

  it('SUPER_ADMIN editing their own waiting on calls the standard (non-override) rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: WAITING_ON, error: null })  // WAITING_ON.owner = SUPER_ADMIN
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    await updateWaitingOn('wo-uuid', { title: 'Own WO' })
    expect(mocks.mockRpc).toHaveBeenCalledWith('update_waiting_on_and_audit', expect.any(Object))
    expect(mocks.mockRpc).not.toHaveBeenCalledWith('update_waiting_on_and_audit_as_admin', expect.any(Object))
  })

  it('calls update_waiting_on_and_audit rpc with patch and before objects', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: WAITING_ON, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    await updateWaitingOn('wo-uuid', { title: 'New Title' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_waiting_on_and_audit',
      expect.objectContaining({
        p_waiting_on_id: 'wo-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_patch:  { title: 'New Title' },
        p_before: { title: WAITING_ON.title },
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: WAITING_ON, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { updateWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await updateWaitingOn('wo-uuid', { title: 'New Title' })
    expect(result.error).toBeTruthy()
  })
})

// ---- fulfillWaitingOn -------------------------------------------------------

describe('fulfillWaitingOn', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { fulfillWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await fulfillWaitingOn('wo-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to fulfil a waiting on they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'wo-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open' },
      error: null,
    })
    const { fulfillWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await fulfillWaitingOn('wo-uuid')
    expect(result.error).toContain('permission')
  })

  it('does not call rpc when permission check fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'wo-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open' },
      error: null,
    })
    const { fulfillWaitingOn } = await import('@/lib/actions/waiting-ons')
    await fulfillWaitingOn('wo-uuid')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls fulfill_waiting_on_and_audit rpc with before status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'wo-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open' },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { fulfillWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await fulfillWaitingOn('wo-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'fulfill_waiting_on_and_audit',
      expect.objectContaining({
        p_waiting_on_id: 'wo-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_before_status: 'open',
      })
    )
  })
})

// ---- cancelWaitingOn --------------------------------------------------------

describe('cancelWaitingOn', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { cancelWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await cancelWaitingOn('wo-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to cancel a waiting on they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'wo-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open' },
      error: null,
    })
    const { cancelWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await cancelWaitingOn('wo-uuid')
    expect(result.error).toContain('permission')
  })

  it('does not call rpc when permission check fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'wo-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open' },
      error: null,
    })
    const { cancelWaitingOn } = await import('@/lib/actions/waiting-ons')
    await cancelWaitingOn('wo-uuid')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls cancel_waiting_on_and_audit rpc with before status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'wo-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open' },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { cancelWaitingOn } = await import('@/lib/actions/waiting-ons')
    const result = await cancelWaitingOn('wo-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'cancel_waiting_on_and_audit',
      expect.objectContaining({
        p_waiting_on_id: 'wo-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_before_status: 'open',
      })
    )
  })
})
