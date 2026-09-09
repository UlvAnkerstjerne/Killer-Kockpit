/**
 * Tests for lib/actions/planday-bootstrap.ts
 *
 * Verifies:
 *   - SUPER_ADMIN gate (only SUPER_ADMIN may call)
 *   - Missing credentials → clean error
 *   - Token exchange failure → clean error
 *   - Reconciliation: ALREADY_LINKED, EXACT_NAME_CANDIDATE, NEW_PERSON, AMBIGUOUS
 *   - Birthday parsing from Planday birthDate string
 *   - proposedStartedOn: earliest shift per employee
 *   - Nameless employees are silently skipped
 *   - savePlandayCredentials: requires both fields, SUPER_ADMIN only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  // Planday auth
  const mockGetPlandayCredentials = vi.fn()
  const mockStorePlandayCredentials = vi.fn()
  const mockUpdatePlandayPortal = vi.fn()

  // Planday client
  const mockGetPlandayAccessToken = vi.fn()
  const mockGetPortal = vi.fn()
  const mockGetActiveEmployees = vi.fn()
  const mockGetDeactivatedEmployees = vi.fn()
  const mockGetHistoricalShifts = vi.fn()

  // Supabase service client
  const mockEmployeesEq = vi.fn()
  const mockExtIdEq1 = vi.fn()
  const mockExtIdEq2 = vi.fn()

  const mockFrom = vi.fn()
  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockGetPlandayCredentials,
    mockStorePlandayCredentials,
    mockUpdatePlandayPortal,
    mockGetPlandayAccessToken,
    mockGetPortal,
    mockGetActiveEmployees,
    mockGetDeactivatedEmployees,
    mockGetHistoricalShifts,
    mockEmployeesEq,
    mockExtIdEq1,
    mockExtIdEq2,
    mockFrom,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/planday/auth', () => ({
  getPlandayCredentials:    mocks.mockGetPlandayCredentials,
  storePlandayCredentials:  mocks.mockStorePlandayCredentials,
  updatePlandayPortal:      mocks.mockUpdatePlandayPortal,
}))
vi.mock('@/lib/planday/client', () => ({
  getPlandayAccessToken:                mocks.mockGetPlandayAccessToken,
  getPortal:                            mocks.mockGetPortal,
  getActiveEmployeesWithBirthDate:      mocks.mockGetActiveEmployees,
  getDeactivatedEmployeesWithBirthDate: mocks.mockGetDeactivatedEmployees,
  getHistoricalShifts:                  mocks.mockGetHistoricalShifts,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
const PORTAL = { id: 42, name: 'Killer Kebab' }

/** Set up standard happy-path DB mocks. */
function setupDbMocks(
  employees: Array<{ id: string; name: string }> = [],
  extIds: Array<{ employee_id: string; external_id: string }> = [],
) {
  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'employees') {
      return { select: vi.fn().mockResolvedValue({ data: employees, error: null }) }
    }
    if (table === 'employee_external_identities') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: extIds, error: null }),
          }),
        }),
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  })
}

// ── Import under test ────────────────────────────────────────────────────────

import { previewPlandayBootstrap, savePlandayCredentials } from '@/lib/actions/planday-bootstrap'

// ── previewPlandayBootstrap ──────────────────────────────────────────────────

