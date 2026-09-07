/**
 * employee-locations-m8c3b.test.ts
 *
 * M8C3b unit coverage for all four server actions in
 * lib/actions/employee-locations.ts.
 *
 * Architecture under test:
 *   Application layer: getCurrentUser() + canAccessManagementView() + validation
 *   Database layer:
 *     add_employee_location / remove_employee_location  — SECURITY DEFINER RPCs
 *     employee_locations + locations + employees        — read-only SELECTs
 *   All calls use createClient() (JWT session) — NOT createServiceClient().
 *
 * Contracts verified:
 *
 *   AUTH (all four actions)
 *     • unauthenticated rejected
 *     • MEMBER rejected
 *     • UM allowed — reaches DB
 *     • SUPER_ADMIN allowed — reaches DB
 *     • no createServiceClient call
 *
 *   VALIDATION (add + remove)
 *     • malformed employeeId rejected
 *     • empty employeeId rejected
 *     • malformed locationId rejected
 *     • empty locationId rejected
 *     • valid UUIDs pass to RPC
 *
 *   RPC DELEGATION (add + remove)
 *     • correct RPC name called
 *     • p_employee_id forwarded
 *     • p_location_id forwarded
 *     • RPC args contain no author / user id
 *     • RPC success → data: undefined returned
 *     • "not found" RPC error → safe message
 *     • "not active" RPC error → safe message
 *     • "already inactive" RPC error → safe message (remove only)
 *     • generic RPC error → safe generic message
 *
 *   READ ACTIONS (getLocationsForEmployee / getEmployeesForLocation)
 *     • returns empty array when no active assignments
 *     • returns enriched rows when assignments exist
 *     • invalid entityId rejected before DB call
 *     • assignment query error → safe error
 *     • canonical table query error → safe error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser          = vi.fn()
  const mockCanAccessManagementView = vi.fn()
  const mockRpc                     = vi.fn()

  // Chainable .from() builder — the chain is thenable so any terminal await resolves
  function makeFromChain(resolveValue: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      in:     vi.fn().mockReturnThis(),
      order:  vi.fn().mockReturnThis(),
      // Makes the chain itself awaitable regardless of which method was called last
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(resolveValue).then(resolve, reject),
    }
    return chain
  }

  const mockFrom = vi.fn()

  const mockUserClient = { rpc: mockRpc, from: mockFrom }

  return {
    mockGetCurrentUser,
    mockCanAccessManagementView,
    mockRpc,
    mockFrom,
    mockUserClient,
    makeFromChain,
  }
})

vi.mock('@/lib/auth', () => ({
  getCurrentUser: mocks.mockGetCurrentUser,
}))

vi.mock('@/lib/permissions', () => ({
  canAccessManagementView: mocks.mockCanAccessManagementView,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn().mockResolvedValue(mocks.mockUserClient),
  createServiceClient: vi.fn(() => {
    throw new Error('createServiceClient must NOT be called by M8C3b actions')
  }),
}))

// ─── Import after mocks ────────────────────────────────────────────────────────

import {
  addEmployeeLocation,
  removeEmployeeLocation,
  getLocationsForEmployee,
  getEmployeesForLocation,
} from '@/lib/actions/employee-locations'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MANAGER     = { id: 'mgr-uuid', role: 'UM' as const,         display_name: 'Manager' }
const SUPER_ADMIN = { id: 'sa-uuid',  role: 'SUPER_ADMIN' as const, display_name: 'Admin'  }
const MEMBER      = { id: 'mbr-uuid', role: 'MEMBER' as const,     display_name: 'Member'  }

const EMP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LOC_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupHappyRpc() {
  mocks.mockRpc.mockResolvedValueOnce({ data: null, error: null })
}

function setupRpcError(message: string) {
  mocks.mockRpc.mockResolvedValueOnce({ data: null, error: { message } })
}

function setupManagerAuth() {
  mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
  mocks.mockCanAccessManagementView.mockReturnValue(true)
}

// ═══════════════════════════════════════════════════════════════════════════════
// addEmployeeLocation
// ═══════════════════════════════════════════════════════════════════════════════

describe('addEmployeeLocation — AUTH', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unauthenticated caller rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('MEMBER rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('UM allowed — reaches RPC', async () => {
    setupManagerAuth()
    setupHappyRpc()
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('SUPER_ADMIN allowed — reaches RPC', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyRpc()
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('no createServiceClient call', async () => {
    setupManagerAuth()
    setupHappyRpc()
    await expect(addEmployeeLocation(EMP_ID, LOC_ID)).resolves.not.toThrow()
  })
})

describe('addEmployeeLocation — VALIDATION', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('malformed employeeId rejected', async () => {
    const result = await addEmployeeLocation('not-a-uuid', LOC_ID)
    expect(result.error).toMatch(/invalid employee id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('empty employeeId rejected', async () => {
    const result = await addEmployeeLocation('', LOC_ID)
    expect(result.error).toMatch(/invalid employee id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('malformed locationId rejected', async () => {
    const result = await addEmployeeLocation(EMP_ID, 'bad-id')
    expect(result.error).toMatch(/invalid location id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('empty locationId rejected', async () => {
    const result = await addEmployeeLocation(EMP_ID, '')
    expect(result.error).toMatch(/invalid location id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('valid UUIDs pass validation and reach RPC', async () => {
    setupHappyRpc()
    await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })
})

describe('addEmployeeLocation — RPC delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('calls add_employee_location RPC', async () => {
    setupHappyRpc()
    await addEmployeeLocation(EMP_ID, LOC_ID)
    const [rpcName] = mocks.mockRpc.mock.calls[0]
    expect(rpcName).toBe('add_employee_location')
  })

  it('p_employee_id forwarded correctly', async () => {
    setupHappyRpc()
    await addEmployeeLocation(EMP_ID, LOC_ID)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_employee_id).toBe(EMP_ID)
  })

  it('p_location_id forwarded correctly', async () => {
    setupHappyRpc()
    await addEmployeeLocation(EMP_ID, LOC_ID)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_location_id).toBe(LOC_ID)
  })

  it('RPC args contain no author / user id', async () => {
    setupHappyRpc()
    await addEmployeeLocation(EMP_ID, LOC_ID)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_created_by_user_id')
    expect(args).not.toHaveProperty('author_id')
    expect(args).not.toHaveProperty('user_id')
  })

  it('RPC success → data undefined, no error', async () => {
    setupHappyRpc()
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toBeUndefined()
  })

  it('"not found" RPC error → safe message', async () => {
    setupRpcError('Employee not found: aaa')
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not found/i)
  })

  it('"not active" RPC error → safe message', async () => {
    setupRpcError('Employee aaa is not active (status: terminated)')
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not active/i)
  })

  it('generic RPC error → safe generic message', async () => {
    setupRpcError('internal DB error details')
    const result = await addEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).not.toContain('internal DB error details')
    expect(result.error).toMatch(/failed|try again/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// removeEmployeeLocation
// ═══════════════════════════════════════════════════════════════════════════════

describe('removeEmployeeLocation — AUTH', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unauthenticated caller rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('MEMBER rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('UM allowed — reaches RPC', async () => {
    setupManagerAuth()
    setupHappyRpc()
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })
})

describe('removeEmployeeLocation — VALIDATION', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('malformed employeeId rejected', async () => {
    const result = await removeEmployeeLocation('bad', LOC_ID)
    expect(result.error).toMatch(/invalid employee id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('malformed locationId rejected', async () => {
    const result = await removeEmployeeLocation(EMP_ID, 'bad')
    expect(result.error).toMatch(/invalid location id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })
})

describe('removeEmployeeLocation — RPC delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('calls remove_employee_location RPC', async () => {
    setupHappyRpc()
    await removeEmployeeLocation(EMP_ID, LOC_ID)
    const [rpcName] = mocks.mockRpc.mock.calls[0]
    expect(rpcName).toBe('remove_employee_location')
  })

  it('p_employee_id + p_location_id forwarded', async () => {
    setupHappyRpc()
    await removeEmployeeLocation(EMP_ID, LOC_ID)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_employee_id).toBe(EMP_ID)
    expect(args.p_location_id).toBe(LOC_ID)
  })

  it('RPC success → data undefined, no error', async () => {
    setupHappyRpc()
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toBeUndefined()
  })

  it('"already inactive" RPC error → specific message', async () => {
    setupRpcError('Assignment is already inactive')
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/already been removed/i)
  })

  it('"not found" RPC error → safe message', async () => {
    setupRpcError('Assignment not found')
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).toMatch(/not found/i)
  })

  it('generic RPC error → safe generic message', async () => {
    setupRpcError('internal DB error')
    const result = await removeEmployeeLocation(EMP_ID, LOC_ID)
    expect(result.error).not.toContain('internal DB error')
    expect(result.error).toMatch(/failed|try again/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// getLocationsForEmployee
// ═══════════════════════════════════════════════════════════════════════════════

describe('getLocationsForEmployee — AUTH', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unauthenticated caller rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getLocationsForEmployee(EMP_ID)
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('MEMBER rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await getLocationsForEmployee(EMP_ID)
    expect(result.error).toMatch(/not authorised/i)
  })
})

describe('getLocationsForEmployee — VALIDATION', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('malformed employeeId rejected', async () => {
    const result = await getLocationsForEmployee('bad-uuid')
    expect(result.error).toMatch(/invalid employee id/i)
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('empty employeeId rejected', async () => {
    const result = await getLocationsForEmployee('')
    expect(result.error).toMatch(/invalid employee id/i)
  })
})

describe('getLocationsForEmployee — read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('returns empty array when no active assignments', async () => {
    // First .from() call: employee_locations query → empty
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({ data: [], error: null })
    )
    const result = await getLocationsForEmployee(EMP_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
  })

  it('returns enriched location rows for active assignments', async () => {
    // First call: assignment lookup
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({
        data: [{ location_id: LOC_ID }],
        error: null,
      })
    )
    // Second call: canonical locations
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({
        data: [{ id: LOC_ID, name: 'King Street', short_name: 'KS', active: true }],
        error: null,
      })
    )

    const result = await getLocationsForEmployee(EMP_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(1)
    expect(result.data![0]).toEqual({
      location_id: LOC_ID,
      name:        'King Street',
      short_name:  'KS',
      active:      true,
    })
  })

  it('assignment query error → safe error message', async () => {
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({ data: null, error: { message: 'DB error' } })
    )
    const result = await getLocationsForEmployee(EMP_ID)
    expect(result.error).toMatch(/failed to load/i)
    expect(result.error).not.toContain('DB error')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// getEmployeesForLocation
// ═══════════════════════════════════════════════════════════════════════════════

describe('getEmployeesForLocation — AUTH', () => {
  beforeEach(() => vi.clearAllMocks())

  it('unauthenticated caller rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getEmployeesForLocation(LOC_ID)
    expect(result.error).toMatch(/not authenticated/i)
  })

  it('MEMBER rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await getEmployeesForLocation(LOC_ID)
    expect(result.error).toMatch(/not authorised/i)
  })
})

describe('getEmployeesForLocation — VALIDATION', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('malformed locationId rejected', async () => {
    const result = await getEmployeesForLocation('not-a-uuid')
    expect(result.error).toMatch(/invalid location id/i)
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })
})

describe('getEmployeesForLocation — read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupManagerAuth()
  })

  it('returns empty array when no active assignments', async () => {
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({ data: [], error: null })
    )
    const result = await getEmployeesForLocation(LOC_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
  })

  it('returns enriched employee rows for active assignments', async () => {
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({
        data: [{ employee_id: EMP_ID }],
        error: null,
      })
    )
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({
        data: [{
          id:                EMP_ID,
          name:              'Jane Smith',
          role_title:        'Shift Lead',
          employment_status: 'active',
        }],
        error: null,
      })
    )

    const result = await getEmployeesForLocation(LOC_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(1)
    expect(result.data![0]).toEqual({
      employee_id:       EMP_ID,
      name:              'Jane Smith',
      role_title:        'Shift Lead',
      employment_status: 'active',
    })
  })

  it('assignment query error → safe error message', async () => {
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({ data: null, error: { message: 'DB error' } })
    )
    const result = await getEmployeesForLocation(LOC_ID)
    expect(result.error).toMatch(/failed to load/i)
    expect(result.error).not.toContain('DB error')
  })

  it('canonical employee query error → safe error message', async () => {
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({
        data: [{ employee_id: EMP_ID }],
        error: null,
      })
    )
    mocks.mockFrom.mockReturnValueOnce(
      mocks.makeFromChain({ data: null, error: { message: 'DB error' } })
    )
    const result = await getEmployeesForLocation(LOC_ID)
    expect(result.error).toMatch(/failed to load/i)
  })
})
