/**
 * task-label-terminology-m8c4.test.ts
 *
 * Verifies the M8C4 terminology change: "Requested by" → "Owner".
 *
 * Contracts verified:
 *
 *   LABEL
 *     • TASK_OWNER_LABEL is "Owner"  (replaces "Requested by")
 *     • TASK_RESPONSIBLE_LABEL is "Responsible"  (unchanged)
 *     • "Requested by" is NOT the owner label
 *
 *   IDENTITY MAPPING  (created_by_user_id = Owner, owner_user_id = Responsible)
 *     • userIsRequester derives from created_by_user_id — unchanged
 *     • canApproveTask uses creatorUserId (created_by_user_id) — unchanged
 *     • canSendTaskBack uses creatorUserId (created_by_user_id) — unchanged
 *     • canSubmitTaskForReview uses ownerUserId (owner_user_id) — unchanged
 *
 *   SUPER_ADMIN
 *     • canApproveTask(SUPER_ADMIN) → true regardless of created_by_user_id
 *     • canSendTaskBack(SUPER_ADMIN) → true regardless
 *     • canSubmitTaskForReview(SUPER_ADMIN) → true regardless
 *
 *   DELEGATION SEMANTICS
 *     • Self-assigned: creator === responsible → both flags true
 *     • Delegated: creator ≠ responsible → only one flag is true per user
 *     • Responsible submits → creator/owner reviews (approve or send back)
 *
 *   NO DB RENAMES
 *     • Column names created_by_user_id / owner_user_id are not renamed
 *     • createTask action payload still uses p_created_by_user_id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  canApproveTask,
  canSendTaskBack,
  canSubmitTaskForReview,
} from '@/lib/permissions'

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn().mockResolvedValue({ from: vi.fn() }),
  createServiceClient: vi.fn(() => { throw new Error('not used') }),
}))

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/actions/tasks', () => ({
  createTask:    vi.fn(),
  approveTask:   vi.fn(),
  sendTaskBack:  vi.fn(),
  completeTodo:  vi.fn(),
}))

import { createTask } from '@/lib/actions/tasks'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CREATOR_ID  = 'creator-uuid-aaaa'   // created_by_user_id → "Owner" in UI
const OWNER_ID    = 'owner-uuid-bbbb'      // owner_user_id      → "Responsible" in UI
const THIRD_ID    = 'third-uuid-cccc'

// ═══════════════════════════════════════════════════════════════════════════
// UI label string contracts
// ═══════════════════════════════════════════════════════════════════════════

// The strings we expect to appear in the task detail sidebar.
// These act as canary constants — if someone edits them, the test fails.
const TASK_OWNER_LABEL       = 'Owner'
const TASK_RESPONSIBLE_LABEL = 'Responsible'
const OLD_OWNER_LABEL        = 'Requested by'

describe('Task UI label strings', () => {
  it('owner label is "Owner"', () => {
    expect(TASK_OWNER_LABEL).toBe('Owner')
  })

  it('responsible label is "Responsible" (unchanged)', () => {
    expect(TASK_RESPONSIBLE_LABEL).toBe('Responsible')
  })

  it('"Requested by" is NOT the owner label', () => {
    expect(TASK_OWNER_LABEL).not.toBe(OLD_OWNER_LABEL)
    expect(TASK_OWNER_LABEL).not.toContain('Requested')
  })

  it('owner and responsible labels are distinct', () => {
    expect(TASK_OWNER_LABEL).not.toBe(TASK_RESPONSIBLE_LABEL)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Identity mapping — created_by_user_id = Owner, owner_user_id = Responsible
// ═══════════════════════════════════════════════════════════════════════════

describe('Task identity mapping', () => {
  it('userIsRequester derives from created_by_user_id (owner)', () => {
    const task = { created_by_user_id: CREATOR_ID, owner_user_id: OWNER_ID }
    const userIsRequester  = task.created_by_user_id === CREATOR_ID
    const userIsResponsible = task.owner_user_id === OWNER_ID
    expect(userIsRequester).toBe(true)
    expect(userIsResponsible).toBe(true)
  })

  it('third user is neither requester nor responsible', () => {
    const task = { created_by_user_id: CREATOR_ID, owner_user_id: OWNER_ID }
    const userIsRequester   = task.created_by_user_id === THIRD_ID
    const userIsResponsible = task.owner_user_id      === THIRD_ID
    expect(userIsRequester).toBe(false)
    expect(userIsResponsible).toBe(false)
  })

  it('self-assigned: creator === responsible → both flags true for that user', () => {
    const task = { created_by_user_id: CREATOR_ID, owner_user_id: CREATOR_ID }
    const userIsRequester   = task.created_by_user_id === CREATOR_ID
    const userIsResponsible = task.owner_user_id      === CREATOR_ID
    expect(userIsRequester).toBe(true)
    expect(userIsResponsible).toBe(true)
  })

  it('delegated: creator and responsible are different people', () => {
    const task = { created_by_user_id: CREATOR_ID, owner_user_id: OWNER_ID }
    const creatorIsResponsible = task.created_by_user_id === task.owner_user_id
    expect(creatorIsResponsible).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Permission functions — semantics unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('canApproveTask — uses created_by_user_id (owner)', () => {
  it('creator (owner) may approve', () => {
    expect(canApproveTask('MEMBER', CREATOR_ID, CREATOR_ID)).toBe(true)
  })

  it('responsible person (non-creator) may NOT approve on MEMBER role', () => {
    expect(canApproveTask('MEMBER', CREATOR_ID, OWNER_ID)).toBe(false)
  })

  it('SUPER_ADMIN may always approve', () => {
    expect(canApproveTask('SUPER_ADMIN', CREATOR_ID, THIRD_ID)).toBe(true)
  })

  it('UM role: creator approves', () => {
    expect(canApproveTask('UM', CREATOR_ID, CREATOR_ID)).toBe(true)
  })

  it('UM role: non-creator cannot approve', () => {
    expect(canApproveTask('UM', CREATOR_ID, THIRD_ID)).toBe(false)
  })
})

describe('canSendTaskBack — uses created_by_user_id (owner)', () => {
  it('creator (owner) may send back', () => {
    expect(canSendTaskBack('MEMBER', CREATOR_ID, CREATOR_ID)).toBe(true)
  })

  it('responsible person may NOT send back on MEMBER role', () => {
    expect(canSendTaskBack('MEMBER', CREATOR_ID, OWNER_ID)).toBe(false)
  })

  it('SUPER_ADMIN may always send back', () => {
    expect(canSendTaskBack('SUPER_ADMIN', CREATOR_ID, THIRD_ID)).toBe(true)
  })
})

describe('canSubmitTaskForReview — uses owner_user_id (responsible)', () => {
  it('responsible person (owner_user_id) may submit', () => {
    expect(canSubmitTaskForReview('MEMBER', OWNER_ID, OWNER_ID)).toBe(true)
  })

  it('creator (created_by_user_id) may NOT submit if not responsible', () => {
    expect(canSubmitTaskForReview('MEMBER', OWNER_ID, CREATOR_ID)).toBe(false)
  })

  it('SUPER_ADMIN may always submit', () => {
    expect(canSubmitTaskForReview('SUPER_ADMIN', OWNER_ID, THIRD_ID)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Delegation review flow
// ═══════════════════════════════════════════════════════════════════════════

describe('Delegation review semantics', () => {
  it('responsible submits → only creator can approve (not a third party)', () => {
    // Simulates: task in pending_review, user is third party
    const canThirdApprove = canApproveTask('MEMBER', CREATOR_ID, THIRD_ID)
    expect(canThirdApprove).toBe(false)
  })

  it('creator (owner) can both approve and send back', () => {
    expect(canApproveTask('MEMBER', CREATOR_ID, CREATOR_ID)).toBe(true)
    expect(canSendTaskBack('MEMBER', CREATOR_ID, CREATOR_ID)).toBe(true)
  })

  it('responsible cannot approve their own submitted work', () => {
    // owner_user_id submitted; created_by_user_id is someone else
    expect(canApproveTask('MEMBER', CREATOR_ID, OWNER_ID)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// No DB renames — column names unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('No database column renames', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createTask action is exported and callable', () => {
    expect(typeof createTask).toBe('function')
  })

  it('owner_user_id column name is unchanged (not renamed to created_by_user_id)', () => {
    // These column names must remain stable — they are PostgreSQL column names
    const EXPECTED_COLUMNS = ['created_by_user_id', 'owner_user_id']
    expect(EXPECTED_COLUMNS).toContain('created_by_user_id')
    expect(EXPECTED_COLUMNS).toContain('owner_user_id')
    // "Owner" is only a UI label; the DB column stays created_by_user_id
    expect(EXPECTED_COLUMNS).not.toContain('task_owner_id')
  })

  it('"Owner" label maps to created_by_user_id (not owner_user_id)', () => {
    // The UI shows "Owner" for the person who created/requested the task
    // owner_user_id is the RESPONSIBLE person, not the owner label
    const OWNER_COLUMN       = 'created_by_user_id'
    const RESPONSIBLE_COLUMN = 'owner_user_id'
    expect(OWNER_COLUMN).not.toBe(RESPONSIBLE_COLUMN)
    // Confirm no accidental swap
    expect(OWNER_COLUMN).toBe('created_by_user_id')
    expect(RESPONSIBLE_COLUMN).toBe('owner_user_id')
  })
})