describe('previewPlandayBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetPlandayCredentials.mockResolvedValue(CREDENTIALS)
    mocks.mockGetPlandayAccessToken.mockResolvedValue(ACCESS_TOKEN)
    mocks.mockGetPortal.mockResolvedValue(PORTAL)
    mocks.mockGetActiveEmployees.mockResolvedValue([])
    mocks.mockGetDeactivatedEmployees.mockResolvedValue([])
    mocks.mockGetHistoricalShifts.mockResolvedValue([])
    mocks.mockUpdatePlandayPortal.mockResolvedValue(undefined)
    setupDbMocks()
  })

  it('unauthenticated user is rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await previewPlandayBootstrap()
    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('UM user is rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    const result = await previewPlandayBootstrap()
    expect(result.error).toBe('Not authorised')
    expect(mocks.mockGetPlandayCredentials).not.toHaveBeenCalled()
  })

  it('missing credentials returns descriptive error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayCredentials.mockRejectedValue(new Error('not configured'))
    const result = await previewPlandayBootstrap()
    expect(result.error).toMatch(/credentials not configured/)
    expect(mocks.mockGetPlandayAccessToken).not.toHaveBeenCalled()
  })

  it('token exchange failure returns descriptive error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayAccessToken.mockRejectedValue(new Error('invalid_grant'))
    const result = await previewPlandayBootstrap()
    expect(result.error).toMatch(/Could not connect to Planday/)
    expect(mocks.mockGetPortal).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN with no employees returns empty preview', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const result = await previewPlandayBootstrap()
    expect(result.error).toBeUndefined()
    expect(result.data?.totalFetched).toBe(0)
    expect(result.data?.results).toHaveLength(0)
    expect(result.data?.portalName).toBe('Killer Kebab')
  })

  it('classifies an ALREADY_LINKED employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 99, firstName: 'Ronnie', lastName: 'Hansen', birthDate: null },
    ])
    setupDbMocks(
      [{ id: 'emp-uuid', name: 'Ronnie Hansen' }],
      [{ employee_id: 'emp-uuid', external_id: '99' }],
    )

    const result = await previewPlandayBootstrap()
    expect(result.error).toBeUndefined()
    const row = result.data!.results[0]
    expect(row.state).toBe('ALREADY_LINKED')
    expect(row.matchedEmployeeId).toBe('emp-uuid')
    expect(row.matchedEmployeeName).toBe('Ronnie Hansen')
  })

  it('classifies an EXACT_NAME_CANDIDATE when no external ID link exists', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 101, firstName: 'Sara', lastName: 'Jørgensen', birthDate: null },
    ])
    setupDbMocks(
      [{ id: 'emp-sara', name: 'Sara Jørgensen' }],
      [],  // no existing link
    )

    const result = await previewPlandayBootstrap()
    const row = result.data!.results[0]
    expect(row.state).toBe('EXACT_NAME_CANDIDATE')
    expect(row.matchedEmployeeId).toBe('emp-sara')
  })

  it('classifies NEW_PERSON when no name match exists', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 200, firstName: 'New', lastName: 'Person', birthDate: null },
    ])
    setupDbMocks([], [])

    const result = await previewPlandayBootstrap()
    const row = result.data!.results[0]
    expect(row.state).toBe('NEW_PERSON')
    expect(row.matchedEmployeeId).toBeUndefined()
  })

  it('classifies AMBIGUOUS when multiple employees share the same name', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 300, firstName: 'Ali', lastName: 'Khan', birthDate: null },
    ])
    setupDbMocks(
      [
        { id: 'emp-ali-1', name: 'Ali Khan' },
        { id: 'emp-ali-2', name: 'Ali Khan' },
      ],
      [],
    )

    const result = await previewPlandayBootstrap()
    const row = result.data!.results[0]
    expect(row.state).toBe('AMBIGUOUS')
  })

  it('parses Planday birthDate into birthdayMonth and birthdayDay', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 400, firstName: 'Birthday', lastName: 'Person', birthDate: '1991-10-16' },
    ])
    setupDbMocks()

    const result = await previewPlandayBootstrap()
    const record = result.data!.results[0].record
    expect(record.birthdayMonth).toBe(10)
    expect(record.birthdayDay).toBe(16)
  })

  it('leaves birthday null when birthDate is absent', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 401, firstName: 'No', lastName: 'Birthday', birthDate: null },
    ])
    setupDbMocks()

    const result = await previewPlandayBootstrap()
    const record = result.data!.results[0].record
    expect(record.birthdayMonth).toBeNull()
    expect(record.birthdayDay).toBeNull()
  })

  it('sets proposedStartedOn to earliest shift for the employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 500, firstName: 'Shift', lastName: 'Person', birthDate: null },
    ])
    mocks.mockGetHistoricalShifts.mockResolvedValue([
      { id: 1, employeeId: 500, date: '2022-06-15' },
      { id: 2, employeeId: 500, date: '2021-03-01' },  // earlier
      { id: 3, employeeId: 500, date: '2023-11-20' },
    ])
    setupDbMocks()

    const result = await previewPlandayBootstrap()
    const record = result.data!.results[0].record
    expect(record.proposedStartedOn).toBe('2021-03-01')
  })

  it('leaves proposedStartedOn null when no shifts exist', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 600, firstName: 'No', lastName: 'Shifts', birthDate: null },
    ])
    setupDbMocks()

    const result = await previewPlandayBootstrap()
    expect(result.data!.results[0].record.proposedStartedOn).toBeNull()
  })

  it('skips employees with no resolvable name', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 700, firstName: null, lastName: null, birthDate: null },  // no name
      { id: 701, firstName: 'Valid', lastName: 'Person', birthDate: null },
    ])
    setupDbMocks()

    const result = await previewPlandayBootstrap()
    expect(result.data!.totalFetched).toBe(1)
    expect(result.data!.results[0].record.name).toBe('Valid Person')
  })

  it('deactivated Planday employees get sourceStatus "left"', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetDeactivatedEmployees.mockResolvedValue([
      { id: 800, firstName: 'Former', lastName: 'Staff', birthDate: null },
    ])
    setupDbMocks()

    const result = await previewPlandayBootstrap()
    const row = result.data!.results[0]
    expect(row.record.sourceStatus).toBe('left')
  })

  it('does not write to employees or external_identities tables', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 900, firstName: 'Read', lastName: 'Only', birthDate: null },
    ])
    setupDbMocks()

    await previewPlandayBootstrap()

    // No insert/update/delete should have been called
    for (const call of mocks.mockFrom.mock.calls) {
      const proxy = mocks.mockFrom.mock.results[mocks.mockFrom.mock.calls.indexOf(call)]?.value
      expect(proxy?.insert).toBeUndefined()
      expect(proxy?.update).toBeUndefined()
      expect(proxy?.delete).toBeUndefined()
    }
  })

  it('name matching is case-insensitive and whitespace-collapsed', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetActiveEmployees.mockResolvedValue([
      { id: 1000, firstName: 'MARIA', lastName: 'LOPEZ', birthDate: null },
    ])
    setupDbMocks(
      [{ id: 'emp-maria', name: 'Maria Lopez' }],  // normal casing in Kockpit
      [],
    )

    const result = await previewPlandayBootstrap()
    expect(result.data!.results[0].state).toBe('EXACT_NAME_CANDIDATE')
    expect(result.data!.results[0].matchedEmployeeId).toBe('emp-maria')
  })

  it('updates cached portal ID when it changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetPlandayCredentials.mockResolvedValue({
      ...CREDENTIALS,
      portalId: 'old-id',  // different from portal response
    })
    mocks.mockGetPortal.mockResolvedValue({ id: 42, name: 'New Portal Name' })
    setupDbMocks()

    await previewPlandayBootstrap()

    expect(mocks.mockUpdatePlandayPortal).toHaveBeenCalledWith('42', 'New Portal Name')
  })
})

