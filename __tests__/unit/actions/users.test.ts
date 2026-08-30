/**
 * Tests for lib/actions/users.ts server actions.
 *
 * All mutations go through SECURITY DEFINER stored procedures via the
 * service client's rpc(). Each test verifies:
 *   - SUPER_ADMIN-only permission gate fires before rpc is called
 *   - last-SUPER_ADMIN lockout fires before rpc is called
 *   - rpc failures propagate as action errors
 *   - rpc is NOT called when a permission check fails (security regression)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  // Supabase user-session client — used for SELECT (permission/lockout checks)
  const mockSelectSingle = vi.fn()
  const mockSelectCount = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'app_users') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockImplementation((cols: string) => {
        // count query uses head:true pattern
        if (cols.includes('count')) {
          return {
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                neq: vi.fn().mockReturnValue(mockSelectCount()),
              }),
            }),
          }
        }
        return {
          eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
        }
      }),
    }
  })

  const mockClient = { from: mockFrom }

  // Service client — all mutations go through rpc()
  const mockRpc = vi.fn()
  const mockServiceRpcFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'app_users') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            neq: vi.fn().mockResolvedValue({ count: 1, error: null }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }
  })
  const mockServiceClient = { rpc: mockRpc, from: mockServiceRpcFrom }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockSelectSingle,
    mockSelectCount,
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

const TARGET_USER = {
  id: 'target-uuid',
  role: 'MEMBER',
  active: true,
}

const SUPER_ADMIN_TARGET = {
  id: 'admin2-uuid',
  role: 'SUPER_ADMIN',
  active: true,
}

// ---- createAppUser ----------------------------------------------------------

describe('createAppUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createAppUser } = await import('@/lib/actions/users')
    const result = await createAppUser({ email: 'new@killerkebab.com', display_name: 'New', role: 'MEMBER' })
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-SUPER_ADMIN tries to create user', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { createAppUser } = await import('@/lib/actions/users')
    const result = await createAppUser({ email: 'new@killerkebab.com', display_name: 'New', role: 'MEMBER' })
    expect(result.error).toContain('SUPER_ADMIN')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'insert failed' } })
    const { createAppUser } = await import('@/lib/actions/users')
    const result = await createAppUser({ email: 'new@killerkebab.com', display_name: 'New', role: 'MEMBER' })
    expect(result.error).toBeTruthy()
  })

  it('returns new user id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-uuid', error: null })
    const { createAppUser } = await import('@/lib/actions/users')
    const result = await createAppUser({ email: 'new@killerkebab.com', display_name: 'New', role: 'MEMBER' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-uuid')
  })

  it('calls create_app_user_and_audit rpc with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-uuid', error: null })
    const { createAppUser } = await import('@/lib/actions/users')
    await createAppUser({ email: 'new@killerkebab.com', display_name: 'New User', role: 'UM' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_app_user_and_audit',
      expect.objectContaining({
        p_email:         'new@killerkebab.com',
        p_display_name:  'New User',
        p_role:          'UM',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })
})

// ---- updateAppUserRole ------------------------------------------------------

describe('updateAppUserRole', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateAppUserRole } = await import('@/lib/actions/users')
    const result = await updateAppUserRole('target-uuid', 'UM')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-SUPER_ADMIN tries to change role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { updateAppUserRole } = await import('@/lib/actions/users')
    const result = await updateAppUserRole('target-uuid', 'UM')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when target user not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { updateAppUserRole } = await import('@/lib/actions/users')
    const result = await updateAppUserRole('target-uuid', 'UM')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when trying to demote last SUPER_ADMIN', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: SUPER_ADMIN_TARGET, error: null })
    // countActiveSuperAdmins returns 0 (no other SUPER_ADMINs)
    mocks.mockServiceClient.from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            neq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          }),
        }),
      }),
    })
    const { updateAppUserRole } = await import('@/lib/actions/users')
    const result = await updateAppUserRole(SUPER_ADMIN_TARGET.id, 'MEMBER')
    expect(result.error).toContain('last')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls update_app_user_role_and_audit rpc on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TARGET_USER, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateAppUserRole } = await import('@/lib/actions/users')
    const result = await updateAppUserRole(TARGET_USER.id, 'UM')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_app_user_role_and_audit',
      expect.objectContaining({
        p_user_id:       TARGET_USER.id,
        p_new_role:      'UM',
        p_before_role:   'MEMBER',
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('returns empty success when role is unchanged', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TARGET_USER, error: null })
    const { updateAppUserRole } = await import('@/lib/actions/users')
    const result = await updateAppUserRole(TARGET_USER.id, 'MEMBER')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })
})

// ---- setAppUserActive -------------------------------------------------------

describe('setAppUserActive', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { setAppUserActive } = await import('@/lib/actions/users')
    const result = await setAppUserActive('target-uuid', false)
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when non-SUPER_ADMIN tries to deactivate', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    const { setAppUserActive } = await import('@/lib/actions/users')
    const result = await setAppUserActive('target-uuid', false)
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when trying to deactivate self', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const { setAppUserActive } = await import('@/lib/actions/users')
    const result = await setAppUserActive(SUPER_ADMIN_USER.id, false)
    expect(result.error).toContain('own')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls set_app_user_active_and_audit rpc on deactivation', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TARGET_USER, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { setAppUserActive } = await import('@/lib/actions/users')
    const result = await setAppUserActive(TARGET_USER.id, false)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'set_app_user_active_and_audit',
      expect.objectContaining({
        p_user_id:       TARGET_USER.id,
        p_active:        false,
        p_actor_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('returns empty success when active state is unchanged', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TARGET_USER, error: null }) // TARGET_USER.active = true
    const { setAppUserActive } = await import('@/lib/actions/users')
    const result = await setAppUserActive(TARGET_USER.id, true)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })
})
