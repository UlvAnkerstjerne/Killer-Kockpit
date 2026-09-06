/**
 * Tests for lib/actions/updates.ts — createUpdate server action (M8A3b hardened)
 *
 * Architecture under test:
 *   Application layer (server action):  getCurrentUser() + canAccessManagementView()
 *   Database layer (RPC):               get_my_app_user_id() + get_my_role()
 *   RPC called via createClient() (JWT session) — NOT createServiceClient().
 *   RPC accepts NO author id — identity derived inside the function.
 *
 * Coverage:
 *
 *   AUTH
 *     • unauthenticated caller rejected at action layer
 *     • MEMBER rejected at action layer
 *     • UM allowed
 *     • SUPER_ADMIN allowed
 *
 *   AUTHOR ISOLATION / SECURITY
 *     • RPC args contain no author / user id field whatsoever
 *     • RPC is called via the authenticated client (createClient), never service client
 *     • SUPER_ADMIN cannot inject another user's id as author
 *     • Two sessions each invoke the RPC without any user id in args
 *
 *   VALIDATION (application-layer, before the RPC is called)
 *     • blank body rejected
 *     • whitespace-only body rejected
 *     • body is trimmed before passing to RPC
 *     • valid occurred_on (YYYY-MM-DD) accepted
 *     • null occurred_on accepted
 *     • undefined occurred_on treated as null
 *     • timestamp format rejected
 *     • free-text date rejected
 *     • zero entity links rejected
 *     • unsupported entity type rejected
 *
 *   RPC DELEGATION
 *     • project link forwarded correctly
 *     • employee link forwarded correctly
 *     • location link forwarded correctly
 *     • multiple mixed links all forwarded
 *     • RPC "not found" error → safe user message
 *     • one bad link among several → RPC error → total failure
 *     • generic RPC error propagated safely without exposing internals
 *     • RPC success → update id returned
 *     • RPC auth error → generic failure (not exposed verbatim)
 *
 *   IMMUTABILITY
 *     • RPC args contain no supersedes_update_id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser          = vi.fn()
  const mockCanAccessManagementView = vi.fn()
  const mockRpc                     = vi.fn()
  const mockFrom                    = vi.fn()

  // Authenticated user-session client (createClient — async)
  const mockUserClient = { rpc: mockRpc, from: mockFrom }

  return {
    mockGetCurrentUser,
    mockCanAccessManagementView,
    mockRpc,
    mockFrom,
    mockUserClient,
  }
})

vi.mock('@/lib/auth', () => ({
  getCurrentUser: mocks.mockGetCurrentUser,
}))

vi.mock('@/lib/permissions', () => ({
  canAccessManagementView: mocks.mockCanAccessManagementView,
}))

// createClient is async (returns Promise<SupabaseClient>)
// createServiceClient is NOT imported by updates.ts after M8A3b
vi.mock('@/lib/supabase/server', () => ({
  createClient:       vi.fn().mockResolvedValue(mocks.mockUserClient),
  createServiceClient: vi.fn(() => {
    throw new Error('createServiceClient must NOT be called by createUpdate')
  }),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  id:           'admin-uuid',
  role:         'SUPER_ADMIN' as const,
  display_name: 'Admin',
  email:        'admin@killerkebab.com',
  active:       true,
}

const UM_USER = {
  id:           'um-uuid',
  role:         'UM' as const,
  display_name: 'Manager',
  email:        'manager@killerkebab.com',
  active:       true,
}

const MEMBER = {
  id:           'member-uuid',
  role:         'MEMBER' as const,
  display_name: 'Member',
  email:        'member@killerkebab.com',
  active:       true,
}

const OTHER_USER_ID = 'other-uuid'

const PROJECT_LINK  = { entity_type: 'project'  as const, entity_id: 'proj-uuid' }
const EMPLOYEE_LINK = { entity_type: 'employee' as const, entity_id: 'emp-uuid'  }
const LOCATION_LINK = { entity_type: 'location' as const, entity_id: 'loc-uuid'  }

const VALID_INPUT = {
  body:         'Ronnie was promoted to store manager.',
  occurred_on:  '2026-09-01',
  entity_links: [PROJECT_LINK],
}

// ─── Import after mocks ───────────────────────────────────────────────────────

import { createUpdate, getUpdatesForEntity } from '@/lib/actions/updates'

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    mocks.mockRpc.mockResolvedValue({ data: 'new-update-uuid', error: null })
  })

  // ── AUTH ─────────────────────────────────────────────────────────────────────

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects MEMBER role at action layer', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('allows UM role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-update-uuid')
  })

  it('allows SUPER_ADMIN role', async () => {
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-update-uuid')
  })

  // ── AUTHOR ISOLATION / SECURITY ──────────────────────────────────────────────

  it('RPC args contain no author or user id field', async () => {
    await createUpdate(VALID_INPUT)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_created_by_user_id')
    expect(args).not.toHaveProperty('p_actor_user_id')
    expect(args).not.toHaveProperty('user_id')
    expect(args).not.toHaveProperty('author_id')
    expect(args).not.toHaveProperty('author')
  })

  it('RPC args have exactly the three expected keys', async () => {
    await createUpdate(VALID_INPUT)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(Object.keys(args).sort()).toEqual(['p_body', 'p_entity_links', 'p_occurred_on'])
  })

  it('createServiceClient is never called — RPC uses authenticated session client', async () => {
    // The mock for createServiceClient throws if called — this test would fail
    // if updates.ts ever called createServiceClient().
    await expect(createUpdate(VALID_INPUT)).resolves.not.toThrow()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('SUPER_ADMIN cannot inject another user id as author', async () => {
    // Even if input were extended with author fields, none reach the RPC
    const maliciousInput = {
      ...VALID_INPUT,
      // These fields are not part of CreateUpdateInput; TypeScript would
      // reject them at compile time, but verify the runtime path also
      // never forwards them.
    } as typeof VALID_INPUT & { p_created_by_user_id?: string }
    maliciousInput.p_created_by_user_id = OTHER_USER_ID
    await createUpdate(maliciousInput as typeof VALID_INPUT)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_created_by_user_id')
  })

  it('two sessions both call the RPC with no user id in args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValueOnce(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValueOnce({ data: 'id-1', error: null })
    await createUpdate(VALID_INPUT)

    mocks.mockGetCurrentUser.mockResolvedValueOnce(UM_USER)
    mocks.mockRpc.mockResolvedValueOnce({ data: 'id-2', error: null })
    await createUpdate(VALID_INPUT)

    for (const [, args] of mocks.mockRpc.mock.calls) {
      expect(args).not.toHaveProperty('p_created_by_user_id')
    }
  })

  it('RPC auth error (unauthenticated session) propagated as generic failure', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Not authenticated' },
    })
    const result = await createUpdate(VALID_INPUT)
    // Generic message — internal RPC error text must not be forwarded verbatim
    expect(result.error).toMatch(/please try again/i)
    expect(result.data).toBeUndefined()
  })

  it('RPC role error (MEMBER session at DB level) propagated as generic failure', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Not authorised: role MEMBER cannot create Updates' },
    })
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toMatch(/please try again/i)
    expect(result.data).toBeUndefined()
  })

  // ── VALIDATION ───────────────────────────────────────────────────────────────

  it('rejects blank body', async () => {
    const result = await createUpdate({ ...VALID_INPUT, body: '' })
    expect(result.error).toMatch(/blank/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects whitespace-only body', async () => {
    const result = await createUpdate({ ...VALID_INPUT, body: '   \t  ' })
    expect(result.error).toMatch(/blank/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('body is trimmed before passing to RPC', async () => {
    await createUpdate({ ...VALID_INPUT, body: '  Supplier confirmed.  ' })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_body).toBe('Supplier confirmed.')
  })

  it('accepts valid occurred_on (YYYY-MM-DD)', async () => {
    const result = await createUpdate({ ...VALID_INPUT, occurred_on: '2026-09-01' })
    expect(result.error).toBeUndefined()
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_occurred_on).toBe('2026-09-01')
  })

  it('accepts null occurred_on', async () => {
    const result = await createUpdate({ ...VALID_INPUT, occurred_on: null })
    expect(result.error).toBeUndefined()
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_occurred_on).toBeNull()
  })

  it('accepts undefined occurred_on (treated as null)', async () => {
    const { occurred_on: _omit, ...inputWithout } = VALID_INPUT
    const result = await createUpdate({ ...inputWithout, entity_links: [PROJECT_LINK] })
    expect(result.error).toBeUndefined()
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_occurred_on).toBeNull()
  })

  it('rejects timestamp format for occurred_on', async () => {
    const result = await createUpdate({ ...VALID_INPUT, occurred_on: '2026-09-01T00:00:00Z' })
    expect(result.error).toMatch(/YYYY-MM-DD/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects free-text date for occurred_on', async () => {
    const result = await createUpdate({ ...VALID_INPUT, occurred_on: 'Monday' })
    expect(result.error).toMatch(/YYYY-MM-DD/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects zero entity links', async () => {
    const result = await createUpdate({ ...VALID_INPUT, entity_links: [] })
    expect(result.error).toMatch(/at least one/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects unsupported entity type', async () => {
    const result = await createUpdate({
      ...VALID_INPUT,
      entity_links: [{ entity_type: 'meeting' as never, entity_id: 'mtg-uuid' }],
    })
    expect(result.error).toMatch(/unsupported entity type/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // ── RPC DELEGATION ───────────────────────────────────────────────────────────

  it('forwards project link to RPC', async () => {
    await createUpdate({ ...VALID_INPUT, entity_links: [PROJECT_LINK] })
    const [name, args] = mocks.mockRpc.mock.calls[0]
    expect(name).toBe('create_update_and_links')
    expect(args.p_entity_links).toContainEqual(PROJECT_LINK)
  })

  it('forwards employee link to RPC', async () => {
    await createUpdate({ ...VALID_INPUT, entity_links: [EMPLOYEE_LINK] })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toContainEqual(EMPLOYEE_LINK)
  })

  it('forwards location link to RPC', async () => {
    await createUpdate({ ...VALID_INPUT, entity_links: [LOCATION_LINK] })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toContainEqual(LOCATION_LINK)
  })

  it('forwards multiple mixed links to RPC', async () => {
    const links = [PROJECT_LINK, EMPLOYEE_LINK, LOCATION_LINK]
    await createUpdate({ ...VALID_INPUT, entity_links: links })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_entity_links).toHaveLength(3)
    expect(args.p_entity_links).toContainEqual(PROJECT_LINK)
    expect(args.p_entity_links).toContainEqual(EMPLOYEE_LINK)
    expect(args.p_entity_links).toContainEqual(LOCATION_LINK)
  })

  it('RPC "not found" error → safe user message', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'project not found: 00000000-0000-0000-0000-000000000000' },
    })
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toMatch(/not found/i)
    expect(result.data).toBeUndefined()
  })

  it('one bad link among several → RPC error → total failure', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'project not found: bad-id' },
    })
    const result = await createUpdate({
      ...VALID_INPUT,
      entity_links: [PROJECT_LINK, EMPLOYEE_LINK, LOCATION_LINK],
    })
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('generic RPC error — internal message not exposed verbatim', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'internal server error XYZ' },
    })
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toMatch(/please try again/i)
    expect(result.error).not.toContain('internal server error XYZ')
    expect(result.data).toBeUndefined()
  })

  it('returns created update id on success', async () => {
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ id: 'new-update-uuid' })
  })

  // ── IMMUTABILITY ─────────────────────────────────────────────────────────────

  it('RPC args contain no supersedes_update_id', async () => {
    await createUpdate(VALID_INPUT)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('supersedes_update_id')
    expect(args).not.toHaveProperty('p_supersedes_update_id')
  })
})

// ─── getUpdatesForEntity ──────────────────────────────────────────────────────

/**
 * Helper that returns a chainable Supabase query builder mock.
 * Every method returns `this` so chains compose freely.
 * The object is also thenable, resolving with `result` when awaited directly.
 * `.limit()` likewise resolves with `result`.
 */
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

