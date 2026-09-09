/**
 * Tests for lib/actions/planday-import.ts
 *
 * Verifies:
 *   - getKKEmployeesForLinking: auth gate, success path
 *   - executeBootstrapImport: auth gate, empty decisions, credential errors
 *   - CREATE_NEW: server fills name/birthday/started_on from fresh Planday data
 *   - LINK_EXISTING: passes offer_ fields, requires existingEmployeeId
 *   - SKIP: passed straight through
 *   - Stale-preview safety: employee absent from fresh Planday data → auto-SKIP
 *   - RPC called via user-JWT client with correct portal_id
 *   - RPC error propagated cleanly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()

  // Planday auth
  const mockGetPlandayCredentials = vi.fn()
  const mockUpdatePlandayPortal = vi.fn()

  // Planday client
  const mockGetPlandayAccessToken = vi.fn()
  const mockGetPortal = vi.fn()
  const mockGetActiveEmployees = vi.fn()
  const mockGetDeactivatedEmployees = vi.fn()
  const mockGetHistoricalShifts = vi.fn()

  // Supabase service client (for getKKEmployeesForLinking)
  const mockServiceFrom = vi.fn()
  const mockServiceClient = { from: mockServiceFrom }

  // Supabase user-JWT client (for RPC)
  const mockRpc = vi.fn()
  const mockUserClient = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockGetPlandayCredentials,
    mockUpdatePlandayPortal,
    mockGetPlandayAccessToken,
    mockGetPortal,
    mockGetActiveEmployees,
    mockGetDeactivatedEmployees,
    mockGetHistoricalShifts,
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
  getPlandayAccessToken:                mocks.mockGetPlandayAccessToken,
  getPortal:                            mocks.mockGetPortal,
  getActiveEmployeesWithBirthDate:      mocks.mockGetActiveEmployees,
  getDeactivatedEmployeesWithBirthDate: mocks.mockGetDeactivatedEmployees,
  getHistoricalShifts:                  mocks.mockGetHistoricalShifts,
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
const ACCESS_TOKEN = 'at-xyz'
const PORTAL       = { id: 42, name: 'Killer Kebab' }

function setupHappyPlandardayMocks(
  activeEmps:     { id: number; firstName: string | null; lastName: string | null; birthDate: string | null }[] = [],
  deactivatedEmps: typeof activeEmps = [],
  shifts:         { id: number; employeeId: number | null; date: string }[] = [],
) {
  mocks.mockGetPlandayCredentials.mockResolvedValue(CREDENTIALS)
  mocks.mockGetPlandayAccessToken.mockResolvedValue(ACCESS_TOKEN)
  mocks.mockGetPortal.mockResolvedValue(PORTAL)
  mocks.mockGetActiveEmployees.mockResolvedValue(activeEmps)
  mocks.mockGetDeactivatedEmployees.mockResolvedValue(deactivatedEmps)
  mocks.mockGetHistoricalShifts.mockResolvedValue(shifts)
  mocks.mockUpdatePlandayPortal.mockResolvedValue(undefined)
  mocks.mockRpc.mockResolvedValue({
    data: { created: 0, linked: 0, skipped: 0, active_new: 0, former_new: 0 },
    error: null,
  })
}

// ── Import under test ─────────────────────────────────────────────────────────

import { getKKEmployeesForLinking, executeBootstrapImport } from '@/lib/actions/planday-import'

// ── getKKEmployeesForLinking ──────────────────────────────────────────────────

describe('getKKEmployeesForLinking', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getKKEmployeesForLinking()
    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockServiceFrom).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    const result = await getKKEmployeesForLinking()
    expect(result.error).toBe('Not authorised')
    expect(mocks.mockServiceFrom).not.toHaveBeenCalled()
  })

  it('returns employees ordered by name', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockServiceFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 'emp-1', name: 'Alice B' },
            { id: 'emp-2', name: 'Zara X' },
          ],
          error: null,
        }),
      }),
    })

    const result = await getKKEmployeesForLinking()
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(2)
    expect(result.data![0].name).toBe('Alice B')
  })

  it('propagates DB errors', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockServiceFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB exploded' } }),
      }),
    })

    const result = await getKKEmployeesForLinking()
    expect(result.error).toMatch(/DB exploded/)
  })
})

// ── executeBootstrapImport ────────────────────────────────────────────────────

describe('executeBootstrapImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupHappyPlandardayMocks()
  })

  it('rejects unauthenticated callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await executeBootstrapImport([])
    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('rejects non-admin callers', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    const result = await executeBootstrapImport([])
    expect(result.error).toBe('Not authorised')
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('rejects empty decisions array', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const result = await executeBootstrapImport([])
    expect(result.error).toMatch(/No decisions/)
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('returns clean error when credentials are missing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayCredentials.mockRejectedValue(new Error('not configured'))
    const result = await executeBootstrapImport([
      { externalId: '1', action: 'CREATE_NEW' },
    ])
    expect(result.error).toMatch(/credentials not configured/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns clean error on Planday API failure', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayAccessToken.mockRejectedValue(new Error('invalid_grant'))
    const result = await executeBootstrapImport([
      { externalId: '1', action: 'CREATE_NEW' },
    ])
    expect(result.error).toMatch(/Could not connect to Planday/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls RPC via user-JWT client with correct portal_id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 10, firstName: 'Anna', lastName: 'K', birthDate: null },
    ])

    await executeBootstrapImport([{ externalId: '10', action: 'CREATE_NEW' }])

    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'planday_bootstrap_import',
      expect.objectContaining({ p_portal_id: '42' }),
    )
  })

  it('CREATE_NEW: fills name, employment_status, birthday from fresh Planday data', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 10, firstName: 'Anna', lastName: 'Keller', birthDate: '1995-08-22' },
    ])

    await executeBootstrapImport([{ externalId: '10', action: 'CREATE_NEW' }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    const decision = p_decisions[0]
    expect(decision.action).toBe('CREATE_NEW')
    expect(decision.name).toBe('Anna Keller')
    expect(decision.employment_status).toBe('active')
    expect(decision.birthday_month).toBe(8)
    expect(decision.birthday_day).toBe(22)
    expect(decision.external_id).toBe('10')
  })

  it('CREATE_NEW: sets started_on to earliest known shift', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 20, firstName: 'Shift', lastName: 'Worker', birthDate: null },
    ])
    mocks.mockGetHistoricalShifts.mockResolvedValue([
      { id: 1, employeeId: 20, date: '2022-05-10' },
      { id: 2, employeeId: 20, date: '2021-01-15' },  // earliest
      { id: 3, employeeId: 20, date: '2023-09-01' },
    ])

    await executeBootstrapImport([{ externalId: '20', action: 'CREATE_NEW' }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    expect(p_decisions[0].started_on).toBe('2021-01-15')
  })

  it('CREATE_NEW: started_on is null when no shifts exist', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 30, firstName: 'No', lastName: 'Shifts', birthDate: null },
    ])

    await executeBootstrapImport([{ externalId: '30', action: 'CREATE_NEW' }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    expect(p_decisions[0].started_on).toBeNull()
  })

  it('CREATE_NEW: deactivated employee gets employment_status "left"', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetDeactivatedEmployees.mockResolvedValue([
      { id: 40, firstName: 'Former', lastName: 'Staff', birthDate: null },
    ])

    await executeBootstrapImport([{ externalId: '40', action: 'CREATE_NEW' }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    expect(p_decisions[0].employment_status).toBe('left')
  })

  it('LINK_EXISTING: passes offer fields and employee_id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 50, firstName: 'Sara', lastName: 'J', birthDate: '1990-03-14' },
    ])

    await executeBootstrapImport([{
      externalId: '50', action: 'LINK_EXISTING', existingEmployeeId: 'emp-sara-uuid',
    }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    const d = p_decisions[0]
    expect(d.action).toBe('LINK_EXISTING')
    expect(d.employee_id).toBe('emp-sara-uuid')
    expect(d.offer_birthday_month).toBe(3)
    expect(d.offer_birthday_day).toBe(14)
    expect(d.external_id).toBe('50')
  })

  it('LINK_EXISTING: rejects when existingEmployeeId is missing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 60, firstName: 'No', lastName: 'Link', birthDate: null },
    ])

    const result = await executeBootstrapImport([{
      externalId: '60', action: 'LINK_EXISTING',
      // existingEmployeeId intentionally absent
    }])

    expect(result.error).toMatch(/LINK_EXISTING requires existingEmployeeId/)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('SKIP: passed straight through without Planday data lookup', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    // externalId 99 is NOT in any Planday response — SKIP should still work
    mocks.mockGetActiveEmployees.mockResolvedValue([])

    await executeBootstrapImport([{ externalId: '99', action: 'SKIP' }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    expect(p_decisions[0]).toEqual({ external_id: '99', action: 'SKIP' })
  })

  it('stale-preview safety: employee absent from fresh Planday data → auto-SKIP', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    // Employee 77 was in preview but is no longer returned by Planday (removed)
    mocks.mockGetActiveEmployees.mockResolvedValue([])
    mocks.mockGetDeactivatedEmployees.mockResolvedValue([])

    await executeBootstrapImport([{ externalId: '77', action: 'CREATE_NEW' }])

    const [, { p_decisions }] = mocks.mockRpc.mock.calls[0]
    expect(p_decisions[0].action).toBe('SKIP')
  })

  it('propagates RPC error cleanly', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 80, firstName: 'Test', lastName: 'User', birthDate: null },
    ])
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'Portal ID mismatch' } })

    const result = await executeBootstrapImport([{ externalId: '80', action: 'CREATE_NEW' }])

    expect(result.error).toMatch(/Portal ID mismatch/)
    expect(result.data).toBeUndefined()
  })

  it('returns import result counts from RPC', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 90, firstName: 'New', lastName: 'Person', birthDate: null },
    ])
    mocks.mockRpc.mockResolvedValue({
      data: { created: 1, linked: 0, skipped: 0, active_new: 1, former_new: 0 },
      error: null,
    })

    const result = await executeBootstrapImport([{ externalId: '90', action: 'CREATE_NEW' }])

    expect(result.error).toBeUndefined()
    expect(result.data?.created).toBe(1)
    expect(result.data?.active_new).toBe(1)
  })
})
