/**
 * Tests for lib/actions/marketing/permissions.ts server actions.
 *
 * Key invariants:
 *   - grantMarketingPermission and revokeMarketingPermission are SUPER_ADMIN-only
 *   - actor identity ALWAYS comes from getCurrentUser, never from client input
 *   - idempotent grant (already_present) does NOT write an audit event
 *   - idempotent revoke (not_present) does NOT write an audit event
 *   - RPC is NOT called when the permission check fails (security regression)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRpc = vi.fn()

  const mockUserRows: { permission: string }[] = []
  const mockFrom = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: mockUserRows, error: null }),
    }),
  }))

  const mockClient = { from: mockFrom }
  const mockServiceClient = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockRpc,
    mockUserRows,
    mockClient,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn().mockResolvedValue(mocks.mockClient),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUPER_ADMIN = { id: 'admin-uuid', role: 'SUPER_ADMIN' as const }
const MEMBER      = { id: 'member-uuid', role: 'MEMBER' as const }
const UM          = { id: 'um-uuid',     role: 'UM' as const }
const TARGET_USER_ID = 'target-uuid'

// ── grantMarketingPermission ──────────────────────────────────────────────────

describe('grantMarketingPermission', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error and does not call RPC when unauthenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await grantMarketingPermission(TARGET_USER_ID, 'paid_approve')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error and does not call RPC when caller is MEMBER', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await grantMarketingPermission(TARGET_USER_ID, 'paid_approve')
    expect(result.error).toContain('SUPER_ADMIN')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error and does not call RPC when caller is UM', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM)
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await grantMarketingPermission(TARGET_USER_ID, 'content_approve')
    expect(result.error).toContain('SUPER_ADMIN')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls grant RPC with actor from authenticated server state', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValue({ data: 'granted', error: null })
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    await grantMarketingPermission(TARGET_USER_ID, 'reviews_approve')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'grant_marketing_permission_and_audit',
      {
        p_user_id:       TARGET_USER_ID,
        p_permission:    'reviews_approve',
        p_actor_user_id: SUPER_ADMIN.id,  // actor comes from getCurrentUser, not client
      }
    )
  })

  it('returns status granted when RPC reports a new row was inserted', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValue({ data: 'granted', error: null })
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await grantMarketingPermission(TARGET_USER_ID, 'paid_manage')
    expect(result.error).toBeUndefined()
    expect(result.data?.status).toBe('granted')
  })

  it('returns status already_present when permission already existed (idempotent — no audit)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // RPC returns already_present because the row already existed — no audit was written
    mocks.mockRpc.mockResolvedValue({ data: 'already_present', error: null })
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await grantMarketingPermission(TARGET_USER_ID, 'ideas_approve')
    expect(result.error).toBeUndefined()
    expect(result.data?.status).toBe('already_present')
    // RPC was still called — the idempotency check happens inside the SQL function
    expect(mocks.mockRpc).toHaveBeenCalledOnce()
  })

  it('returns error when RPC fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'constraint violation' } })
    const { grantMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await grantMarketingPermission(TARGET_USER_ID, 'paid_approve')
    expect(result.error).toBeTruthy()
  })
})

// ── revokeMarketingPermission ─────────────────────────────────────────────────

describe('revokeMarketingPermission', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error and does not call RPC when unauthenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { revokeMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await revokeMarketingPermission(TARGET_USER_ID, 'paid_approve')
    expect(result.error).toBeTruthy()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error and does not call RPC when caller is MEMBER', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    const { revokeMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await revokeMarketingPermission(TARGET_USER_ID, 'paid_approve')
    expect(result.error).toContain('SUPER_ADMIN')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls revoke RPC with actor from authenticated server state', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValue({ data: 'revoked', error: null })
    const { revokeMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    await revokeMarketingPermission(TARGET_USER_ID, 'content_manage')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'revoke_marketing_permission_and_audit',
      {
        p_user_id:       TARGET_USER_ID,
        p_permission:    'content_manage',
        p_actor_user_id: SUPER_ADMIN.id,  // actor from getCurrentUser, not client
      }
    )
  })

  it('returns status revoked when RPC reports a row was deleted', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValue({ data: 'revoked', error: null })
    const { revokeMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await revokeMarketingPermission(TARGET_USER_ID, 'reviews_manage')
    expect(result.error).toBeUndefined()
    expect(result.data?.status).toBe('revoked')
  })

  it('returns status not_present when permission did not exist (idempotent — no audit)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // RPC returns not_present because no row existed — no audit was written
    mocks.mockRpc.mockResolvedValue({ data: 'not_present', error: null })
    const { revokeMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await revokeMarketingPermission(TARGET_USER_ID, 'reviews_approve')
    expect(result.error).toBeUndefined()
    expect(result.data?.status).toBe('not_present')
    expect(mocks.mockRpc).toHaveBeenCalledOnce()
  })

  it('returns error when RPC fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'delete failed' } })
    const { revokeMarketingPermission } = await import('@/lib/actions/marketing/permissions')
    const result = await revokeMarketingPermission(TARGET_USER_ID, 'ideas_approve')
    expect(result.error).toBeTruthy()
  })
})

// ── getUserMarketingPermissions ───────────────────────────────────────────────

describe('getUserMarketingPermissions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty array when user has no permission rows', async () => {
    mocks.mockClient.from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    })
    const { getUserMarketingPermissions } = await import('@/lib/actions/marketing/permissions')
    const result = await getUserMarketingPermissions('some-user-id')
    expect(result).toEqual([])
  })

  it('returns permission keys from DB rows', async () => {
    mocks.mockClient.from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ permission: 'paid_approve' }, { permission: 'reviews_manage' }],
          error: null,
        }),
      }),
    })
    const { getUserMarketingPermissions } = await import('@/lib/actions/marketing/permissions')
    const result = await getUserMarketingPermissions('some-user-id')
    expect(result).toEqual(['paid_approve', 'reviews_manage'])
  })

  it('returns empty array on DB error', async () => {
    mocks.mockClient.from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: { message: 'db error' } }),
      }),
    })
    const { getUserMarketingPermissions } = await import('@/lib/actions/marketing/permissions')
    const result = await getUserMarketingPermissions('some-user-id')
    expect(result).toEqual([])
  })
})
