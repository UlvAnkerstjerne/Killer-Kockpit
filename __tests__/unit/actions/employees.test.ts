/**
 * Tests for lib/actions/employees.ts server actions.
 *
 * Verifies:
 *   - canManagePeople gates both create and update
 *   - MEMBER cannot create or update employees
 *   - SUPER_ADMIN and UM can create and update employees
 *   - DB errors propagate as action errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockInsertSingle = vi.fn()
  const mockUpdateEq = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'employees') throw new Error(`Unexpected table: ${table}`)
    return {
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: mockInsertSingle }),
      }),
      update: vi.fn().mockReturnValue({
        eq: mockUpdateEq,
      }),
    }
  })

  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockInsertSingle,
    mockUpdateEq,
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

// ---- Fixtures ----------------------------------------------------------------

const SUPER_ADMIN_USER = {
  id: 'admin-uuid',
  role: 'SUPER_ADMIN' as const,
  display_name: 'Admin',
  email: 'admin@killerkebab.com',
  active: true,
}

const UM_USER = {
  id: 'um-uuid',
  role: 'UM' as const,
  display_name: 'Manager',
  email: 'manager@killerkebab.com',
  active: true,
}

const MEMBER_USER = {
  id: 'member-uuid',
  role: 'MEMBER' as const,
  display_name: 'Member',
  email: 'member@killerkebab.com',
  active: true,
}

const NEW_EMPLOYEE_ID = 'emp-new-uuid'

// ---- Tests -------------------------------------------------------------------

import { createEmployee, updateEmployee } from '@/lib/actions/employees'

describe('createEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SUPER_ADMIN can create an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: NEW_EMPLOYEE_ID }, error: null })

    const result = await createEmployee({ name: 'Ronnie Hansen', employment_status: 'active' })

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(NEW_EMPLOYEE_ID)
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/people')
  })

  it('UM can create an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: NEW_EMPLOYEE_ID }, error: null })

    const result = await createEmployee({ name: 'Sara Jørgensen', employment_status: 'active' })

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(NEW_EMPLOYEE_ID)
  })

  it('MEMBER cannot create an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)

    const result = await createEmployee({ name: 'Test Person', employment_status: 'active' })

    expect(result.error).toBe('Not authorised')
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('unauthenticated user cannot create an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createEmployee({ name: 'Ghost', employment_status: 'active' })

    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('propagates DB error as action error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: null, error: { message: 'DB error' } })

    const result = await createEmployee({ name: 'Fail Person', employment_status: 'active' })

    expect(result.error).toMatch(/Failed to create employee/)
    expect(result.data).toBeUndefined()
  })
})

describe('updateEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SUPER_ADMIN can update an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: null })

    const result = await updateEmployee('emp-uuid', { name: 'Updated Name' })

    expect(result.error).toBeUndefined()
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/people')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/people/emp-uuid')
  })

  it('UM can update an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: null })

    const result = await updateEmployee('emp-uuid', { employment_status: 'inactive' })

    expect(result.error).toBeUndefined()
  })

  it('MEMBER cannot update an employee', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)

    const result = await updateEmployee('emp-uuid', { name: 'Attempted Update' })

    expect(result.error).toBe('Not authorised')
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('propagates DB error as action error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: { message: 'DB error' } })

    const result = await updateEmployee('emp-uuid', { name: 'Fail' })

    expect(result.error).toMatch(/Failed to update employee/)
  })
})
