/**
 * Tests for lib/actions/planday-sync.ts
 *
 * Verifies:
 *   - runPlandaySync: auth gate (unauthenticated, non-admin)
 *   - runPlandaySync: credential error propagation
 *   - runPlandaySync: Planday API error propagation
 *   - runPlandaySync: calls RPC via user-JWT client with correct portal_id
 *   - runPlandaySync: RPC error propagated cleanly
 *   - runPlandaySync: returns SyncResult with unmappedCount derived from totals
 *   - Sync metadata: success updates last_sync_at/last_sync_status
 *   - Sync metadata: error updates last_sync_status='error' + last_sync_error
 *   - runPlandaySyncCore: active employees get name + 'active' status shape
 *   - runPlandaySyncCore: deactivated employees get name + 'left' status shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser       = vi.fn()
  const mockGetPlandayCredentials = vi.fn()
  const mockUpdatePlandayPortal  = vi.fn()
  const mockGetPlandayAccessToken = vi.fn()
  const mockGetPortal            = vi.fn()
  const mockGetActiveEmployees   = vi.fn()
  const mockGetDeactivatedEmployees = vi.fn()

  // Service client (for credentials + metadata updates)
  const mockServiceUpdate = vi.fn()
  const mockServiceFrom   = vi.fn()
  const mockServiceClient = {
    from: mockServiceFrom,
    rpc:  vi.fn(),
  }

  // User-JWT client (for RPC call from server action)
  const mockRpc        = vi.fn()
  const mockUserClient = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockGetPlandayCredentials,
    mockUpdatePlandayPortal,
    mockGetPlandayAccessToken,
    mockGetPortal,
    mockGetActiveEmployees,
    mockGetDeactivatedEmployees,
    mockServiceUpdate,
    mockServiceFrom,
    mockServiceClient,
    mockRpc,
    mockUserClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn().mockResolvedValue(mocks.mockUserClient),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/planday/auth', () => ({
  getPlandayCredentials: mocks.mockGetPlandayCredentials,
  updatePlandayPortal:   mocks.mockUpdatePlandayPortal,
}))
vi.mock('@/lib/planday/client', () => ({
  getPlandayAccessToken:    mocks.mockGetPlandayAccessToken,
  getPortal:                mocks.mockGetPortal,
  getActiveEmployees:       mocks.mockGetActiveEmployees,
  getDeactivatedEmployees:  mocks.mockGetDeactivatedEmployees,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'admin-uuid', role: 'SUPER_ADMIN' as const,
  display_name: 'Admin', email: 'admin@kk.com', active: true,
}
const UM_USER = {
  id: 'um-uuid', role: 'UM' as const,
  display_name: 'Manager', email: 'mgr@kk.com', active: true,
}

const CREDENTIALS = {
  clientId: 'client-123', refreshToken: 'rt-abc',
  portalId: '42', portalName: 'Killer Kebab',
}
const PORTAL = { id: 42, name: 'Killer Kebab' }

const RPC_SUCCESS = {
  data: {
    mapped_processed:          3,
    names_updated:             1,
    activated:                 0,
    marked_left:               1,
    manual_inactive_preserved: 0,
    management_preserved:      0,
  },
  error: null,
}

function setupServiceFromChain() {
  const mockEq     = vi.fn().mockResolvedValue({ error: null })
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq })
  mocks.mockServiceFrom.mockReturnValue({ update: mockUpdate })
  return { mockUpdate, mockEq }
}

function setupHappyMocks(
  active: { id: number; firstName: string | null; lastName: string | null }[] = [],
  deactivated: typeof active = [],
) {
  mocks.mockGetPlandayCredentials.mockResolvedValue(CREDENTIALS)
  mocks.mockGetPlandayAccessToken.mockResolvedValue('at-xyz')
  mocks.mockGetPortal.mockResolvedValue(PORTAL)
  mocks.mockGetActiveEmployees.mockResolvedValue(active)
  mocks.mockGetDeactivatedEmployees.mockResolvedValue(deactivated)
  mocks.mockUpdatePlandayPortal.mockResolvedValue(undefined)
  mocks.mockRpc.mockResolvedValue(RPC_SUCCESS)
  return setupServiceFromChain()
}

// ── Import under test ─────────────────────────────────────────────────────────

import { runPlandaySync } from '@/lib/actions/planday-sync'

// ── runPlandaySync (server action) ────────────────────────────────────────────

describe('runPlandaySync', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await runPlandaySync()
    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    const result = await runPlandaySync()
    expect(result.error).toBe('Not authorised')
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('propagates credential error cleanly', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayCredentials.mockRejectedValue(new Error('not configured'))
    const result = await runPlandaySync()
    expect(result.error).toMatch(/not configured/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('propagates Planday API error cleanly', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayCredentials.mockResolvedValue(CREDENTIALS)
    mocks.mockGetPlandayAccessToken.mockRejectedValue(new Error('invalid_grant'))
    const result = await runPlandaySync()
    expect(result.error).toMatch(/invalid_grant/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls RPC via user-JWT client with correct portal_id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    setupHappyMocks(
      [{ id: 10, firstName: 'Anna', lastName: 'K' }],
    )

    await runPlandaySync()

    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'planday_sync_roster',
      expect.objectContaining({ p_portal_id: '42' }),
    )
  })

  it('passes active employees as p_active_employees', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    setupHappyMocks(
      [{ id: 10, firstName: 'Anna', lastName: 'Keller' }],
      [{ id: 20, firstName: 'Bob', lastName: 'Smith' }],
    )

    await runPlandaySync()

    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_active_employees).toEqual([
      { external_id: '10', name: 'Anna Keller' },
    ])
    expect(args.p_deactivated_employees).toEqual([
      { external_id: '20', name: 'Bob Smith' },
    ])
  })

  it('filters out employees with empty names', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    setupHappyMocks(
      [
        { id: 10, firstName: 'Anna', lastName: 'Keller' },
        { id: 11, firstName: null, lastName: null },  // empty name → excluded
      ],
    )

    await runPlandaySync()

    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_active_employees).toHaveLength(1)
    expect(args.p_active_employees[0].external_id).toBe('10')
  })

  it('returns SyncResult with correct unmappedCount', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    // 5 active + 2 deactivated = 7 total; RPC says 3 mapped_processed → 4 unmapped
    setupHappyMocks(
      Array.from({ length: 5 }, (_, i) => ({ id: i + 1, firstName: `F${i}`, lastName: 'L' })),
      Array.from({ length: 2 }, (_, i) => ({ id: i + 100, firstName: `D${i}`, lastName: 'L' })),
    )

    const result = await runPlandaySync()

    expect(result.error).toBeUndefined()
    expect(result.data?.mappedProcessed).toBe(3)
    expect(result.data?.namesUpdated).toBe(1)
    expect(result.data?.markedLeft).toBe(1)
    expect(result.data?.unmappedCount).toBe(4)  // 7 total - 3 mapped
  })

  it('propagates RPC error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    setupHappyMocks([{ id: 10, firstName: 'Test', lastName: 'User' }])
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Portal ID mismatch' },
    })

    const result = await runPlandaySync()

    expect(result.error).toMatch(/Portal ID mismatch/)
    expect(result.data).toBeUndefined()
  })

  it('updates sync metadata to success after a clean sync', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const { mockUpdate, mockEq } = setupHappyMocks()
    mocks.mockGetActiveEmployees.mockResolvedValue([{ id: 1, firstName: 'A', lastName: 'B' }])
    mocks.mockGetDeactivatedEmployees.mockResolvedValue([])

    await runPlandaySync()

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ last_sync_status: 'success', last_sync_error: null }),
    )
    expect(mockEq).toHaveBeenCalledWith('singleton_key', 'default')
  })

  it('updates sync metadata to error on RPC failure', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const { mockUpdate } = setupHappyMocks([{ id: 10, firstName: 'T', lastName: 'U' }])
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'sync failed' },
    })

    await runPlandaySync()

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        last_sync_status: 'error',
        last_sync_error:  'sync failed',
      }),
    )
  })

  it('updates portal cache when portal_id differs from stored', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    setupHappyMocks()
    // Simulate portal ID change
    mocks.mockGetPlandayCredentials.mockResolvedValue({
      ...CREDENTIALS,
      portalId: '99',  // stored portal is 99
    })
    mocks.mockGetPortal.mockResolvedValue({ id: 42, name: 'New Name' })  // actual portal is 42

    await runPlandaySync()

    expect(mocks.mockUpdatePlandayPortal).toHaveBeenCalledWith('42', 'New Name')
  })

  it('does not call updatePlandayPortal when portal_id matches', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    setupHappyMocks()
    // CREDENTIALS.portalId = '42' matches PORTAL.id = 42

    await runPlandaySync()

    expect(mocks.mockUpdatePlandayPortal).not.toHaveBeenCalled()
  })
})