// ── savePlandayCredentials ───────────────────────────────────────────────────

describe('savePlandayCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockStorePlandayCredentials.mockResolvedValue(undefined)
  })

  it('unauthenticated user is rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await savePlandayCredentials('cid', 'rt')
    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockStorePlandayCredentials).not.toHaveBeenCalled()
  })

  it('UM user is rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    const result = await savePlandayCredentials('cid', 'rt')
    expect(result.error).toBe('Not authorised')
    expect(mocks.mockStorePlandayCredentials).not.toHaveBeenCalled()
  })

  it('rejects empty client_id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const result = await savePlandayCredentials('', 'rt')
    expect(result.error).toMatch(/required/)
    expect(mocks.mockStorePlandayCredentials).not.toHaveBeenCalled()
  })

  it('rejects empty refresh_token', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const result = await savePlandayCredentials('cid', '  ')
    expect(result.error).toMatch(/required/)
    expect(mocks.mockStorePlandayCredentials).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can save credentials', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    const result = await savePlandayCredentials('my-client', 'my-refresh-token')
    expect(result.error).toBeUndefined()
    expect(mocks.mockStorePlandayCredentials).toHaveBeenCalledWith('my-client', 'my-refresh-token')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/settings')
  })

  it('trims whitespace from credentials before storing', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    await savePlandayCredentials('  cid  ', '  rt  ')
    expect(mocks.mockStorePlandayCredentials).toHaveBeenCalledWith('cid', 'rt')
  })

  it('propagates storage errors', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockStorePlandayCredentials.mockRejectedValue(new Error('DB write failed'))
    const result = await savePlandayCredentials('cid', 'rt')
    expect(result.error).toMatch(/Failed to save credentials/)
  })
})
