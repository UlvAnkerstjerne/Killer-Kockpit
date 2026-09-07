/**
 * capture-save.test.ts
 *
 * Unit tests for the saveApprovedCaptures() server action (M8B5).
 *
 * Tests in Node — no DOM, no real DB.
 *
 * Covers:
 *   - Authentication gate
 *   - Management role gate
 *   - Basic: call count matches input count
 *   - Payload: body, occurred_on, entity_links passed to createUpdate
 *   - Sequential: all inputs are processed even if one fails
 *   - Partial failure: per-candidate results, safe error text
 *   - Full success: all results ok with ids
 *   - Privacy: no raw_text, no analysis_note, no author id in payload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  canAccessManagementView: vi.fn(),
}))

vi.mock('@/lib/actions/updates', () => ({
  createUpdate: vi.fn(),
}))

import { getCurrentUser }          from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { createUpdate }            from '@/lib/actions/updates'
import {
  saveApprovedCaptures,
  type CaptureApprovalInput,
  type CandidateSaveResult,
} from '@/lib/actions/capture'

const mockGetCurrentUser      = getCurrentUser          as ReturnType<typeof vi.fn>
const mockCanAccessManagement = canAccessManagementView as ReturnType<typeof vi.fn>
const mockCreateUpdate        = createUpdate            as ReturnType<typeof vi.fn>

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANAGER_USER = { id: 'user-mgr', role: 'UM', display_name: 'Manager' }
const MEMBER_USER  = { id: 'user-mbr', role: 'MEMBER', display_name: 'Member' }

const INPUT_ONE: CaptureApprovalInput = {
  body:         'Ahmed Al-Rashid promoted to Head Chef.',
  occurred_on:  '2026-09-05',
  entity_links: [{ entity_type: 'employee', entity_id: 'emp-1' }],
}

const INPUT_TWO: CaptureApprovalInput = {
  body:         'Nørrebro passed health inspection.',
  occurred_on:  '2026-09-05',
  entity_links: [{ entity_type: 'location', entity_id: 'loc-1' }],
}

function setupHappy() {
  mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
  mockCanAccessManagement.mockReturnValue(true)
  mockCreateUpdate.mockResolvedValue({ data: { id: 'update-1' } })
}

// ── Authentication gate ────────────────────────────────────────────────────────

describe('saveApprovedCaptures — authentication', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    const result = await saveApprovedCaptures([INPUT_ONE])
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/not authenticated/i)
  })

  it('does not call createUpdate when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    await saveApprovedCaptures([INPUT_ONE])
    expect(mockCreateUpdate).not.toHaveBeenCalled()
  })
})

// ── Role gate ──────────────────────────────────────────────────────────────────

describe('saveApprovedCaptures — role gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error for MEMBER role', async () => {
    mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mockCanAccessManagement.mockReturnValue(false)
    const result = await saveApprovedCaptures([INPUT_ONE])
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/access denied/i)
  })

  it('does not call createUpdate for MEMBER role', async () => {
    mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mockCanAccessManagement.mockReturnValue(false)
    await saveApprovedCaptures([INPUT_ONE])
    expect(mockCreateUpdate).not.toHaveBeenCalled()
  })

  it('proceeds for UM role', async () => {
    setupHappy()
    const result = await saveApprovedCaptures([INPUT_ONE])
    expect(result).toHaveProperty('results')
  })

  it('proceeds for SUPER_ADMIN role', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-sa', role: 'SUPER_ADMIN' })
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateUpdate.mockResolvedValue({ data: { id: 'update-sa' } })
    const result = await saveApprovedCaptures([INPUT_ONE])
    expect(result).toHaveProperty('results')
  })
})

// ── Basic: call count ──────────────────────────────────────────────────────────

describe('saveApprovedCaptures — call count', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls createUpdate once for a single input', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    expect(mockCreateUpdate).toHaveBeenCalledTimes(1)
  })

  it('calls createUpdate once per input for three inputs', async () => {
    setupHappy()
    const inputThree: CaptureApprovalInput = {
      body:         'Knife sharpening SOP approved.',
      occurred_on:  null,
      entity_links: [{ entity_type: 'project', entity_id: 'proj-1' }],
    }
    await saveApprovedCaptures([INPUT_ONE, INPUT_TWO, inputThree])
    expect(mockCreateUpdate).toHaveBeenCalledTimes(3)
  })

  it('returns one result per input', async () => {
    setupHappy()
    const r = await saveApprovedCaptures([INPUT_ONE, INPUT_TWO])
    expect((r as { results: CandidateSaveResult[] }).results).toHaveLength(2)
  })
})

// ── Payload: correct fields passed to createUpdate ────────────────────────────

describe('saveApprovedCaptures — payload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes body to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    expect(mockCreateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Ahmed Al-Rashid promoted to Head Chef.' }),
    )
  })

  it('passes occurred_on to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    expect(mockCreateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ occurred_on: '2026-09-05' }),
    )
  })

  it('passes null occurred_on when supplied', async () => {
    setupHappy()
    const input: CaptureApprovalInput = { ...INPUT_ONE, occurred_on: null }
    await saveApprovedCaptures([input])
    expect(mockCreateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ occurred_on: null }),
    )
  })

  it('passes entity_links to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    expect(mockCreateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_links: [{ entity_type: 'employee', entity_id: 'emp-1' }],
      }),
    )
  })

  it('passes multiple entity_links correctly', async () => {
    setupHappy()
    const input: CaptureApprovalInput = {
      body:         'Update linked to both an employee and a project.',
      occurred_on:  null,
      entity_links: [
        { entity_type: 'employee', entity_id: 'emp-1' },
        { entity_type: 'project',  entity_id: 'proj-1' },
      ],
    }
    await saveApprovedCaptures([input])
    expect(mockCreateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_links: [
          { entity_type: 'employee', entity_id: 'emp-1' },
          { entity_type: 'project',  entity_id: 'proj-1' },
        ],
      }),
    )
  })

  it('passes each input to its own createUpdate call in order', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE, INPUT_TWO])
    expect(mockCreateUpdate.mock.calls[0][0]).toMatchObject({ body: INPUT_ONE.body })
    expect(mockCreateUpdate.mock.calls[1][0]).toMatchObject({ body: INPUT_TWO.body })
  })
})

// ── Full success ───────────────────────────────────────────────────────────────

describe('saveApprovedCaptures — full success', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns ok: true with id for a successful save', async () => {
    setupHappy()
    mockCreateUpdate.mockResolvedValueOnce({ data: { id: 'upd-abc' } })
    const r = await saveApprovedCaptures([INPUT_ONE])
    const results = (r as { results: CandidateSaveResult[] }).results
    expect(results[0]).toEqual({ ok: true, id: 'upd-abc' })
  })

  it('returns ok: true for every input when all succeed', async () => {
    setupHappy()
    mockCreateUpdate
      .mockResolvedValueOnce({ data: { id: 'upd-1' } })
      .mockResolvedValueOnce({ data: { id: 'upd-2' } })
    const r = await saveApprovedCaptures([INPUT_ONE, INPUT_TWO])
    const results = (r as { results: CandidateSaveResult[] }).results
    expect(results[0]).toEqual({ ok: true, id: 'upd-1' })
    expect(results[1]).toEqual({ ok: true, id: 'upd-2' })
  })
})

// ── Partial failure ────────────────────────────────────────────────────────────

describe('saveApprovedCaptures — partial failure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns ok: false for a failed input', async () => {
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateUpdate.mockResolvedValue({ error: 'DB constraint violated.' })

    const r = await saveApprovedCaptures([INPUT_ONE])
    const results = (r as { results: CandidateSaveResult[] }).results
    expect(results[0].ok).toBe(false)
  })

  it('returns a safe error string — not the raw DB error', async () => {
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateUpdate.mockResolvedValue({ error: 'violates foreign-key constraint "kk_updates_project_id_fkey"' })

    const r = await saveApprovedCaptures([INPUT_ONE])
    const results = (r as { results: CandidateSaveResult[] }).results
    expect((results[0] as { ok: false; error: string }).error).not.toMatch(/foreign.key/i)
    expect((results[0] as { ok: false; error: string }).error).toMatch(/try again/i)
  })

  it('processes remaining inputs after a failure (sequential, non-aborting)', async () => {
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateUpdate
      .mockResolvedValueOnce({ error: 'DB error.' })
      .mockResolvedValueOnce({ data: { id: 'upd-2' } })

    const r = await saveApprovedCaptures([INPUT_ONE, INPUT_TWO])
    expect(mockCreateUpdate).toHaveBeenCalledTimes(2)
    const results = (r as { results: CandidateSaveResult[] }).results
    expect(results[0].ok).toBe(false)
    expect(results[1]).toEqual({ ok: true, id: 'upd-2' })
  })

  it('returns mixed results correctly (success then failure)', async () => {
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateUpdate
      .mockResolvedValueOnce({ data: { id: 'upd-ok' } })
      .mockResolvedValueOnce({ error: 'DB error.' })

    const r = await saveApprovedCaptures([INPUT_ONE, INPUT_TWO])
    const results = (r as { results: CandidateSaveResult[] }).results
    expect(results[0]).toEqual({ ok: true, id: 'upd-ok' })
    expect(results[1].ok).toBe(false)
  })
})

// ── Privacy ───────────────────────────────────────────────────────────────────

describe('saveApprovedCaptures — privacy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not pass raw_text to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    const callArg = mockCreateUpdate.mock.calls[0][0]
    expect(callArg).not.toHaveProperty('raw_text')
  })

  it('does not pass analysis_note to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    const callArg = mockCreateUpdate.mock.calls[0][0]
    expect(callArg).not.toHaveProperty('analysis_note')
  })

  it('does not pass author / user id to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    const callArg = mockCreateUpdate.mock.calls[0][0]
    expect(callArg).not.toHaveProperty('author_id')
    expect(callArg).not.toHaveProperty('created_by_user_id')
    expect(callArg).not.toHaveProperty('user_id')
  })

  it('does not pass supersedes_update_id to createUpdate', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    const callArg = mockCreateUpdate.mock.calls[0][0]
    expect(callArg).not.toHaveProperty('supersedes_update_id')
  })

  it('createUpdate payload contains ONLY the approved human-reviewed fields', async () => {
    setupHappy()
    await saveApprovedCaptures([INPUT_ONE])
    const callArg = mockCreateUpdate.mock.calls[0][0]
    const allowedKeys = new Set(['body', 'occurred_on', 'entity_links'])
    const actualKeys  = Object.keys(callArg)
    for (const key of actualKeys) {
      expect(allowedKeys).toContain(key)
    }
  })
})
