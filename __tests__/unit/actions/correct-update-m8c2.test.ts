/**
 * correct-update-m8c2.test.ts
 *
 * M8C2-specific coverage: correctUpdate server action.
 *
 * Architecture under test:
 *   Application layer: getCurrentUser() + canAccessManagementView() + validation
 *   Database layer: correct_update RPC (SECURITY DEFINER, DB-derived author+role)
 *   RPC called via createClient() (JWT session) — NOT createServiceClient().
 *
 * Contracts verified:
 *
 *   AUTH
 *     • unauthenticated rejected at action layer
 *     • MEMBER rejected at action layer
 *     • UM allowed
 *     • SUPER_ADMIN allowed
 *     • RPC args never contain author / user id
 *     • no createServiceClient call
 *
 *   VALIDATION
 *     • malformed updateId rejected
 *     • blank body rejected
 *     • whitespace-only body rejected
 *     • valid YYYY-MM-DD accepted
 *     • null occurred_on accepted
 *     • malformed date rejected
 *     • trimmed body forwarded to RPC
 *
 *   RPC DELEGATION
 *     • correct RPC name called (correct_update)
 *     • p_update_id forwarded
 *     • p_body forwarded (trimmed)
 *     • p_occurred_on forwarded (null → null)
 *     • no p_entity_links / p_supersedes_update_id / author supplied
 *     • RPC success → new update id returned
 *     • RPC "already been corrected" → conflict message
 *     • RPC "not found" → safe not-found message
 *     • generic RPC error → safe generic message
 *
 *   CORRECTION CHAIN / CURRENTNESS (via mocked RPC responses)
 *     • correcting a current Update succeeds
 *     • correcting an already-superseded Update returns conflict error
 *
 *   IMMUTABILITY
 *     • caller cannot supply supersedes_update_id in args
 *     • caller cannot supply entity_links in args
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
  createClient:        vi.fn().mockResolvedValue(mocks.mockUserClient),
  createServiceClient: vi.fn(() => {
    throw new Error('createServiceClient must NOT be called by M8C2 correctUpdate')
  }),
}))

// ─── Import after mocks ────────────────────────────────────────────────────────

import { correctUpdate } from '@/lib/actions/updates'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MANAGER     = { id: 'mgr-uuid', role: 'UM' as const,         display_name: 'Manager' }
const SUPER_ADMIN = { id: 'sa-uuid',  role: 'SUPER_ADMIN' as const, display_name: 'Admin'  }
const MEMBER      = { id: 'mbr-uuid', role: 'MEMBER' as const,     display_name: 'Member'  }

const UPD_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const NEW_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupHappyRpc(returnValue: string = NEW_ID) {
  mocks.mockRpc.mockResolvedValueOnce({ data: returnValue, error: null })
}

function setupRpcError(message: string) {
  mocks.mockRpc.mockResolvedValueOnce({ data: null, error: { message } })
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

describe('correctUpdate — AUTH', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('unauthenticated caller rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('MEMBER rejected', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER)
    mocks.mockCanAccessManagementView.mockReturnValue(false)
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('UM allowed — reaches RPC', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyRpc()
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('SUPER_ADMIN allowed — reaches RPC', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyRpc()
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })

  it('RPC args contain no author / user id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_created_by_user_id')
    expect(args).not.toHaveProperty('author_id')
    expect(args).not.toHaveProperty('user_id')
  })

  it('no createServiceClient call', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyRpc()
    await expect(
      correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    ).resolves.not.toThrow()
    // createServiceClient mock throws if called — reaching here means it was not called
  })
})

// ─── VALIDATION ──────────────────────────────────────────────────────────────

describe('correctUpdate — VALIDATION', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
  })

  it('malformed updateId rejected', async () => {
    const result = await correctUpdate({ updateId: 'not-a-uuid', body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/invalid update id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('empty updateId rejected', async () => {
    const result = await correctUpdate({ updateId: '', body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/invalid update id/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('blank body rejected', async () => {
    const result = await correctUpdate({ updateId: UPD_ID, body: '', occurred_on: null })
    expect(result.error).toMatch(/blank/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('whitespace-only body rejected', async () => {
    const result = await correctUpdate({ updateId: UPD_ID, body: '   ', occurred_on: null })
    expect(result.error).toMatch(/blank/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('body is trimmed before forwarding to RPC', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: '  Trimmed body.  ', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_body).toBe('Trimmed body.')
  })

  it('valid YYYY-MM-DD occurred_on accepted', async () => {
    setupHappyRpc()
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: '2026-09-05' })
    expect(result.error).toBeUndefined()
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_occurred_on).toBe('2026-09-05')
  })

  it('null occurred_on accepted and forwarded', async () => {
    setupHappyRpc()
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toBeUndefined()
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_occurred_on).toBeNull()
  })

  it('malformed date rejected', async () => {
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: '5th September' })
    expect(result.error).toMatch(/YYYY-MM-DD/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('timestamp format rejected', async () => {
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: '2026-09-05T10:00:00Z' })
    expect(result.error).toMatch(/YYYY-MM-DD/i)
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })
})

// ─── RPC DELEGATION ──────────────────────────────────────────────────────────

describe('correctUpdate — RPC delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
  })

  it('calls correct_update RPC (not create_update_and_links)', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    const [rpcName] = mocks.mockRpc.mock.calls[0]
    expect(rpcName).toBe('correct_update')
  })

  it('p_update_id forwarded correctly', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_update_id).toBe(UPD_ID)
  })

  it('p_body forwarded (trimmed)', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: '  Correction.  ', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_body).toBe('Correction.')
  })

  it('p_occurred_on forwarded', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: '2026-09-07' })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args.p_occurred_on).toBe('2026-09-07')
  })

  it('RPC args do not include entity_links', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_entity_links')
    expect(args).not.toHaveProperty('entity_links')
  })

  it('RPC args do not include supersedes_update_id', async () => {
    setupHappyRpc()
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    expect(args).not.toHaveProperty('p_supersedes_update_id')
    expect(args).not.toHaveProperty('supersedes_update_id')
  })

  it('RPC success returns new update id', async () => {
    setupHappyRpc(NEW_ID)
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(NEW_ID)
  })

  it('"already been corrected" RPC error → conflict message', async () => {
    setupRpcError('Update has already been corrected')
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/already been corrected/i)
  })

  it('"not found" RPC error → safe not-found message', async () => {
    setupRpcError('Update not found: aaaa')
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/not found/i)
  })

  it('generic RPC error → safe generic message (no internals exposed)', async () => {
    setupRpcError('internal DB error details')
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).not.toContain('internal DB error details')
    expect(result.error).toMatch(/failed|try again/i)
  })
})

// ─── CURRENTNESS VIA MOCKED RPC RESPONSES ────────────────────────────────────

describe('correctUpdate — currentness (mocked RPC)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
  })

  it('correcting a current Update succeeds', async () => {
    setupHappyRpc(NEW_ID)
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(NEW_ID)
  })

  it('correcting an already-superseded Update returns conflict error', async () => {
    setupRpcError('Update has already been corrected')
    const result = await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    expect(result.error).toMatch(/already been corrected/i)
    expect(result.data).toBeUndefined()
  })

  it('correcting a successor (chain A→B→C) — one RPC call, unique new id returned', async () => {
    const CHAIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    setupHappyRpc(CHAIN_ID)
    const result = await correctUpdate({ updateId: NEW_ID, body: 'Further fix.', occurred_on: null })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(CHAIN_ID)
    expect(mocks.mockRpc).toHaveBeenCalledTimes(1)
  })
})

// ─── IMMUTABILITY CONTRACTS ───────────────────────────────────────────────────

describe('correctUpdate — immutability contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(MANAGER)
    mocks.mockCanAccessManagementView.mockReturnValue(true)
    setupHappyRpc()
  })

  it('caller cannot supply entity_links — args object has only p_update_id, p_body, p_occurred_on', async () => {
    await correctUpdate({ updateId: UPD_ID, body: 'Fixed.', occurred_on: null })
    const [, args] = mocks.mockRpc.mock.calls[0]
    const keys = Object.keys(args)
    expect(keys).toContain('p_update_id')
    expect(keys).toContain('p_body')
    expect(keys).toContain('p_occurred_on')
    expect(keys).not.toContain('p_entity_links')
    expect(keys).not.toContain('p_created_by_user_id')
    expect(keys).not.toContain('p_supersedes_update_id')
    // Exactly these three and nothing else
    expect(keys).toHaveLength(3)
  })
})