const VALID_ENTITY_ID = '11111111-1111-1111-1111-111111111111'
const UPDATE_ID_1     = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const UPDATE_ID_2     = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const BASE_UPDATE: {
  id: string
  body: string
  occurred_on: string | null
  created_at: string
  created_by_user_id: string
  supersedes_update_id: string | null
} = {
  id:                   UPDATE_ID_1,
  body:                 'Supplier contract signed.',
  occurred_on:          '2026-08-01',
  created_at:           '2026-08-01T10:00:00Z',
  created_by_user_id:   SUPER_ADMIN.id,
  supersedes_update_id: null,
}

/**
 * Set up the three queries for a happy-path getUpdatesForEntity:
 *   mockRpc  → get_current_updates_for_entity (returns top-N rows from DB)
 *   mockFrom → kk_update_entities all-links query  (parallel)
 *   mockFrom → app_users author query               (parallel)
 */
function setupHappyPath({
  rpcRows    = [BASE_UPDATE],
  allLinkRows = [{ update_id: UPDATE_ID_1, entity_type: 'project', entity_id: 'proj-uuid' }],
  authorRows  = [{ id: SUPER_ADMIN.id, display_name: SUPER_ADMIN.display_name }],
} = {}) {
  mocks.mockRpc.mockResolvedValueOnce({ data: rpcRows, error: null })
  mocks.mockFrom
    .mockReturnValueOnce(makeChain({ data: allLinkRows, error: null }))  // kk_update_entities
    .mockReturnValueOnce(makeChain({ data: authorRows,  error: null }))  // app_users
}

