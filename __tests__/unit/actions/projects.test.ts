/**
 * Tests for lib/actions/projects.ts server actions.
 *
 * All consequential mutations (create, update, archive) go through
 * SECURITY DEFINER stored procedures via the service client's rpc().
 * Each test verifies:
 *   - the correct rpc name and arguments are used
 *   - a rpc failure propagates as an action error (atomicity guarantee)
 *   - permission checks fire BEFORE the rpc is ever called (security
 *     regression: a MEMBER/UM cannot bypass app-layer permissions by
 *     invoking the stored procedure directly, because EXECUTE is also
 *     revoked from non-service roles at the SQL level)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  // Supabase user-session client — only used for SELECT (permission fetch)
  const mockSelectSingle = vi.fn()

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table !== 'projects') throw new Error(`Unexpected table: ${table}`)
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: mockSelectSingle }),
      }),
    }
  })

  const mockClient = { from: mockFrom }

  // Service client — all mutations go through rpc()
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

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'insert failed' } })
    const { createProject } = await import('@/lib/actions/projects')
    const result = await createProject({ title: 'New Project' })
    expect(result.error).toBeTruthy()
  })

  it('returns the new project id on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-project-uuid', error: null })
    const { createProject } = await import('@/lib/actions/projects')
    const result = await createProject({ title: 'New Project', status: 'planned' })
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe('new-project-uuid')
  })

  it('calls create_project_and_audit via the service client with correct args', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'new-project-uuid', error: null })
    const { createProject } = await import('@/lib/actions/projects')
    await createProject({ title: 'New Project' })
    // Verifies rpc is on the service client (mockClient has no rpc method;
    // calling it there would throw TypeError, failing the test implicitly)
    expect(mocks.mockRpc).toHaveBeenCalledOnce()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'create_project_and_audit',
      expect.objectContaining({
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_created_by_user_id: SUPER_ADMIN_USER.id,
      })
    )
  })

  it('revalidates /projects and /today paths on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockRpc.mockResolvedValue({ data: 'uuid', error: null })
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
      data: { ...PROJECT, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
  })

  // Security regression: rpc must NOT be called when the app-layer permission
  // check fails.  Combined with REVOKE EXECUTE on the SQL function, this
  // closes the bypass path end-to-end.
  it('does not call rpc when permission check fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...PROJECT, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateProject } = await import('@/lib/actions/projects')
    await updateProject('project-uuid', { title: 'Hacked' })
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('returns empty success when there are no actual changes', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: PROJECT, error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: PROJECT.title })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Accountability regression: UM does not grant blanket edit authority.
  it('UM cannot edit a project owned by someone else', async () => {
    const UM_USER = { id: 'um-uuid', role: 'UM' as const, display_name: 'UM', email: 'um@kk.com', active: true }
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...PROJECT, owner_user_id: SUPER_ADMIN_USER.id },
      error: null,
    })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'Hacked' })
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can edit a project owned by someone else and calls the atomic _as_admin rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { ...PROJECT, owner_user_id: MEMBER_USER.id },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'New Title' })
    expect(result.error).toBeUndefined()
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_project_and_audit_as_admin',
      expect.objectContaining({ p_override_note: expect.any(String) })
    )
  })

  it('SUPER_ADMIN editing their own project calls the standard (non-override) rpc', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: PROJECT, error: null })  // PROJECT.owner = SUPER_ADMIN
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    await updateProject('project-uuid', { title: 'Own Project' })
    expect(mocks.mockRpc).toHaveBeenCalledWith('update_project_and_audit', expect.any(Object))
    expect(mocks.mockRpc).not.toHaveBeenCalledWith('update_project_and_audit_as_admin', expect.any(Object))
  })

  it('calls update_project_and_audit rpc with patch and before objects', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { updateProject } = await import('@/lib/actions/projects')
    await updateProject('project-uuid', { title: 'New Title', status: 'blocked' })
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'update_project_and_audit',
      expect.objectContaining({
        p_project_id: 'project-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_patch: { title: 'New Title', status: 'blocked' },
        p_before: { title: PROJECT.title, status: PROJECT.status },
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { updateProject } = await import('@/lib/actions/projects')
    const result = await updateProject('project-uuid', { title: 'New Title' })
    expect(result.error).toBeTruthy()
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

  // Security regression: see updateProject comment above.
  it('does not call rpc when permission check fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'active', title: 'Test' },
      error: null,
    })
    const { archiveProject } = await import('@/lib/actions/projects')
    await archiveProject('project-uuid')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  // Accountability regression.
  it('UM cannot archive a project owned by someone else', async () => {
    const UM_USER = { id: 'um-uuid', role: 'UM' as const, display_name: 'UM', email: 'um@kk.com', active: true }
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'active', title: 'Test' },
      error: null,
    })
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toContain('permission')
    expect(mocks.mockRpc).not.toHaveBeenCalled()
  })

  it('MEMBER can archive their own project', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: MEMBER_USER.id, status: 'active', title: 'Mine' },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toBeUndefined()
  })

  it('calls archive_project_and_audit rpc with before status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'active', title: 'Test' },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: null })
    const { archiveProject } = await import('@/lib/actions/projects')
    await archiveProject('project-uuid')
    expect(mocks.mockRpc).toHaveBeenCalledWith(
      'archive_project_and_audit',
      expect.objectContaining({
        p_project_id: 'project-uuid',
        p_actor_user_id: SUPER_ADMIN_USER.id,
        p_before_status: 'active',
      })
    )
  })

  it('returns error when rpc fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockSelectSingle.mockResolvedValue({
      data: { id: 'project-uuid', owner_user_id: SUPER_ADMIN_USER.id, status: 'active', title: 'Test' },
      error: null,
    })
    mocks.mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })
    const { archiveProject } = await import('@/lib/actions/projects')
    const result = await archiveProject('project-uuid')
    expect(result.error).toBeTruthy()
  })
})
