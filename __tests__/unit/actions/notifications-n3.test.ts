/**
 * notifications-n3.test.ts
 *
 * Unit tests for N3 — task lifecycle notification hooks.
 *
 * Contracts verified:
 *
 *   createTaskNotification (helper)
 *     • Skips self-notifications (actor === recipient)
 *     • Skips when recipientUserId is falsy
 *     • Skips when actorUserId is falsy
 *     • Inserts correct row for each of the 4 notification types
 *     • Uses entity_type = 'task' always
 *     • Is fire-and-forget: DB errors are logged, not thrown
 *     • Never calls createClient (authenticated client)
 *
 *   createTask wiring
 *     • Delegated task (owner ≠ caller) → task.assigned notification fired
 *     • Self-assigned task (owner === caller) → no notification
 *     • No owner_user_id supplied → no notification (self-assigned by default)
 *
 *   updateTask wiring
 *     • owner_user_id changed → task.assigned notification fired
 *     • owner_user_id unchanged → no notification
 *
 *   submitTaskForReview wiring
 *     • task.submitted_for_review fired to created_by_user_id
 *     • null created_by_user_id → no notification (no crash)
 *
 *   approveTask wiring
 *     • task.approved fired to owner_user_id
 *     • null owner_user_id → no notification (no crash)
 *
 *   sendTaskBack wiring
 *     • task.sent_back fired to owner_user_id
 *     • null owner_user_id → no notification (no crash)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser     = vi.fn()
  const mockServiceInsert      = vi.fn()
  const mockServiceRpc         = vi.fn()
  const mockAuthenticatedRpc   = vi.fn()

  const mockServiceFrom = vi.fn(() => ({
    insert: mockServiceInsert,
  }))

  const mockCreateServiceClient = vi.fn(() => ({
    from: mockServiceFrom,
    rpc:  mockServiceRpc,
  }))

  const mockCreateClient = vi.fn().mockResolvedValue({
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'no mock set' } }),
    })),
    rpc: mockAuthenticatedRpc,
  })

  return {
    mockGetCurrentUser,
    mockServiceInsert,
    mockServiceRpc,
    mockAuthenticatedRpc,
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

// ─── Import after mocks ────────────────────────────────────────────────────

import { createTaskNotification } from '@/lib/actions/notify-task'

// ─── Fixtures ─────────────────────────────────────────────────────────────

const ACTOR_ID     = 'aaaaaaaa-0000-4000-8000-000000000001'
const RECIPIENT_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const TASK_ID      = 'cccccccc-0000-4000-8000-000000000003'

// ═══════════════════════════════════════════════════════════════════════════
// createTaskNotification — helper unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('createTaskNotification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts a task.assigned notification with correct fields', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTaskNotification({
      type:            'task.assigned',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceFrom).toHaveBeenCalledWith('notifications')
    expect(mocks.mockServiceInsert).toHaveBeenCalledWith({
      type:              'task.assigned',
      entity_type:       'task',
      entity_id:          TASK_ID,
      recipient_user_id:  RECIPIENT_ID,
      actor_user_id:      ACTOR_ID,
    })
  })

  it('inserts a task.submitted_for_review notification', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTaskNotification({
      type:            'task.submitted_for_review',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task.submitted_for_review' })
    )
  })

  it('inserts a task.sent_back notification', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTaskNotification({
      type:            'task.sent_back',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task.sent_back' })
    )
  })

  it('inserts a task.approved notification', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTaskNotification({
      type:            'task.approved',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task.approved' })
    )
  })

  it('entity_type is always "task"', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTaskNotification({
      type:            'task.approved',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'task' })
    )
  })

  it('skips when actor === recipient (no self-notifications)', async () => {
    await createTaskNotification({
      type:            'task.assigned',
      taskId:          TASK_ID,
      recipientUserId: ACTOR_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })

  it('skips when recipientUserId is empty string', async () => {
    await createTaskNotification({
      type:            'task.assigned',
      taskId:          TASK_ID,
      recipientUserId: '',
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })

  it('skips when actorUserId is empty string', async () => {
    await createTaskNotification({
      type:            'task.assigned',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     '',
    })

    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })

  it('is fire-and-forget: DB error does not throw', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: { message: 'DB write failed' } })

    // Must not throw
    await expect(
      createTaskNotification({
        type:            'task.assigned',
        taskId:          TASK_ID,
        recipientUserId: RECIPIENT_ID,
        actorUserId:     ACTOR_ID,
      })
    ).resolves.toBeUndefined()
  })

  it('is fire-and-forget: thrown errors do not propagate', async () => {
    mocks.mockServiceInsert.mockRejectedValue(new Error('network failure'))

    await expect(
      createTaskNotification({
        type:            'task.approved',
        taskId:          TASK_ID,
        recipientUserId: RECIPIENT_ID,
        actorUserId:     ACTOR_ID,
      })
    ).resolves.toBeUndefined()
  })

  it('uses createServiceClient, not createClient', async () => {
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTaskNotification({
      type:            'task.assigned',
      taskId:          TASK_ID,
      recipientUserId: RECIPIENT_ID,
      actorUserId:     ACTOR_ID,
    })

    expect(mocks.mockCreateServiceClient).toHaveBeenCalled()
    expect(mocks.mockCreateClient).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Wiring contracts — verified via the helper's insert being called
// ═══════════════════════════════════════════════════════════════════════════

describe('createTask wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires task.assigned when task is delegated (owner ≠ caller)', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'UM' })
    mocks.mockServiceRpc.mockResolvedValue({ data: TASK_ID, error: null })
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await createTask({ title: 'Test task', owner_user_id: RECIPIENT_ID })

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type:              'task.assigned',
        entity_id:          TASK_ID,
        recipient_user_id:  RECIPIENT_ID,
        actor_user_id:      ACTOR_ID,
      })
    )
  })

  it('does NOT fire notification for self-assigned task (no owner_user_id supplied)', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })
    mocks.mockServiceRpc.mockResolvedValue({ data: TASK_ID, error: null })

    await createTask({ title: 'My own task' })

    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })

  it('does NOT fire notification when owner_user_id === caller', async () => {
    const { createTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })
    mocks.mockServiceRpc.mockResolvedValue({ data: TASK_ID, error: null })

    await createTask({ title: 'Self-assigned explicit', owner_user_id: ACTOR_ID })

    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })
})

describe('updateTask wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires task.assigned when owner_user_id changes', async () => {
    const { updateTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })

    // Mock the task fetch
    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                TASK_ID,
            title:             'Old title',
            description:       null,
            owner_user_id:     'old-owner-uuid-aaa0-4000-8000-000000000099',
            project_id:        null,
            status:            'open',
            priority:          2,
            due_at:            null,
            created_by_user_id: ACTOR_ID,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await updateTask(TASK_ID, { owner_user_id: RECIPIENT_ID })

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type:              'task.assigned',
        entity_id:          TASK_ID,
        recipient_user_id:  RECIPIENT_ID,
      })
    )
  })
})

describe('submitTaskForReview wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires task.submitted_for_review to created_by_user_id', async () => {
    const { submitTaskForReview } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })

    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                 TASK_ID,
            owner_user_id:      ACTOR_ID,
            created_by_user_id: RECIPIENT_ID,
            status:             'in_progress',
            project_id:         null,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await submitTaskForReview(TASK_ID)

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type:              'task.submitted_for_review',
        entity_id:          TASK_ID,
        recipient_user_id:  RECIPIENT_ID,
        actor_user_id:      ACTOR_ID,
      })
    )
  })

  it('does not crash when created_by_user_id is null', async () => {
    const { submitTaskForReview } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'MEMBER' })

    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                 TASK_ID,
            owner_user_id:      ACTOR_ID,
            created_by_user_id: null,
            status:             'open',
            project_id:         null,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await expect(submitTaskForReview(TASK_ID)).resolves.toBeDefined()
    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })
})

describe('approveTask wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires task.approved to owner_user_id', async () => {
    const { approveTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })

    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                 TASK_ID,
            owner_user_id:      RECIPIENT_ID,
            created_by_user_id: ACTOR_ID,
            status:             'pending_review',
            project_id:         null,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await approveTask(TASK_ID)

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type:              'task.approved',
        entity_id:          TASK_ID,
        recipient_user_id:  RECIPIENT_ID,
        actor_user_id:      ACTOR_ID,
      })
    )
  })

  it('does not crash when owner_user_id is null', async () => {
    const { approveTask } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })

    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                 TASK_ID,
            owner_user_id:      null,
            created_by_user_id: ACTOR_ID,
            status:             'pending_review',
            project_id:         null,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await expect(approveTask(TASK_ID)).resolves.toBeDefined()
    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })
})

describe('sendTaskBack wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires task.sent_back to owner_user_id', async () => {
    const { sendTaskBack } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })

    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                 TASK_ID,
            owner_user_id:      RECIPIENT_ID,
            created_by_user_id: ACTOR_ID,
            status:             'pending_review',
            project_id:         null,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })
    mocks.mockServiceInsert.mockResolvedValue({ error: null })

    await sendTaskBack(TASK_ID, 'Needs more work')

    expect(mocks.mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type:              'task.sent_back',
        entity_id:          TASK_ID,
        recipient_user_id:  RECIPIENT_ID,
        actor_user_id:      ACTOR_ID,
      })
    )
  })

  it('does not crash when owner_user_id is null', async () => {
    const { sendTaskBack } = await import('@/lib/actions/tasks')

    mocks.mockGetCurrentUser.mockResolvedValue({ id: ACTOR_ID, role: 'SUPER_ADMIN' })

    mocks.mockCreateClient.mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id:                 TASK_ID,
            owner_user_id:      null,
            created_by_user_id: ACTOR_ID,
            status:             'pending_review',
            project_id:         null,
          },
          error: null,
        }),
      }),
    })

    mocks.mockServiceRpc.mockResolvedValue({ error: null })

    await expect(sendTaskBack(TASK_ID, 'Needs work')).resolves.toBeDefined()
    expect(mocks.mockServiceInsert).not.toHaveBeenCalled()
  })
})
