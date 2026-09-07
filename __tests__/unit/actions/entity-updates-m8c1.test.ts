/**
 * entity-updates-m8c1.test.ts
 *
 * M8C1-specific coverage: Universal Updates on Employee and Location surfaces.
 *
 * The underlying data layer (createUpdate / getUpdatesForEntity) is already
 * thoroughly tested in updates.test.ts.  This file documents the specific
 * contracts introduced by M8C1:
 *
 *   GENERAL SURFACE
 *     • getUpdatesForEntity accepts 'employee' as entity type
 *     • getUpdatesForEntity accepts 'location' as entity type
 *     • project surface unchanged (regression)
 *
 *   MANUAL CREATE — entity link correctness
 *     • Employee manual add: entity_links contains only the employee link
 *     • Location manual add: entity_links contains only the location link
 *     • Project manual add: entity_links contains only the project link (regression)
 *     • No author id supplied by the caller
 *     • No supersedes_update_id supplied by the caller
 *
 *   MULTI-ENTITY RENDERING
 *     • An Update linked to employee + location appears once in the employee query
 *     • The same Update appears once in the location query
 *     • entity_links for that Update contain both entities in each query result
 *     • No second Update is created for the second entity context
 *
 *   SECURITY
 *     • MEMBER cannot read Employee updates (role gate)
 *     • MEMBER cannot read Location updates (role gate)
 *     • No createServiceClient call introduced by employee/location queries
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser          = vi.fn()
  const mockCanAccessManagementView = vi.fn()
  const mockRpc                     = vi.fn()
  const mockFrom                    = vi.fn()
  const mockUserClient              = { rpc: mockRpc, from: mockFrom }

  return { mockGetCurrentUser, mockCanAccessManagementView, mockRpc, mockFrom, mockUserClient }
})

vi.mock('@/lib/auth', () => ({
  getCurrentUser: mocks.mockGetCurrentUser,
}))

vi.mock('@/lib/permissions', () => ({
  canAccessManagementView: mocks.mockCanAccessManagementView,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockUserClient),
  createServiceClient: vi.fn(() => {
    throw new Error('createServiceClient must NOT be called by M8C1 employee/location updates')
  }),
}))

// ─── Import after mocks ────────────────────────────────────────────────────────

import { createUpdate, getUpdatesForEntity } from '@/lib/actions/updates'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MANAGER     = { id: 'mgr-uuid',  role: 'UM' as const,         display_name: 'Manager' }
const MEMBER      = { id: 'mbr-uuid',  role: 'MEMBER' as const,     display_name: 'Member'  }
const SUPER_ADMIN = { id: 'sa-uuid',   role: 'SUPER_ADMIN' as const, display_name: 'Admin'  }

const EMP_ID  = '11111111-1111-1111-1111-111111111111'
const LOC_ID  = '22222222-2222-2222-2222-222222222222'
const PROJ_ID = '33333333-3333-3333-3333-333333333333'

const UPD_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const BASE_UPDATE = {
  id:                   UPD_ID,
  body:                 'Ahmed promoted to Head Chef.',
  occurred_on:          '2026-09-05',
  created_at:           '2026-09-05T10:00:00Z',
  created_by_user_id:   MANAGER.id,
  supersedes_update_id: null,
}

function makeChain(result: { data: unknown; error: null | { message: string } }) {
  const self: Record<string, unknown> = {}
  const resolve = () => Promise.resolve(result)
  self.select = vi.fn().mockReturnValue(self)
  self.eq     = vi.fn().mockReturnValue(self)
  self.in     = vi.fn().mockReturnValue(self)
  self.limit  = vi.fn().mockImplementation(resolve)
  self.then   = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    resolve().then(onFulfilled, onRejected)
  return self
}

function setupHappyGet(rpcRows = [BASE_UPDATE], linkRows: object[] = [], authorRows = [{ id: MANAGER.id, display_name: MANAGER.display_name }]) {
  mocks.mockRpc.mockResolvedValueOnce({ data: rpcRows, error: null })
  mocks.mockFrom
    .mockReturnValueOnce(makeChain({ data: linkRows,   error: null }))
    .mockReturnValueOnce(makeChain({ data: authorRows, error: null }))
}

// ─── GENERAL SURFACE ──────────────────────────────────────────────────────────

describe('getUpdatesForEntity — M8C1 surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
  })

  it('accepts employee as entity type', async () => {
    setupHappyGet()
    const result = await getUpdatesForEntity('employee', EMP_ID)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith('get_current_updates_for_entity',
      expect.objectContaining({ p_entity_type: 'employee', p_entity_id: EMP_ID })
    )
  })

  it('accepts location as entity type', async () => {
    setupHappyGet()
    const result = await getUpdatesForEntity('location', LOC_ID)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith('get_current_updates_for_entity',
      expect.objectContaining({ p_entity_type: 'location', p_entity_id: LOC_ID })
    )
  })

  it('project surface unchanged (regression)', async () => {
    setupHappyGet()
    const result = await getUpdatesForEntity('project', PROJ_ID)
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith('get_current_updates_for_entity',
      expect.objectContaining({ p_entity_type: 'project', p_entity_id: PROJ_ID })
    )
  })

  it('returns empty array for employee with no updates', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await getUpdatesForEntity('employee', EMP_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
  })

  it('returns empty array for location with no updates', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await getUpdatesForEntity('location', LOC_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
  })

  it('returns one update for employee with one update', async () => {
    setupHappyGet(
      [BASE_UPDATE],
      [{ update_id: UPD_ID, entity_type: 'employee', entity_id: EMP_ID }],
    )
    const result = await getUpdatesForEntity('employee', EMP_ID)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].body).toBe('Ahmed promoted to Head Chef.')
  })

  it('returns multiple updates for location with multiple updates', async () => {
    const upd2 = { ...BASE_UPDATE, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', body: 'Kitchen passed inspection.' }
    setupHappyGet(
      [BASE_UPDATE, upd2],
      [
        { update_id: UPD_ID,    entity_type: 'location', entity_id: LOC_ID },
        { update_id: upd2.id,   entity_type: 'location', entity_id: LOC_ID },
      ],
    )
    const result = await getUpdatesForEntity('location', LOC_ID)
    expect(result.data).toHaveLength(2)
  })

  it('author and date preserved in employee update result', async () => {
    setupHappyGet(
      [BASE_UPDATE],
      [{ update_id: UPD_ID, entity_type: 'employee', entity_id: EMP_ID }],
    )
    const result = await getUpdatesForEntity('employee', EMP_ID)
    const row = result.data![0]
    expect(row.occurred_on).toBe('2026-09-05')
    expect(row.author?.display_name).toBe(MANAGER.display_name)
  })
})

// ─── MANUAL CREATE — entity link correctness ──────────────────────────────────

describe('createUpdate — M8C1 entity link contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    mocks.mockRpc.mockResolvedValue({ data: 'new-uuid', error: null })
  })

  it('Employee manual add: entity_links contains only the employee link', async () => {
    await createUpdate({
      body:         'Took on a new responsibility.',
      occurred_on:  null,
      entity_links: [{ entity_type: 'employee', entity_id: EMP_ID }],
    })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toHaveLength(1)
    expect(args.p_entity_links[0]).toEqual({ entity_type: 'employee', entity_id: EMP_ID })
  })

  it('Location manual add: entity_links contains only the location link', async () => {
    await createUpdate({
      body:         'Store passed cleanliness inspection.',
      occurred_on:  '2026-09-05',
      entity_links: [{ entity_type: 'location', entity_id: LOC_ID }],
    })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toHaveLength(1)
    expect(args.p_entity_links[0]).toEqual({ entity_type: 'location', entity_id: LOC_ID })
  })

  it('Project manual add: entity_links contains only the project link (regression)', async () => {
    await createUpdate({
      body:         'SOP approved.',
      occurred_on:  null,
      entity_links: [{ entity_type: 'project', entity_id: PROJ_ID }],
    })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toHaveLength(1)
    expect(args.p_entity_links[0]).toEqual({ entity_type: 'project', entity_id: PROJ_ID })
  })

  it('no author id supplied to createUpdate from employee context', async () => {
    await createUpdate({
      body:         'New responsibility.',
      entity_links: [{ entity_type: 'employee', entity_id: EMP_ID }],
    })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_created_by_user_id')
    expect(args).not.toHaveProperty('author_id')
    expect(args).not.toHaveProperty('user_id')
  })

  it('no supersedes_update_id in employee manual create', async () => {
    await createUpdate({
      body:         'New responsibility.',
      entity_links: [{ entity_type: 'employee', entity_id: EMP_ID }],
    })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_supersedes_update_id')
    expect(args).not.toHaveProperty('supersedes_update_id')
  })
})

// ─── MULTI-ENTITY RENDERING ───────────────────────────────────────────────────

describe('multi-entity Update — M8C1 rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
  })

  const MULTI_LINK_ROWS = [
    { update_id: UPD_ID, entity_type: 'employee', entity_id: EMP_ID },
    { update_id: UPD_ID, entity_type: 'location', entity_id: LOC_ID },
  ]

  it('an Update linked to employee+location appears exactly once in employee query', async () => {
    setupHappyGet([BASE_UPDATE], MULTI_LINK_ROWS)
    const result = await getUpdatesForEntity('employee', EMP_ID)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].id).toBe(UPD_ID)
  })

  it('the same Update appears exactly once in location query', async () => {
    setupHappyGet([BASE_UPDATE], MULTI_LINK_ROWS)
    const result = await getUpdatesForEntity('location', LOC_ID)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].id).toBe(UPD_ID)
  })

  it('entity_links on the employee-context result includes both entity links', async () => {
    setupHappyGet([BASE_UPDATE], MULTI_LINK_ROWS)
    const result = await getUpdatesForEntity('employee', EMP_ID)
    expect(result.data![0].entity_links).toHaveLength(2)
    expect(result.data![0].entity_links).toContainEqual({ entity_type: 'employee', entity_id: EMP_ID })
    expect(result.data![0].entity_links).toContainEqual({ entity_type: 'location', entity_id: LOC_ID })
  })

  it('entity_links on the location-context result includes both entity links', async () => {
    setupHappyGet([BASE_UPDATE], MULTI_LINK_ROWS)
    const result = await getUpdatesForEntity('location', LOC_ID)
    expect(result.data![0].entity_links).toHaveLength(2)
    expect(result.data![0].entity_links).toContainEqual({ entity_type: 'employee', entity_id: EMP_ID })
    expect(result.data![0].entity_links).toContainEqual({ entity_type: 'location', entity_id: LOC_ID })
  })

  it('no duplicate Update creation: one createUpdate call produces one RPC call', async () => {
    mocks.mockRpc.mockResolvedValue({ data: 'new-uuid', error: null })
    await createUpdate({
      body:         'Store manager briefed.',
      entity_links: [
        { entity_type: 'employee', entity_id: EMP_ID },
        { entity_type: 'location', entity_id: LOC_ID },
      ],
    })
    // Exactly one RPC call regardless of entity count
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toHaveLength(2)
  })
})

// ─── SECURITY ─────────────────────────────────────────────────────────────────

describe('M8C1 — security', () => {
  beforeEach(() => vi.clearAllMocks())

  it('MEMBER cannot read Employee updates (role gate)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await getUpdatesForEntity('employee', EMP_ID)
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('MEMBER cannot read Location updates (role gate)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await getUpdatesForEntity('location', LOC_ID)
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('no service client used for employee query', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyGet()
    await expect(getUpdatesForEntity('employee', EMP_ID)).resolves.not.toThrow()
    // createServiceClient mock throws if called — reaching here means it was not called
  })

  it('no service client used for location query', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyGet()
    await expect(getUpdatesForEntity('location', LOC_ID)).resolves.not.toThrow()
  })
})
