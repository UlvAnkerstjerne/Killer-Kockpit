/**
 * Tests for lib/actions/tasks.ts server actions.
 *
 * Key accountability rules enforced here:
 *   - Only the task creator (created_by_user_id) may update commitment terms
 *     (title, due_at, assignee, etc.).
 *   - The assignee (owner_user_id) may complete or cancel, but cannot move
 *     their own deadline.
 *   - UM role alone does NOT grant edit authority over another user's task.
 *   - SUPER_ADMIN may override either side (update terms AND status).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  const mockSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'tasks') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
      }),
    }
  })

  const mockClient = { from: mockFrom }

  const mockRpc = vi.fn()
  const mockServiceClient = { rpc: mockRpc }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockSelectSingle,
    mockFrom,
    mockClient,
    mockRpc,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockClient),
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
  display_name: 'UM',
  email: 'um@killerkebab.com',
  active: true,
}

const MEMBER_USER = {
  id: 'member-uuid',
  role: 'MEMBER' as const,
  display_name: 'Member',
  email: 'member@killerkebab.com',
  active: true,
}

// Task created by SUPER_ADMIN, assigned to SUPER_ADMIN
const TASK = {
  id: 'task-uuid',
  title: 'Test Task',
  description: null,
  created_by_user_id: SUPER_ADMIN_USER.id,
  owner_user_id: SUPER_ADMIN_USER.id,
  project_id: null,
  status: 'open' as const,
  priority: 2,
  due_at: null,
  completed_at: null,
  archived_at: null,
}

// Task created by SUPER_ADMIN, assigned to MEMBER
const TASK_ASSIGNED_TO_MEMBER = {
  ...TASK,
  id: 'task-assigned-uuid',
  owner_user_id: MEMBER_USER.id,
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

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'insert failed' } })
    const { createTask } = await import('@/lib/actions/tasks')
    const result = await createTask({ title: 'New Task' })
    expect(result.error).toBeTruthy()
  })

  it('returns the new task id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-task-uuid', error: null })
    const { createTask } = await import('@/lib/actions/tasks')
    const result = await createTask({ title: 'New Task' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-task-uuid')
  })

  it('calls create_task_and_audit with created_by_user_id = actor', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-task-uuid', error: null })
    const { createTask } = await import('@/lib/actions/tasks')
    await createTask({ title: 'New Task', priority: 1 })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_task_and_audit',
      expect.objectContaining({
        p_actor_user_id:      SUPER_ADMIN_USER.id,
        p_created_by_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('defaults status to open and priority to 2 when not specified', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'uuid', error: null })
    const { createTask } = await import('@/lib/actions/tasks')
    await createTask({ title: 'New Task' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_task_and_audit',
      expect.objectContaining({ p_status: 'open', p_priority: 2 })
    )
  })
})

// ---- updateTask (commitment terms) ------------------------------------------

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

  it('creator (SUPER_ADMIN) can update their own task terms', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'New Title' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_task_and_audit',
      expect.objectContaining({ p_patch: { title: 'New Title' } })
    )
  })

  // Accountability regression: assignee cannot move their own deadline.
  it('MEMBER assignee cannot update commitment terms (deadline move)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: TASK_ASSIGNED_TO_MEMBER,  // created_by = SUPER_ADMIN, owner = MEMBER
      error: null,
    })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-assigned-uuid', { due_at: '2027-01-01T00:00:00Z' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Accountability regression: UM role does not grant edit authority over others' tasks.
  it('UM cannot edit a task created by someone else', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...TASK, created_by_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can edit any task terms (override) and calls the atomic _as_admin rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...TASK, created_by_user_id: MEMBER_USER.id },  // created by someone else
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'Override Title' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_task_and_audit_as_admin',
      expect.objectContaining({ p_override_note: expect.any(String) })
    )
  })

  it('SUPER_ADMIN editing their own task calls the standard (non-override) rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })  // TASK.created_by = SUPER_ADMIN
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    await updateTask('task-uuid', { title: 'Own Task' })
    expect(mocks.mockRpc).toHaveBeenCalledWith('update_task_and_audit', expect.any(Object))
    expect(mocks.mockRpc).not.toHaveBeenCalledWith('update_task_and_audit_as_admin', expect.any(Object))
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: TASK.title })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('calls update_task_and_audit rpc with patch and before objects', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateTask } = await import('@/lib/actions/tasks')
    await updateTask('task-uuid', { title: 'New Title', priority: 1 })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_task_and_audit',
      expect.objectContaining({
        p_task_id:       'task-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_patch:  { title: 'New Title', priority: 1 },
        p_before: { title: TASK.title, priority: TASK.priority },
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { updateTask } = await import('@/lib/actions/tasks')
    const result = await updateTask('task-uuid', { title: 'New Title' })
    expect(result.error).toBeTruthy()
  })
})

// ---- completeTask -----------------------------------------------------------

describe('completeTask', () => {
  const TASK_ROW = {
    id: 'task-uuid',
    created_by_user_id: SUPER_ADMIN_USER.id,
    owner_user_id: SUPER_ADMIN_USER.id,
    status: 'open',
    project_id: null,
  }

  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { completeTask } = await import('@/lib/actions/tasks')
    expect((await completeTask('task-uuid')).error).toBeTruthy()
  })

  it('returns error when task is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { completeTask } = await import('@/lib/actions/tasks')
    expect((await completeTask('task-uuid')).error).toBeTruthy()
  })

  it('creator can complete their own task', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK_ROW, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'complete_task_and_audit',
      expect.objectContaining({ p_task_id: 'task-uuid' })
    )
  })

  it('assignee (MEMBER) can complete a task assigned to them', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...TASK_ROW, owner_user_id: MEMBER_USER.id },  // assigned to MEMBER
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith('complete_task_and_audit', expect.any(Object))
  })

  // Assignee cannot move deadline (updateTask), but CAN complete their task.
  it('MEMBER who is neither creator nor assignee cannot complete', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...TASK_ROW, owner_user_id: SUPER_ADMIN_USER.id },  // assigned to someone else
      error: null,
    })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('UM who is neither creator nor assignee cannot complete', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: TASK_ROW,  // created_by = SUPER_ADMIN, owner = SUPER_ADMIN
      error: null,
    })
    const { completeTask } = await import('@/lib/actions/tasks')
    const result = await completeTask('task-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK_ROW, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { completeTask } = await import('@/lib/actions/tasks')
    expect((await completeTask('task-uuid')).error).toBeTruthy()
  })
})

// ---- cancelTask -------------------------------------------------------------

describe('cancelTask', () => {
  const TASK_ROW = {
    id: 'task-uuid',
    created_by_user_id: SUPER_ADMIN_USER.id,
    owner_user_id: SUPER_ADMIN_USER.id,
    status: 'open',
    project_id: null,
  }

  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { cancelTask } = await import('@/lib/actions/tasks')
    expect((await cancelTask('task-uuid')).error).toBeTruthy()
  })

  it('returns error when task is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { cancelTask } = await import('@/lib/actions/tasks')
    expect((await cancelTask('task-uuid')).error).toBeTruthy()
  })

  it('creator can cancel their task', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK_ROW, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'cancel_task_and_audit',
      expect.objectContaining({ p_task_id: 'task-uuid' })
    )
  })

  it('assignee can cancel a task assigned to them', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...TASK_ROW, owner_user_id: MEMBER_USER.id },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toBeUndefined()
  })

  it('UM who is neither creator nor assignee cannot cancel', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK_ROW, error: null })
    const { cancelTask } = await import('@/lib/actions/tasks')
    const result = await cancelTask('task-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: TASK_ROW, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { cancelTask } = await import('@/lib/actions/tasks')
    expect((await cancelTask('task-uuid')).error).toBeTruthy()
  })
})