describe('getUpdatesForEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
  })

  // ── AUTH ─────────────────────────────────────────────────────────────────

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects MEMBER role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('allows UM role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyPath()
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(1)
  })

  it('allows SUPER_ADMIN role', async () => {
    setupHappyPath()
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
  })

  // ── VALIDATION ───────────────────────────────────────────────────────────

  it('rejects unsupported entity type at application layer', async () => {
    const result = await getUpdatesForEntity('meeting' as never, VALID_ENTITY_ID)
    expect(result.error).toMatch(/unsupported entity type/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects non-UUID entity id at application layer', async () => {
    const result = await getUpdatesForEntity('project', 'not-a-uuid')
    expect(result.error).toMatch(/invalid entity id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('accepts all three valid entity types', async () => {
    for (const entityType of ['project', 'employee', 'location'] as const) {
      vi.clearAllMocks()
      mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
      mocks.mockCanAccessManagementView.mockReturnValue(true)
      setupHappyPath()
      const result = await getUpdatesForEntity(entityType, VALID_ENTITY_ID)
      expect(result.error).toBeUndefined()
    }
  })

  // ── EMPTY RESULTS ────────────────────────────────────────────────────────

  it('returns empty array when RPC returns no rows', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('returns empty array when all linked updates are superseded (RPC returns [])', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([])
  })

  // ── CURRENTNESS ──────────────────────────────────────────────────────────

  it('excludes superseded updates — RPC returns only the successor', async () => {
    setupHappyPath({
      rpcRows:    [{ ...BASE_UPDATE, id: UPDATE_ID_2 }],
      allLinkRows: [{ update_id: UPDATE_ID_2, entity_type: 'project', entity_id: 'proj-uuid' }],
    })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(1)
    expect(result.data![0].id).toBe(UPDATE_ID_2)
  })

  it('includes update with no successor (not superseded)', async () => {
    setupHappyPath()
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].id).toBe(UPDATE_ID_1)
  })

  // ── SHAPE ────────────────────────────────────────────────────────────────

  it('returns correctly shaped UpdateRow', async () => {
    setupHappyPath()
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    const row = result.data![0]
    expect(row).toMatchObject({
      id:          UPDATE_ID_1,
      body:        'Supplier contract signed.',
      occurred_on: '2026-08-01',
      created_at:  '2026-08-01T10:00:00Z',
      author: {
        id:           SUPER_ADMIN.id,
        display_name: SUPER_ADMIN.display_name,
      },
      entity_links: [{ entity_type: 'project', entity_id: 'proj-uuid' }],
    })
  })

  it('author is null when author row not found', async () => {
    setupHappyPath({ authorRows: [] })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data![0].author).toBeNull()
  })

  it('entity_links array is populated for each update', async () => {
    setupHappyPath({
      allLinkRows: [
        { update_id: UPDATE_ID_1, entity_type: 'project',  entity_id: 'proj-uuid' },
        { update_id: UPDATE_ID_1, entity_type: 'employee', entity_id: 'emp-uuid'  },
      ],
    })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data![0].entity_links).toHaveLength(2)
  })

  // ── ORDERING — application preserves DB-returned order ───────────────────

  it('preserves RPC order: newer occurred_on first', async () => {
    const older = { ...BASE_UPDATE, id: UPDATE_ID_1, occurred_on: '2026-07-01', created_at: '2026-07-01T10:00:00Z' }
    const newer = { ...BASE_UPDATE, id: UPDATE_ID_2, occurred_on: '2026-08-01', created_at: '2026-08-01T10:00:00Z' }
    setupHappyPath({
      rpcRows:    [newer, older],
      allLinkRows: [
        { update_id: UPDATE_ID_1, entity_type: 'project', entity_id: 'proj-uuid' },
        { update_id: UPDATE_ID_2, entity_type: 'project', entity_id: 'proj-uuid' },
      ],
    })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data![0].id).toBe(UPDATE_ID_2)
    expect(result.data![1].id).toBe(UPDATE_ID_1)
  })

  it('preserves RPC order: null occurred_on falls back to created_at date', async () => {
    const noDate   = { ...BASE_UPDATE, id: UPDATE_ID_1, occurred_on: null,         created_at: '2026-07-15T00:00:00Z' }
    const withDate = { ...BASE_UPDATE, id: UPDATE_ID_2, occurred_on: '2026-07-01', created_at: '2026-07-01T00:00:00Z' }
    setupHappyPath({
      rpcRows:    [noDate, withDate],
      allLinkRows: [
        { update_id: UPDATE_ID_1, entity_type: 'project', entity_id: 'proj-uuid' },
        { update_id: UPDATE_ID_2, entity_type: 'project', entity_id: 'proj-uuid' },
      ],
    })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data![0].id).toBe(UPDATE_ID_1)
  })

  it('preserves RPC order: created_at DESC tie-break', async () => {
    const earlier = { ...BASE_UPDATE, id: UPDATE_ID_1, occurred_on: '2026-08-01', created_at: '2026-08-01T08:00:00Z' }
    const later   = { ...BASE_UPDATE, id: UPDATE_ID_2, occurred_on: '2026-08-01', created_at: '2026-08-01T18:00:00Z' }
    setupHappyPath({
      rpcRows:    [later, earlier],
      allLinkRows: [
        { update_id: UPDATE_ID_1, entity_type: 'project', entity_id: 'proj-uuid' },
        { update_id: UPDATE_ID_2, entity_type: 'project', entity_id: 'proj-uuid' },
      ],
    })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data![0].id).toBe(UPDATE_ID_2)
    expect(result.data![1].id).toBe(UPDATE_ID_1)
  })

  // ── SECURITY ─────────────────────────────────────────────────────────────

  it('uses createClient (authenticated session), not createServiceClient', async () => {
    setupHappyPath()
    await expect(getUpdatesForEntity('project', VALID_ENTITY_ID)).resolves.not.toThrow()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'get_current_updates_for_entity',
      expect.objectContaining({ p_entity_type: 'project', p_entity_id: VALID_ENTITY_ID, p_limit: 50 }),
    )
  })

  it('RPC is called with exactly the expected args', async () => {
    setupHappyPath()
    await getUpdatesForEntity('employee', VALID_ENTITY_ID)
    expect(mocks.mockRpc).toHaveBeenCalledWith('get_current_updates_for_entity', {
      p_entity_type: 'employee',
      p_entity_id:   VALID_ENTITY_ID,
      p_limit:       50,
    })
  })

  // ── ERROR HANDLING ────────────────────────────────────────────────────────

  it('returns safe error when RPC fails', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'db error' } })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toMatch(/please try again/i)
    expect(result.data).toBeUndefined()
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('returns safe error when all-links query fails', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: [BASE_UPDATE], error: null })
    mocks.mockFrom
      .mockReturnValueOnce(makeChain({ data: null, error: { message: 'db error' } }))
      .mockReturnValueOnce(makeChain({ data: [],   error: null }))
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toMatch(/please try again/i)
  })

  it('author query failure is non-fatal — author is null in results', async () => {
    mocks.mockRpc.mockResolvedValueOnce({ data: [BASE_UPDATE], error: null })
    mocks.mockFrom
      .mockReturnValueOnce(makeChain({ data: [{ update_id: UPDATE_ID_1, entity_type: 'project', entity_id: 'proj-uuid' }], error: null }))
      .mockReturnValueOnce(makeChain({ data: null, error: { message: 'author lookup failed' } }))
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data![0].author).toBeNull()
  })

  // ── MULTI-ENTITY ─────────────────────────────────────────────────────────

  it('multi-entity Update appears exactly once in results', async () => {
    setupHappyPath({
      allLinkRows: [
        { update_id: UPDATE_ID_1, entity_type: 'project',  entity_id: 'proj-uuid' },
        { update_id: UPDATE_ID_1, entity_type: 'employee', entity_id: 'emp-uuid'  },
      ],
    })
    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.data).toHaveLength(1)
    expect(result.data![0].id).toBe(UPDATE_ID_1)
    expect(result.data![0].entity_links).toHaveLength(2)
  })

  // ── >50 REGRESSION ───────────────────────────────────────────────────────

  it('>50 current Updates: exactly 50 returned (DB selects correct latest 50)', async () => {
    const TOTAL = 55
    const LIMIT = 50

    const allUpdates = Array.from({ length: TOTAL }, (_, i) => {
      const effDate = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
      const hasOccurredOn = i % 3 !== 0
      return {
        id:                   `upd${String(i).padStart(3, '0')}`,
        body:                 `Body ${i}`,
        occurred_on:          hasOccurredOn ? effDate : null,
        created_at:           hasOccurredOn
          ? `${effDate}T${String(i % 24).padStart(2, '0')}:00:00Z`
          : `${effDate}T12:00:00Z`,
        created_by_user_id:   SUPER_ADMIN.id,
        supersedes_update_id: null,
      }
    })

    // DB returns top 50 (indices 5–54), newest-first
    const top50 = allUpdates.slice(5).reverse()

    mocks.mockRpc.mockResolvedValueOnce({ data: top50, error: null })
    mocks.mockFrom
      .mockReturnValueOnce(makeChain({ data: [], error: null }))
      .mockReturnValueOnce(makeChain({ data: [{ id: SUPER_ADMIN.id, display_name: SUPER_ADMIN.display_name }], error: null }))

    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(LIMIT)

    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockRpc).toHaveBeenCalledWith('get_current_updates_for_entity', {
      p_entity_type: 'project',
      p_entity_id:   VALID_ENTITY_ID,
      p_limit:       50,
    })

    const returnedIdSet = new Set(result.data!.map(r => r.id))
    for (let i = 0; i < 5; i++) {
      expect(returnedIdSet.has(`upd${String(i).padStart(3, '0')}`)).toBe(false)
    }
    for (let i = 5; i < TOTAL; i++) {
      expect(returnedIdSet.has(`upd${String(i).padStart(3, '0')}`)).toBe(true)
    }

    expect(result.data![0].id).toBe('upd054')
    expect(result.data![LIMIT - 1].id).toBe('upd005')
  })

  it('large set (500 current Updates): application processes only 50 rows from RPC', async () => {
    const LIMIT = 50
    const top50 = Array.from({ length: LIMIT }, (_, i) => ({
      ...BASE_UPDATE,
      id:          `big${String(i).padStart(3, '0')}`,
      occurred_on: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
      created_at:  new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
    }))

    mocks.mockRpc.mockResolvedValueOnce({ data: top50, error: null })
    mocks.mockFrom
      .mockReturnValueOnce(makeChain({ data: [], error: null }))
      .mockReturnValueOnce(makeChain({ data: [{ id: SUPER_ADMIN.id, display_name: SUPER_ADMIN.display_name }], error: null }))

    const result = await getUpdatesForEntity('project', VALID_ENTITY_ID)
    expect(result.error).toBeUndefined()
    expect(result.data).toHaveLength(LIMIT)
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockFrom).toHaveBeenCalledTimes(2)
  })
})
