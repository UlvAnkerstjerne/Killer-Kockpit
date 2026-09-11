/**
 * __tests__/unit/actions/diner-invitations.test.ts
 *
 * Tests for lib/actions/diner-invitations.ts
 *
 * Covers:
 *   - createDinerInvitation: auth gate, validation, success
 *   - cancelDinerInvitation: auth gate, status guards, success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()

  // Supabase query chain mocks
  const mockInsertSelectSingle = vi.fn()
  const mockSelect             = vi.fn()
  const mockMaybeSingle        = vi.fn()
  const mockUpdate             = vi.fn()
  const mockEq                 = vi.fn()

  const mockFrom = vi.fn()

  const mockServiceClient = { from: mockFrom }

  const mockGenerateInviteToken = vi.fn()

  return {
    mockGetCurrentUser,
    mockInsertSelectSingle,
    mockSelect,
    mockMaybeSingle,
    mockUpdate,
    mockEq,
    mockFrom,
    mockServiceClient,
    mockGenerateInviteToken,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/diner/token', () => ({
  generateInviteToken: mocks.mockGenerateInviteToken,
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUPER_ADMIN = { id: 'admin-uuid', role: 'SUPER_ADMIN' as const }
const MEMBER      = { id: 'member-uuid', role: 'MEMBER'      as const }

const TOKEN_FIXTURE = { rawToken: 'rawTok123', tokenHash: 'sha256hex' }

// ─── createDinerInvitation ────────────────────────────────────────────────────

describe('createDinerInvitation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://kockpit.example.com'
    mocks.mockGenerateInviteToken.mockReturnValue(TOKEN_FIXTURE)
  })

  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: 'Alice' })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for MEMBER role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: 'Alice' })
    expect(result.error).toBe('Not authorised')
  })

  it('returns error when NEXT_PUBLIC_APP_URL is missing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    delete process.env.NEXT_PUBLIC_APP_URL
    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: 'Alice' })
    expect(result.error).toMatch(/NEXT_PUBLIC_APP_URL/)
  })

  it('returns error when dinerName is empty', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: '   ' })
    expect(result.error).toBe('Diner name is required')
  })

  it('returns error when expiresInHours is out of range', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: 'Alice', expiresInHours: 0 })
    expect(result.error).toMatch(/expiresInHours/)
  })

  it('returns inviteUrl containing raw token on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    // Chain: from('diner_invitations').insert(...).select('id').single()
    mocks.mockFrom.mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: 'inv-uuid' }, error: null }),
        }),
      }),
    })

    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: 'Alice', expiresInHours: 48 })

    expect(result.error).toBeUndefined()
    expect(result.data?.invitationId).toBe('inv-uuid')
    expect(result.data?.inviteUrl).toContain('rawTok123')
    expect(result.data?.inviteUrl).toContain('/diner/')
  })

  it('propagates DB error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    mocks.mockFrom.mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB failure' } }),
        }),
      }),
    })

    const { createDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await createDinerInvitation({ dinerName: 'Alice' })
    expect(result.error).toMatch(/Failed to create/)
  })
})

// ─── cancelDinerInvitation ────────────────────────────────────────────────────

describe('cancelDinerInvitation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://kockpit.example.com'
  })

  it('returns error when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for MEMBER role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toBe('Not authorised')
  })

  it('returns error when invitationId is empty', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('')
    expect(result.error).toBe('invitationId is required')
  })

  it('returns error when invitation not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    })

    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toBe('Invitation not found')
  })

  it('returns error when invitation is already submitted', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'inv-uuid', status: 'submitted' }, error: null }),
        }),
      }),
    })

    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toMatch(/submitted/)
  })

  it('returns error when invitation is already expired', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'inv-uuid', status: 'expired' }, error: null }),
        }),
      }),
    })

    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toMatch(/already expired/)
  })

  it('cancels a pending invitation successfully', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
    let callCount = 0

    mocks.mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'inv-uuid', status: 'pending' }, error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: mockUpdateEq,
      }),
    })

    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')

    expect(result.error).toBeUndefined()
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'inv-uuid')
  })

  it('cancels an active invitation successfully', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })

    mocks.mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'inv-uuid', status: 'active' }, error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: mockUpdateEq,
      }),
    })

    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toBeUndefined()
  })

  it('propagates DB error on update', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    mocks.mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'inv-uuid', status: 'pending' }, error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: 'update failed' } }),
      }),
    })

    const { cancelDinerInvitation } = await import('@/lib/actions/diner-invitations')
    const result = await cancelDinerInvitation('inv-uuid')
    expect(result.error).toMatch(/Failed to cancel/)
  })
})
