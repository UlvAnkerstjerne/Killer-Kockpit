/**
 * Tests for lib/actions/updates.ts — createUpdate server action
 *
 * Coverage:
 *
 *   AUTH
 *     • unauthenticated caller rejected
 *     • MEMBER rejected
 *     • UM allowed
 *     • SUPER_ADMIN allowed
 *     • author is always the session user — caller cannot choose
 *
 *   VALIDATION (application-layer, before the RPC is called)
 *     • blank body rejected
 *     • whitespace-only body rejected
 *     • valid occurred_on (YYYY-MM-DD) accepted
 *     • null occurred_on accepted
 *     • malformed date rejected
 *     • zero entity links rejected
 *     • unsupported entity type rejected
 *
 *   RPC DELEGATION
 *     • valid project link — RPC called with correct args
 *     • valid employee link — RPC called with correct args
 *     • valid location link — RPC called with correct args
 *     • multiple mixed links — all forwarded to RPC
 *     • nonexistent entity (RPC error "not found") → safe user error
 *     • one bad link among several → RPC error → safe user error
 *     • RPC generic error propagated safely
 *     • RPC success → update id returned
 *
 *   IMMUTABILITY
 *     • RPC never receives supersedes_update_id (not in the call args)
 *
 *   AUTHOR ISOLATION
 *     • p_created_by_user_id is always user.id, never from input
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser        = vi.fn()
  const mockCanAccessManagementView = vi.fn()
  const mockRpc                   = vi.fn()
  const mockServiceClient         = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockCanAccessManagementView,
    mockRpc,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({
  getCurrentUser: mocks.mockGetCurrentUser,
}))

vi.mock('@/lib/permissions', () => ({
  canAccessManagementView: mocks.mockCanAccessManagementView,
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
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

const OTHER_USER = {
  id:   'other-uuid',
  role: 'UM' as const,
  display_name: 'Other',
  email: 'other@killerkebab.com',
  active: true,
}

const PROJECT_LINK  = { entity_type: 'project'  as const, entity_id: 'proj-uuid' }
const EMPLOYEE_LINK = { entity_type: 'employee' as const, entity_id: 'emp-uuid'  }
const LOCATION_LINK = { entity_type: 'location' as const, entity_id: 'loc-uuid'  }

const VALID_INPUT = {
  body:         'Ronnie was promoted to store manager.',
  occurred_on:  '2026-09-01',
  entity_links: [PROJECT_LINK],
}

// ─── Import after mocks ───────────────────────────────────────────────────────

import { createUpdate } from '@/lib/actions/updates'

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

  it('rejects MEMBER role', async () => {
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

  it('p_created_by_user_id is always session user id, never from input', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // Caller passes no user id — the action derives it from the session
    await createUpdate(VALID_INPUT)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_created_by_user_id).toBe(SUPER_ADMIN.id)
    expect(args.p_created_by_user_id).not.toBe(OTHER_USER.id)
  })

  it('two calls with different sessions each use the correct user id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValueOnce(SUPER_ADMIN)
    mocks.mockRpc.mockResolvedValueOnce({ data: 'id-1', error: null })
    await createUpdate(VALID_INPUT)

    mocks.mockGetCurrentUser.mockResolvedValueOnce(UM_USER)
    mocks.mockRpc.mockResolvedValueOnce({ data: 'id-2', error: null })
    await createUpdate(VALID_INPUT)

    const calls = mocks.mockRpc.mock.calls
    expect(calls[0][1].p_created_by_user_id).toBe(SUPER_ADMIN.id)
    expect(calls[1][1].p_created_by_user_id).toBe(UM_USER.id)
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

  it('rejects malformed date — timestamp format', async () => {
    const result = await createUpdate({ ...VALID_INPUT, occurred_on: '2026-09-01T00:00:00Z' })
    expect(result.error).toMatch(/YYYY-MM-DD/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed date — free text', async () => {
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

  it('nonexistent project — RPC "not found" error → safe user message', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'project not found: 00000000-0000-0000-0000-000000000000' },
    })
    const result = await createUpdate({ ...VALID_INPUT, entity_links: [PROJECT_LINK] })
    expect(result.error).toMatch(/not found/i)
    expect(result.data).toBeUndefined()
  })

  it('nonexistent employee — RPC "not found" error → safe user message', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'employee not found: 00000000-0000-0000-0000-000000000000' },
    })
    const result = await createUpdate({ ...VALID_INPUT, entity_links: [EMPLOYEE_LINK] })
    expect(result.error).toMatch(/not found/i)
    expect(result.data).toBeUndefined()
  })

  it('nonexistent location — RPC "not found" error → safe user message', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'location not found: 00000000-0000-0000-0000-000000000000' },
    })
    const result = await createUpdate({ ...VALID_INPUT, entity_links: [LOCATION_LINK] })
    expect(result.error).toMatch(/not found/i)
    expect(result.data).toBeUndefined()
  })

  it('one bad link among several → RPC error → total failure, safe message', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'project not found: bad-id' },
    })
    const result = await createUpdate({
      ...VALID_INPUT,
      entity_links: [PROJECT_LINK, EMPLOYEE_LINK, LOCATION_LINK],
    })
    // Entire operation fails — RPC rolls back atomically
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
    // RPC was called exactly once (not retried)
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('generic RPC error propagated safely without exposing internal message', async () => {
    mocks.mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'internal server error' },
    })
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toMatch(/please try again/i)
    // Internal error message must not leak verbatim
    expect(result.error).not.toContain('internal server error')
    expect(result.data).toBeUndefined()
  })

  it('returns created update id on success', async () => {
    const result = await createUpdate(VALID_INPUT)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ id: 'new-update-uuid' })
  })

  // ── IMMUTABILITY ─────────────────────────────────────────────────────────────

  it('never passes supersedes_update_id to the RPC', async () => {
    await createUpdate(VALID_INPUT)
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('supersedes_update_id')
    expect(args).not.toHaveProperty('p_supersedes_update_id')
  })
})
