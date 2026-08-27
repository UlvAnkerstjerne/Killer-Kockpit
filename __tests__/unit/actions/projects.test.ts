/**
 * Tests for lib/actions/projects.ts server actions.
 *
 * Covers:
 *   createProject  — unauthenticated, DB error, success (audit recorded)
 *   updateProject  — unauthenticated, not found, permission denied, no-op, success
 *   archiveProject — unauthenticated, not found, permission denied, success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRecordAuditEvent = vi.fn().mockResolvedValue(undefined)
  const mockRevalidatePath = vi.fn()

  // Supabase chainable query builder helpers
  const mockInsertSingle = vi.fn()
  const mockSelectSingle = vi.fn()
  const mockUpdate = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'projects') throw new Error(`Unexpected table: ${table}`)
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

const PROJECT = {
  id: 'project-uuid',
  title: 'Test Project',
  description: null,
  owner_user_id: SUPER_ADMIN_USER.id,
  status: 'active' as const,
  start_date: null,
  due_date: null,
  progress: null,
  archived_at: null,
}

// ---- createProject -----------------------------------------------------------

describe('createProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { createProject } = await import('@/lib/actions/projects')
    const result = await createProject({ title: 'New Project' })
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
  })

  it('returns error when database insert fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({
      data: null,
      error: { message: 'insert failed' },
    })
    const { createProject } = await import('@/lib/actions/projects')
    const result = await createProject({ title: 'New Project' })
    expect(result.error).toBeTruthy()
  })

  it('returns the new project id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({
      data: { id: 'new-project-uuid' },
      error: null,
    })
    const { createProject } = await import('@/lib/actions/projects')
    const result = await createProject({ title: 'New Project', status: 'planned' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-project-uuid')
  })

  it('records an audit event on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({
      data: { id: 'new-project-uuid' },
      error: null,
    })
    const { createProject } = await import('@/lib/actions/projects')
    await createProject({ title: 'New Project' })
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledOnce()
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.created',
        entityType: 'project',
        entityId: 'new-project-uuid',
        actorUserId: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('revalidates /projects and /today paths on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'uuid' }, error: null })
    const { createProject } = await import('@/lib/actions/projects')
    await createProject({ title: 'New Project' })
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/projects')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/today')
  })
})

// ---- updateProject ----------------------------------------------------------

describe('updateProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'Updated' })
    expect(result.error).toBeTruthy()
  })

  it('returns error when project is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: null,
      error: { message: 'not found' },
    })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'Updated' })
    expect(result.error).toContain('not found')
  })

  it('returns error when MEMBER tries to edit a project they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...PROJECT, owner_user_id: SUPER_ADMIN_USER.id }, // owned by someone else
      error: null,
    })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: PROJECT, error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    // Title is the same as the existing value
    const result = await updateProject('project-uuid', { title: PROJECT.title })
    expect(result.error).toBeUndefined()
    expect(mocks.mockUpdate).not.toHaveBeenCalled()
    expect(mocks.mockRecordAuditEvent).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can edit a project owned by someone else', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...PROJECT, owner_user_id: MEMBER_USER.id },
      error: null,
    })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'New Title' })
    expect(result.error).toBeUndefined()
  })

  it('records one audit event per changed field', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    await updateProject('project-uuid', { title: 'New Title', status: 'blocked' })
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledTimes(2)
  })
})

// ---- archiveProject ---------------------------------------------------------

describe('archiveProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when user is not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when project is not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toBeTruthy()
  })

  it('returns error when MEMBER tries to archive a project they do not own', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'active', title: 'Test' },
      error: null,
    })
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toContain('permission')
  })

  it('MEMBER can archive their own project', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: MEMBER_USER.id, status: 'active', title: 'Mine' },
      error: null,
    })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toBeUndefined()
  })

  it('records an audit event on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'active', title: 'Test' },
      error: null,
    })
    mocks.mockUpdate.mockResolvedValue({ error: null })
    const { archiveProject } = await import('@/lib/actions/projects')
    await archiveProject('project-uuid')
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledOnce()
    expect(mocks.mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.archived',
        entityType: 'project',
      })
    )
  })
})
