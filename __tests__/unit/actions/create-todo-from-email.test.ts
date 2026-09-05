/**
 * Tests for createTodoFromEmail in lib/actions/gmail.ts
 *
 * Verifies:
 *   - Unauthenticated caller rejected
 *   - Gmail-not-connected rejected
 *   - Gmail scope missing rejected
 *   - OAuth client unavailable rejected
 *   - Message not found rejected
 *   - Gmail fetch throws → safe error
 *   - OAuth token always derived from session user id
 *   - Two sessions load the correct token each time
 *   - createTodo called with title, priority, notes from user-submitted input
 *   - updateTodo called with wallToUtc date when scheduledFor is provided
 *   - updateTodo NOT called when scheduledFor is null
 *   - createTodo failure propagated
 *   - Notes blank by convention does not cause errors
 *   - Evidence string not present in any field sent to createTodo
 *   - Provenance recorded with entity_type 'todo'
 *   - Provenance non-fatal (to-do returned even if source creation fails)
 *   - Body never written to any database table
 *   - Success returns { data: { id } }
 *   - revalidatePath called for /todos and /today
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  mockGetCurrentUser:      vi.fn(),
  mockGetConnectionStatus: vi.fn(),
  mockHasGmailScope:       vi.fn(),
  mockGetOAuthClient:      vi.fn(),
  mockGetMessageFull:      vi.fn(),
  mockCreateTodo:          vi.fn(),
  mockUpdateTodo:          vi.fn(),
  mockWallToUtc:           vi.fn((s: string) => s + 'Z'),   // deterministic stub
  mockRevalidatePath:      vi.fn(),
  mockServiceClient: {
    from:         vi.fn().mockReturnThis(),
    select:       vi.fn().mockReturnThis(),
    eq:           vi.fn().mockReturnThis(),
    maybeSingle:  vi.fn(),
    insert:       vi.fn().mockReturnThis(),
    single:       vi.fn(),
    upsert:       vi.fn().mockResolvedValue({ error: null }),
  },
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:     mocks.mockGetOAuthClient,
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  hasGmailScope:             mocks.mockHasGmailScope,
}))
vi.mock('@/lib/google/gmail', () => ({
  getMessageFull:     mocks.mockGetMessageFull,
  buildGmailDeepLink: vi.fn(() => 'https://mail.google.com/mail/#inbox/msg-abc123'),
}))
vi.mock('@/lib/actions/todos', () => ({
  createTodo: mocks.mockCreateTodo,
  updateTodo: mocks.mockUpdateTodo,
}))
vi.mock('@/lib/time', () => ({ wallToUtc: mocks.mockWallToUtc }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mocks.mockServiceClient,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'admin-uuid', role: 'SUPER_ADMIN' as const,
  display_name: 'Admin User', email: 'admin@kk.com', active: true,
}
const UM_USER = {
  id: 'um-uuid', role: 'UM' as const,
  display_name: 'Manager', email: 'manager@kk.com', active: true,
}
const OTHER_USER = {
  id: 'other-uuid', role: 'UM' as const,
  display_name: 'Other', email: 'other@kk.com', active: true,
}

const FAKE_OAUTH_CLIENT = { credentials: { scope: 'https://www.googleapis.com/auth/gmail.readonly' } }
const CONNECTED_STATUS  = {
  connected: true, scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  googleAccountEmail: 'admin@gmail.com',
}

const FAKE_MESSAGE = {
  id: 'msg-abc123', subject: 'Send the report by Friday',
  from: 'boss@example.com', date: 'Fri, 05 Sep 2026 09:00:00 +0000',
  threadId: 'thread-xyz', snippet: 'Please send the report',
  body: 'Can you send the report by Friday? Also need the slides.',
}

const TODO_ID = 'todo-uuid-001'

const VALID_TODO_INPUT = {
  title:        'Send the report',
  priority:     2 as const,
  notes:        null,
  scheduledFor: '2026-09-11',
}

// ── Import after mocks ────────────────────────────────────────────────────────

import { createTodoFromEmail } from '@/lib/actions/gmail'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createTodoFromEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockHasGmailScope.mockReturnValue(true)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateTodo.mockResolvedValue({ data: { id: TODO_ID } })
    mocks.mockUpdateTodo.mockResolvedValue({})
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: { id: 'src-001' }, error: null })
  })

  // ── Auth gate ────────────────────────────────────────────────────────────

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockCreateTodo).not.toHaveBeenCalled()
  })

  // ── Gmail gate ───────────────────────────────────────────────────────────

  it('returns error when Gmail is not connected', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: false, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockCreateTodo).not.toHaveBeenCalled()
  })

  it('returns error when Gmail scope is missing', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: true, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockCreateTodo).not.toHaveBeenCalled()
  })

  it('returns error when OAuth client is unavailable', async () => {
    mocks.mockGetOAuthClient.mockResolvedValue(null)

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/google connection unavailable/i)
    expect(mocks.mockGetMessageFull).not.toHaveBeenCalled()
    expect(mocks.mockCreateTodo).not.toHaveBeenCalled()
  })

  it('returns error when message is not found in Gmail', async () => {
    mocks.mockGetMessageFull.mockResolvedValue(null)

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/not found in gmail/i)
    expect(mocks.mockCreateTodo).not.toHaveBeenCalled()
  })

  it('returns error when Gmail fetch throws', async () => {
    mocks.mockGetMessageFull.mockRejectedValue(new Error('Network failure'))

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/could not fetch email/i)
    expect(mocks.mockCreateTodo).not.toHaveBeenCalled()
  })

  // ── OAuth token isolation ────────────────────────────────────────────────

  it('OAuth client is always loaded with the session user id, never a caller-supplied id', async () => {
    await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(mocks.mockGetOAuthClient).toHaveBeenCalledTimes(1)
    const [calledUserId] = mocks.mockGetOAuthClient.mock.calls[0]
    expect(calledUserId).toBe(SUPER_ADMIN_USER.id)
    expect(calledUserId).not.toBe(OTHER_USER.id)
    expect(calledUserId).not.toBe('msg-abc123')
  })

  it('two calls with different sessions each load the correct token', async () => {
    mocks.mockGetCurrentUser.mockResolvedValueOnce(SUPER_ADMIN_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValueOnce(FAKE_MESSAGE)
    mocks.mockCreateTodo.mockResolvedValueOnce({ data: { id: 'todo-1' } })
    await createTodoFromEmail('msg-1', VALID_TODO_INPUT)

    mocks.mockGetCurrentUser.mockResolvedValueOnce(UM_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValueOnce(FAKE_MESSAGE)
    mocks.mockCreateTodo.mockResolvedValueOnce({ data: { id: 'todo-2' } })
    await createTodoFromEmail('msg-2', VALID_TODO_INPUT)

    const calls = mocks.mockGetOAuthClient.mock.calls
    expect(calls[0][0]).toBe(SUPER_ADMIN_USER.id)
    expect(calls[1][0]).toBe(UM_USER.id)
  })

  // ── Input forwarding to createTodo ───────────────────────────────────────

  it('forwards title, priority, notes to createTodo', async () => {
    await createTodoFromEmail('msg-abc123', {
      title: 'Send the report', priority: 1, notes: 'Urgent', scheduledFor: null,
    })

    expect(mocks.mockCreateTodo).toHaveBeenCalledTimes(1)
    const [title, priority, notes] = mocks.mockCreateTodo.mock.calls[0]
    expect(title).toBe('Send the report')
    expect(priority).toBe(1)
    expect(notes).toBe('Urgent')
  })

  it('defaults priority to 2 when not supplied', async () => {
    await createTodoFromEmail('msg-abc123', { title: 'Do something' })

    const [, priority] = mocks.mockCreateTodo.mock.calls[0]
    expect(priority).toBe(2)
  })

  // ── Date handling ────────────────────────────────────────────────────────

  it('calls updateTodo with wallToUtc date when scheduledFor is provided', async () => {
    await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(mocks.mockUpdateTodo).toHaveBeenCalledTimes(1)
    const [id, patch] = mocks.mockUpdateTodo.mock.calls[0]
    expect(id).toBe(TODO_ID)
    // wallToUtc stub appends 'Z' — proves the date was passed through wallToUtc
    expect(patch.scheduled_for).toBe('2026-09-11T00:00Z')
    expect(mocks.mockWallToUtc).toHaveBeenCalledWith('2026-09-11T00:00')
  })

  it('does NOT call updateTodo when scheduledFor is null', async () => {
    await createTodoFromEmail('msg-abc123', { ...VALID_TODO_INPUT, scheduledFor: null })

    expect(mocks.mockUpdateTodo).not.toHaveBeenCalled()
  })

  it('does NOT call updateTodo when scheduledFor is undefined', async () => {
    await createTodoFromEmail('msg-abc123', { title: 'No date todo' })

    expect(mocks.mockUpdateTodo).not.toHaveBeenCalled()
  })

  // ── createTodo failure ───────────────────────────────────────────────────

  it('propagates createTodo failure safely', async () => {
    mocks.mockCreateTodo.mockResolvedValue({ error: 'Title is required.' })

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toMatch(/required|failed/i)
    expect(result.data).toBeUndefined()
    expect(mocks.mockUpdateTodo).not.toHaveBeenCalled()
  })

  // ── Evidence privacy ─────────────────────────────────────────────────────

  it('no field passed to createTodo contains the AI evidence string', async () => {
    const EVIDENCE = 'Can you send the report by Friday?'
    const REASON   = 'Sender asked for the report by Friday'

    // Form sends reason as notes (or nothing) — never the evidence
    await createTodoFromEmail('msg-abc123', {
      title: 'Send the report',
      notes: REASON,         // reason-based note, not evidence
      scheduledFor: null,
    })

    const args = mocks.mockCreateTodo.mock.calls[0]
    expect(JSON.stringify(args)).not.toContain(EVIDENCE)
  })

  it('blank notes do not cause createTodo to fail', async () => {
    await createTodoFromEmail('msg-abc123', { title: 'Do something', notes: null })

    expect(mocks.mockCreateTodo).toHaveBeenCalledTimes(1)
    const [, , notes] = mocks.mockCreateTodo.mock.calls[0]
    expect(notes).toBeNull()
  })

  // ── Provenance ───────────────────────────────────────────────────────────

  it('records provenance with entity_type "todo"', async () => {
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: { id: 'src-001' }, error: null })

    await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(mocks.mockServiceClient.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'todo', entity_id: TODO_ID }),
      expect.anything(),
    )
  })

  it('provenance failure is non-fatal — to-do is still returned', async () => {
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: null, error: null })
    mocks.mockServiceClient.single.mockResolvedValue({ data: null, error: new Error('DB error') })

    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.data).toEqual({ id: TODO_ID })
  })

  // ── Body not persisted ───────────────────────────────────────────────────

  it('never writes the email body to any database table', async () => {
    await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    const insertCalls = mocks.mockServiceClient.insert.mock.calls
    for (const [insertArg] of insertCalls) {
      expect(JSON.stringify(insertArg ?? {})).not.toContain(FAKE_MESSAGE.body)
    }
  })

  // ── Success ──────────────────────────────────────────────────────────────

  it('returns { data: { id } } on success', async () => {
    const result = await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ id: TODO_ID })
  })

  it('calls revalidatePath for /todos and /today on success', async () => {
    await createTodoFromEmail('msg-abc123', VALID_TODO_INPUT)

    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/todos')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/today')
  })
})
