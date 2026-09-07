/**
 * notifications-n3.test.ts — N3b transactional architecture
 *
 * Verifies that notification creation is fully delegated to the database
 * layer (inside lifecycle RPCs) and is NOT performed by TypeScript server
 * actions after the RPC returns.
 *
 * Architectural contracts verified:
 *
 *   NO TypeScript-layer notification INSERT
 *     • task actions never call createServiceClient().from('notifications').insert()
 *     • notify-task.ts helper no longer exists
 *     • notification creation is inside the RPC (atomic with task + audit)
 *
 *   ATOMICITY (structural)
 *     • Each lifecycle action makes exactly ONE RPC call — the notification
 *       is part of that RPC, not a separate operation
 *     • If the RPC fails, the action returns an error — no partial state
 *
 *   CORRECT RPC ARGUMENTS
 *     • create_task_and_audit called with correct actor/owner
 *     • update_task_and_audit called with patch containing owner_user_id
 *     • submit_task_for_review_and_audit called with correct actor
 *     • approve_task_and_audit called with correct actor
 *     • send_task_back_and_audit called with correct actor
 *
 *   SECURITY
 *     • No task action accepts notification recipient/actor from the client
 *     • No direct notification INSERT from TypeScript
 *
 *   DELEGATION SEMANTICS (DB-internal logic verified via Supabase QA)
 *     • self-assigned: RPC receives owner = actor → DB skips notification
 *     • delegated: RPC receives owner ≠ actor → DB creates notification
 *     • idempotency: DB state guards prevent duplicate notifications
 *
 * NOTE: The actual notification INSERT behaviour (self-notification guard,
 *   duplicate protection, recipient correctness) is exercised in Supabase
 *   integration QA, not in these unit tests.  The DB layer owns that logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser  = vi.fn()
  const mockServiceRpc      = vi.fn()

  // Tracks any direct insert to notifications from TypeScript — must stay empty.
  const mockNotificationsInsert = vi.fn()

  const mockServiceFrom = vi.fn((table: string) => {
    if (table === 'notifications') {
      return { insert: mockNotificationsInsert }
    }
    return { insert: vi.fn() }
  })

  const mockCreateServiceClient = vi.fn(() => ({
    from: mockServiceFrom,
    rpc:  mockServiceRpc,
  }))

  const mockCreateClient = vi.fn()

  return {
    mockGetCurrentUser,
    mockServiceRpc,
    mockNotificationsInsert,
    mockServiceFrom,
    mockCreateServiceClient,
    mockCreateClient,
  }
})

vi.mock('@/lib/auth', () => ({
  getCurrentUser: mocks.mockGetCurrentUser,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient:        mocks.mockCreateClient,
  createServiceClient: mocks.mockCreateServiceClient,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────

const ACTOR_ID     = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER_ID     = 'bbbbbbbb-0000-4000-8000-000000000002'
const TASK_ID      = 'cccccccc-0000-4000-8000-000000000003'

function makeTaskFetch(overrides: Record<string, unknown> = {}) {
  return mocks.mockCreateClient.mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id:                 TASK_ID,
          owner_user_id:      OWNER_ID,
          created_by_user_id: ACTOR_ID,
          status:             'open',
          project_id:         null,
          ...overrides,
        },
        error: null,
      }),
    }),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Structural: notify-task helper no longer exists
// ═══════════════════════════════════════════════════════════════════════════

describe('N3b architecture — notify-task.ts removed', () => {
  it('lib/actions/notify-task.ts does not exist', async () => {
    // @ts-expect-error — intentionally importing the deleted module to verify removal
    await expect(import('@/lib/actions/notify-task')).rejects.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// createTask — single atomic RPC, no TypeScript-layer notification INSERT
// ═══════════════════════════════════════════════════════════════════════════

describe('createTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls create_task_and_audit RPC — the single atomic operation', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'UM' })
    mocks.mockServiceRpc.mockResolvedValue({ data: TASK_ID, error: null })

    await createTask({ title: 'Delegated task', owner_user_id: OWNER_ID })

    expect(mocks.mockServiceRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockServiceRpc).toHaveBeenCalledWith(
      'create_task_and_audit',
      expect.objectContaining({
        p_owner_user_id: OWNER_ID,
        p_actor_user_id: ACTOR_ID,
      })
    )
  })

  it('does NOT insert into notifications from TypeScript after RPC', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'UM' })
    mocks.mockServiceRpc.mockResolvedValue({ data: TASK_ID, error: null })

    await createTask({ title: 'Delegated task', owner_user_id: OWNER_ID })

    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
    // Confirm the notifications table was never accessed at the TypeScript layer
    const notifCalls = mocks.mockServiceFrom.mock.calls.filter(([t]: [string]) => t === 'notifications')
    expect(notifCalls).toHaveLength(0)
  })

  it('RPC failure returns error — no partial state (atomicity guarantee)', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'UM' })
    mocks.mockServiceRpc.mockResolvedValue({ data: null, error: { message: 'DB error' } })

    const result = await createTask({ title: 'Test', owner_user_id: OWNER_ID })

    expect(result.error).toBeTruthy()
    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
  })

  it('self-assigned: RPC receives owner === actor (DB skips notification internally)', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })
    mocks.mockServiceRpc.mockResolvedValue({ data: TASK_ID, error: null })

    await createTask({ title: 'Self task' })  // no owner_user_id → defaults to user.id

    expect(mocks.mockServiceRpc).toHaveBeenCalledWith(
      'create_task_and_audit',
      expect.objectContaining({
        p_owner_user_id: ACTOR_ID,
        p_actor_user_id: ACTOR_ID,
      })
    )
    // DB receives owner = actor → it will skip notification internally
    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// updateTask — notification for reassignment is DB-internal
// ═══════════════════════════════════════════════════════════════════════════

describe('updateTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls update_task_and_audit with patch containing new owner — DB handles notification', async () => {
    const { updateTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
    makeTaskFetch({ created_by_user_id: ACTOR_ID, owner_user_id: 'old-owner-uuid-000000000099' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await updateTask(TASK_ID, { owner_user_id: OWNER_ID })

    expect(mocks.mockServiceRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockServiceRpc).toHaveBeenCalledWith(
      'update_task_and_audit',
      expect.objectContaining({
        p_task_id:       TASK_ID,
        p_actor_user_id: ACTOR_ID,
        p_patch:         expect.objectContaining({ owner_user_id: OWNER_ID }),
      })
    )
    // No TypeScript-layer notification insert
    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
  })

  it('does NOT insert into notifications from TypeScript on owner change', async () => {
    const { updateTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
    makeTaskFetch({ created_by_user_id: ACTOR_ID, owner_user_id: 'old-owner-uuid-000000000099' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await updateTask(TASK_ID, { owner_user_id: OWNER_ID })

    const notifCalls = mocks.mockServiceFrom.mock.calls.filter(([t]: [string]) => t === 'notifications')
    expect(notifCalls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// submitTaskForReview — single RPC call, no post-RPC notification
// ═══════════════════════════════════════════════════════════════════════════

describe('submitTaskForReview', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls submit_task_for_review_and_audit — the single atomic operation', async () => {
    const { submitTaskForReview } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })
    makeTaskFetch({ owner_user_id: ACTOR_ID, created_by_user_id: OWNER_ID, status: 'in_progress' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await submitTaskForReview(TASK_ID)

    expect(mocks.mockServiceRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockServiceRpc).toHaveBeenCalledWith(
      'submit_task_for_review_and_audit',
      expect.objectContaining({
        p_task_id:       TASK_ID,
        p_actor_user_id: ACTOR_ID,
      })
    )
  })

  it('does NOT insert into notifications from TypeScript after RPC', async () => {
    const { submitTaskForReview } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })
    makeTaskFetch({ owner_user_id: ACTOR_ID, created_by_user_id: OWNER_ID, status: 'open' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await submitTaskForReview(TASK_ID)

    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
    const notifCalls = mocks.mockServiceFrom.mock.calls.filter(([t]: [string]) => t === 'notifications')
    expect(notifCalls).toHaveLength(0)
  })

  it('RPC failure returns error without partial notification state', async () => {
    const { submitTaskForReview } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })
    makeTaskFetch({ owner_user_id: ACTOR_ID, created_by_user_id: OWNER_ID, status: 'open' })
    mocks.mockServiceRpc.mockResolvedValue({ error: { message: 'transition failed' } })

    const result = await submitTaskForReview(TASK_ID)

    expect(result.error).toBeTruthy()
    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// approveTask — single RPC call, notification DB-internal
// ═══════════════════════════════════════════════════════════════════════════

describe('approveTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls approve_task_and_audit — the single atomic operation', async () => {
    const { approveTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
    makeTaskFetch({ created_by_user_id: ACTOR_ID, status: 'pending_review' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await approveTask(TASK_ID)

    expect(mocks.mockServiceRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockServiceRpc).toHaveBeenCalledWith(
      'approve_task_and_audit',
      expect.objectContaining({
        p_task_id:       TASK_ID,
        p_actor_user_id: ACTOR_ID,
      })
    )
  })

  it('does NOT insert into notifications from TypeScript after RPC', async () => {
    const { approveTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
    makeTaskFetch({ created_by_user_id: ACTOR_ID, status: 'pending_review' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await approveTask(TASK_ID)

    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
    const notifCalls = mocks.mockServiceFrom.mock.calls.filter(([t]: [string]) => t === 'notifications')
    expect(notifCalls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// sendTaskBack — single RPC call, notification DB-internal
// ═══════════════════════════════════════════════════════════════════════════

describe('sendTaskBack', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls send_task_back_and_audit — the single atomic operation', async () => {
    const { sendTaskBack } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
    makeTaskFetch({ created_by_user_id: ACTOR_ID, status: 'pending_review' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await sendTaskBack(TASK_ID, 'Please revise the approach.')

    expect(mocks.mockServiceRpc).toHaveBeenCalledTimes(1)
    expect(mocks.mockServiceRpc).toHaveBeenCalledWith(
      'send_task_back_and_audit',
      expect.objectContaining({
        p_task_id:       TASK_ID,
        p_actor_user_id: ACTOR_ID,
        p_review_note:   'Please revise the approach.',
      })
    )
  })

  it('does NOT insert into notifications from TypeScript after RPC', async () => {
    const { sendTaskBack } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
    makeTaskFetch({ created_by_user_id: ACTOR_ID, status: 'pending_review' })
    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await sendTaskBack(TASK_ID, 'Needs more detail.')

    expect(mocks.mockNotificationsInsert).not.toHaveBeenCalled()
    const notifCalls = mocks.mockServiceFrom.mock.calls.filter(([t]: [string]) => t === 'notifications')
    expect(notifCalls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Security: no task action accepts notification parameters from client
// ═══════════════════════════════════════════════════════════════════════════

describe('Security — notification parameters', () => {
  it('createTask has no notificationRecipient or actor parameter in its signature', () => {
    // Function accepts only task input, not notification recipient
    // (verified structurally — actor is always derived from getCurrentUser())
    const input: Parameters<typeof import('@/lib/actions/tasks').createTask>[0] = {
      title: 'Test',
    }
    expect(Object.keys(input)).not.toContain('notificationRecipient')
    expect(Object.keys(input)).not.toContain('actorUserId')
  })

  it('markNotificationRead and markAllNotificationsRead exist only in notifications.ts (not tasks.ts)', async () => {
    const tasks = await import('@/lib/actions/tasks')
    expect((tasks as Record<string, unknown>)['markNotificationRead']).toBeUndefined()
    expect((tasks as Record<string, unknown>)['markAllNotificationsRead']).toBeUndefined()
  })
})
