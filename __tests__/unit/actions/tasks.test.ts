/**
 * Tests for lib/actions/tasks.ts server actions.
 *
 * Covers:
 *   createTask   — unauthenticated, DB error, success (audit recorded)
 *   updateTask   — unauthenticated, not found, permission denied, no-op, success
 *   completeTask — unauthenticated, not found, permission denied, success
 *   cancelTask   — unauthenticated, not found, permission denied, success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRecordAuditEvent = vi.fn().mockResolvedValue(undefined)
  const mockRevalidatePath = vi.fn()

  const mockInsertSingle = vi.fn()
  const mockSelectSingle = vi.fn()
  const mockUpdate = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'tasks') throw new Error(`Unexpected table: ${table}`)
    return {
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: mockInsertSingle }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
      }),
      update: vi.fn().mockReturnValue({
        eq: mockUpdate,
      }),
    }
  })

  const mockClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockRecordAuditEvent,
    mockRevalidatePath,
    mockInsertSingle,
    mockSelectSingle,
    mockUpdate,
    mockFrom,
    mockClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/audit', () => ({ recordAuditEvent: mocks.mockRecordAuditEvent }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockClient),
  createServiceClient: vi.fn().mockReturnValue({}),
}))

// ---- Fixtures ----------------------------------------------------------------

const SUPER_ADMIN_USER = {
  id: 'admin-uuid',
  role: 'SUPER_ADMIN' as const,
  display_name: 'Admin',
  email: 'admin@killerkebab.com',
  active: true,
}

const MEMBER_USER = {
  id: 'member-uuid',
  role: 'MEMBER' as const,
  display_name: 'Member',
  email: 'member@killerkebab.com',
  active: true,
}

const TASK = {
  id: 'task-uuid',
  title: 'Test Task',
  description: null,
  owner_user_id: SUPER_ADMIN_USER.id,
  project_id: null,
  status: 'open' as const,
  priority: 2,
  due_at: null,
  completed_at: null,
  archived_at: null,
}

// ---- createTask -------------------------------------------------------------

describe('createTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createTask } = await import('@/lib/actions/tasks')
    const result = await createTask({ title: 'New Task' })
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
  })

  it('returns error when database insert fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({
      data: null,
      error: { message: 'insert failed' },
    })
    const { createTask } = await import('@/lib/actions/tasks')
    const result = await createTask({ title: 'New Task' })
    expect(result.error).toBeTruthy()
  })

  it('returns the new task id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'new-task-uuid' }, error: null })
    const { createTask } = await import('@/lib/actions/tasks')
    const result = await createTask({ title: 'New Task' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-task-uuid')
  })

  it('records an audit event with task.created action', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'new-task-uuid' }, error: null })
    const { createTask } = await import('@/lib/actions/tasks')
    await createTask({ title: 'New Task', priority: 1 })
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledOnce()
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.created',
        entityType: 'task',
        entityId: 'new-task-uuid',
        actorUserId: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('defaults status to open and priority to 2 when not specified', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'uuid' }, error: null })
    const { createTask } = await import('@/lib/actions/tasks')
    await createTask({ title: 'New Task' })
    const insertCall = mocks.mockFrom.mock.results[0].value.insert.mock.calls[0][0]
    expect(insertCall.status).toBe('open')
    expect(insertCall.priority).toBe(2)
  })
})

// ---- updateTask -------------------------------------------------------------

describe('updateTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'Updated' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when task is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'Updated' })
    expect(result.error).toContain('not found')
  })

  it('returns error when MEMBER tries to edit a task they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...TASK, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: TASK.title })
    expect(result.error).toBeUndefined()
    expect(mocks.mockUpdate).not.toHaveBeenCalled()
  })

  it('records one audit event per changed field', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    await updateTask('task-uuid', { title: 'New Title', priority: 1 })
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledTimes(2)
  })
})

// ---- completeTask -----------------------------------------------------------

describe('completeTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when task is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to complete a task they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'task-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open', project_id: null },
      error: null,
    })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toContain('permission')
  })

  it('sets status to done and records task.completed audit event', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'task-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open', project_id: null },
      error: null,
    })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.completed',
        afterJson: expect.objectContaining({ status: 'done' }),
      })
    )
  })
})

// ---- cancelTask -------------------------------------------------------------

describe('cancelTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when task is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to cancel a task they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'task-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open', project_id: null },
      error: null,
    })
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toContain('permission')
  })

  it('sets status to cancelled and records task.cancelled audit event', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'task-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'open', project_id: null },
      error: null,
    })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.cancelled',
        afterJson: expect.objectContaining({ status: 'cancelled' }),
      })
    )
  })
})
