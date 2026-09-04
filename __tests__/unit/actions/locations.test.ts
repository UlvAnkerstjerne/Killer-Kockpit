/**
 * Tests for lib/actions/locations.ts server actions.
 *
 * Verifies:
 *   - canManageLocations gates both create and update
 *   - MEMBER cannot create or update locations
 *   - SUPER_ADMIN and UM can create and update locations
 *   - Duplicate name/short_name returns a clear error (Postgres 23505)
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
    if (table !== 'locations') throw new Error(`Unexpected table: ${table}`)
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

const NEW_LOCATION_ID = 'loc-new-uuid'

// ---- Tests -------------------------------------------------------------------

import { createLocation, updateLocation } from '@/lib/actions/locations'

describe('createLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SUPER_ADMIN can create a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: NEW_LOCATION_ID }, error: null })

    const result = await createLocation({ name: 'Killer Kebab Frederiksberg', short_name: 'Frederiksberg' })

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(NEW_LOCATION_ID)
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/locations')
  })

  it('UM can create a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: NEW_LOCATION_ID }, error: null })

    const result = await createLocation({ name: 'Killer Kebab Airport', short_name: 'Airport' })

    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(NEW_LOCATION_ID)
  })

  it('MEMBER cannot create a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)

    const result = await createLocation({ name: 'Killer Kebab Test', short_name: 'Test' })

    expect(result.error).toBe('Not authorised')
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('unauthenticated user cannot create a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createLocation({ name: 'Ghost Location', short_name: 'Ghost' })

    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('returns clear error on duplicate name or short_name', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: null, error: { code: '23505', message: 'unique violation' } })

    const result = await createLocation({ name: 'Killer Kebab Frederiksberg', short_name: 'Frederiksberg' })

    expect(result.error).toMatch(/already exists/)
    expect(result.data).toBeUndefined()
  })

  it('propagates generic DB error as action error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: null, error: { code: '42P01', message: 'DB error' } })

    const result = await createLocation({ name: 'Test', short_name: 'T' })

    expect(result.error).toMatch(/Failed to create location/)
  })
})

describe('updateLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SUPER_ADMIN can update a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: null })

    const result = await updateLocation('loc-uuid', { name: 'Updated Name', short_name: 'Updated' })

    expect(result.error).toBeUndefined()
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/locations')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/locations/loc-uuid')
  })

  it('UM can update a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: null })

    const result = await updateLocation('loc-uuid', { active: false })

    expect(result.error).toBeUndefined()
  })

  it('MEMBER cannot update a location', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)

    const result = await updateLocation('loc-uuid', { name: 'Attempted' })

    expect(result.error).toBe('Not authorised')
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('returns clear error on duplicate name/short_name conflict', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: { code: '23505', message: 'unique violation' } })

    const result = await updateLocation('loc-uuid', { name: 'Duplicate' })

    expect(result.error).toMatch(/already exists/)
  })

  it('propagates generic DB error as action error', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockUpdateEq.mockResolvedValue({ error: { code: '42P01', message: 'DB error' } })

    const result = await updateLocation('loc-uuid', { name: 'Fail' })

    expect(result.error).toMatch(/Failed to update location/)
  })
})
