/**
 * Security tests for lib/actions/gmail.ts
 *
 * Verifies:
 *   - Token isolation: getGoogleOAuth2Client is always called with the
 *     authenticated user's id, never with a caller-supplied id
 *   - source_account_user_id in sources inserts equals the authenticated user's id
 *   - Email body is never written to the sources table
 *   - SUPER_ADMIN and UM can use fetchMoreInboxMessages
 *   - Unauthenticated users are rejected from all actions
 *   - Cross-user isolation: User A's session never loads User B's OAuth token
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser         = vi.fn()
  const mockGetOAuthClient         = vi.fn()
  const mockGetConnectionStatus    = vi.fn()
  const mockListInboxMessages      = vi.fn()
  const mockGetMessageFull         = vi.fn()
  const mockRevalidatePath         = vi.fn()
  const mockCreateTask             = vi.fn()
  const mockCreateWaitingOn        = vi.fn()

  // Sources insert chain: .from('sources').select(...).eq(...).maybeSingle()
  // and  .from('sources').insert(...).select('id').single()
  const mockMaybeSingle  = vi.fn()
  const mockInsertSingle = vi.fn()
  const mockInsertSelect = vi.fn().mockReturnValue({ single: mockInsertSingle })
  const mockSourcesInsert = vi.fn().mockReturnValue({ select: mockInsertSelect })

  // entity_sources upsert
  const mockEntityUpsert = vi.fn().mockResolvedValue({ error: null })

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'sources') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: mockMaybeSingle,
              }),
            }),
          }),
        }),
        insert: mockSourcesInsert,
      }
    }
    if (table === 'entity_sources') {
      return { upsert: mockEntityUpsert }
    }
    throw new Error(`Unexpected table: ${table}`)
  })

  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockGetOAuthClient,
    mockGetConnectionStatus,
    mockListInboxMessages,
    mockGetMessageFull,
    mockRevalidatePath,
    mockCreateTask,
    mockCreateWaitingOn,
    mockMaybeSingle,
    mockInsertSingle,
    mockSourcesInsert,
    mockEntityUpsert,
    mockFrom,
    mockServiceClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:      mocks.mockGetOAuthClient,
  getGoogleConnectionStatus:  mocks.mockGetConnectionStatus,
  hasGmailScope:              vi.fn().mockReturnValue(true),
}))
vi.mock('@/lib/google/gmail', () => ({
  listInboxMessages:   mocks.mockListInboxMessages,
  getMessageFull:      mocks.mockGetMessageFull,
  buildGmailDeepLink:  vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/#inbox/msg123'),
}))
vi.mock('@/lib/actions/tasks', () => ({ createTask: mocks.mockCreateTask }))
vi.mock('@/lib/actions/waiting-ons', () => ({ createWaitingOn: mocks.mockCreateWaitingOn }))

// ---- Fixtures ----------------------------------------------------------------

const SUPER_ADMIN_USER = {
  id:           'admin-uuid',
  role:         'SUPER_ADMIN' as const,
  display_name: 'Admin',
  email:        'admin@killerkebab.com',
  active:       true,
}

const UM_USER = {
  id:           'um-uuid',
  role:         'UM' as const,
  display_name: 'Manager',
  email:        'manager@killerkebab.com',
  active:       true,
}

const OTHER_USER = {
  id:           'other-uuid',
  role:         'UM' as const,
  display_name: 'Other Manager',
  email:        'other@killerkebab.com',
  active:       true,
}

const FAKE_OAUTH_CLIENT = { credentials: { scope: 'https://www.googleapis.com/auth/gmail.readonly' } }
const CONNECTED_STATUS  = { connected: true, scopes: ['https://www.googleapis.com/auth/gmail.readonly'], googleAccountEmail: 'admin@killerkebab.com' }

const FAKE_MESSAGE = {
  id:       'msg-abc123',
  subject:  'Test email',
  from:     'sender@example.com',
  date:     '2026-09-04T10:00:00Z',
  threadId: 'thread-xyz',
  snippet:  'Preview text',
  body:     '<p>Full email body — must never be persisted</p>',
}

// ---- Imports (after mocks) ---------------------------------------------------

import {
  fetchMoreInboxMessages,
  createTaskFromEmail,
  createWaitingOnFromEmail,
} from '@/lib/actions/gmail'

// ---- fetchMoreInboxMessages --------------------------------------------------

describe('fetchMoreInboxMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await fetchMoreInboxMessages('tok-123')

    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN can fetch inbox messages', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockListInboxMessages.mockResolvedValue({ messages: [], nextPageToken: null })

    const result = await fetchMoreInboxMessages('tok-page')

    expect(result.error).toBeUndefined()
    expect(mocks.mockGetOAuthClient).toHaveBeenCalledWith(SUPER_ADMIN_USER.id)
  })

  it('UM can fetch inbox messages', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockListInboxMessages.mockResolvedValue({ messages: [], nextPageToken: null })

    const result = await fetchMoreInboxMessages('tok-page')

    expect(result.error).toBeUndefined()
    expect(mocks.mockGetOAuthClient).toHaveBeenCalledWith(UM_USER.id)
  })

  it('token isolation: OAuth client is loaded with the session user id, not a caller-supplied id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockListInboxMessages.mockResolvedValue({ messages: [], nextPageToken: null })

    await fetchMoreInboxMessages('tok-page')

    // The only call to getGoogleOAuth2Client must use the session user id
    expect(mocks.mockGetOAuthClient).toHaveBeenCalledTimes(1)
    const [calledUserId] = mocks.mockGetOAuthClient.mock.calls[0]
    expect(calledUserId).toBe(SUPER_ADMIN_USER.id)
    expect(calledUserId).not.toBe(OTHER_USER.id)
  })

  it('returns Gmail-not-connected error when OAuth client is null', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockGetOAuthClient.mockResolvedValue(null)

    const result = await fetchMoreInboxMessages('tok-page')

    expect(result.error).toMatch(/not connected/i)
  })
})

// ---- createTaskFromEmail — security properties ───────────────────────────────

describe('createTaskFromEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createTaskFromEmail('msg-abc', { title: 'Test task' })

    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
  })

  it('token isolation: OAuth client always uses session user id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateTask.mockResolvedValue({ data: { id: 'task-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createTaskFromEmail('msg-abc123', { title: 'Task from email' })

    expect(mocks.mockGetOAuthClient).toHaveBeenCalledWith(SUPER_ADMIN_USER.id)
    const calledUserId = mocks.mockGetOAuthClient.mock.calls[0][0]
    expect(calledUserId).not.toBe(OTHER_USER.id)
  })

  it('source_account_user_id in sources insert equals the authenticated user id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue({ ...CONNECTED_STATUS, googleAccountEmail: 'manager@killerkebab.com' })
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateTask.mockResolvedValue({ data: { id: 'task-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createTaskFromEmail('msg-abc123', { title: 'Task from email' })

    const insertCall = mocks.mockSourcesInsert.mock.calls[0][0]
    expect(insertCall.source_account_user_id).toBe(UM_USER.id)
    expect(insertCall.source_account_user_id).not.toBe(OTHER_USER.id)
  })

  it('email body is never written to the sources insert', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateTask.mockResolvedValue({ data: { id: 'task-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createTaskFromEmail('msg-abc123', { title: 'Task' })

    const insertedRow = mocks.mockSourcesInsert.mock.calls[0][0]
    // Top-level body field must not exist
    expect(insertedRow).not.toHaveProperty('body')
    expect(insertedRow).not.toHaveProperty('content')
    // Metadata must not contain body
    const meta = insertedRow.metadata ?? {}
    expect(meta).not.toHaveProperty('body')
    expect(meta).not.toHaveProperty('content')
  })

  it('provenance: source_type is gmail_message and external_id matches the messageId', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateTask.mockResolvedValue({ data: { id: 'task-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createTaskFromEmail('msg-abc123', { title: 'Task' })

    const insertedRow = mocks.mockSourcesInsert.mock.calls[0][0]
    expect(insertedRow.source_type).toBe('gmail_message')
    expect(insertedRow.external_id).toBe('msg-abc123')
  })
})

// ---- createWaitingOnFromEmail — security properties ─────────────────────────

describe('createWaitingOnFromEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createWaitingOnFromEmail('msg-abc', { title: 'Test WO' })

    expect(result.error).toBe('Not authenticated')
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
  })

  it('token isolation: OAuth client always uses session user id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateWaitingOn.mockResolvedValue({ data: { id: 'wo-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createWaitingOnFromEmail('msg-abc123', { title: 'WO from email' })

    expect(mocks.mockGetOAuthClient).toHaveBeenCalledWith(UM_USER.id)
    const calledUserId = mocks.mockGetOAuthClient.mock.calls[0][0]
    expect(calledUserId).not.toBe(OTHER_USER.id)
  })

  it('source_account_user_id in sources insert equals the authenticated user id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateWaitingOn.mockResolvedValue({ data: { id: 'wo-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createWaitingOnFromEmail('msg-abc123', { title: 'WO' })

    const insertedRow = mocks.mockSourcesInsert.mock.calls[0][0]
    expect(insertedRow.source_account_user_id).toBe(UM_USER.id)
  })

  it('email body is never written to the sources insert', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateWaitingOn.mockResolvedValue({ data: { id: 'wo-uuid' } })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockInsertSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })

    await createWaitingOnFromEmail('msg-abc123', { title: 'WO' })

    const insertedRow = mocks.mockSourcesInsert.mock.calls[0][0]
    expect(insertedRow).not.toHaveProperty('body')
    expect(insertedRow).not.toHaveProperty('content')
    const meta = insertedRow.metadata ?? {}
    expect(meta).not.toHaveProperty('body')
    expect(meta).not.toHaveProperty('content')
  })
})

// ---- Cross-user isolation ----------------------------------------------------

describe('cross-user token isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('User A session never triggers an OAuth load for User B id', async () => {
    // User A is logged in
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockListInboxMessages.mockResolvedValue({ messages: [], nextPageToken: null })

    // pageToken value cannot influence which user's token is loaded
    await fetchMoreInboxMessages('tok-page')

    for (const call of mocks.mockGetOAuthClient.mock.calls) {
      expect(call[0]).toBe(SUPER_ADMIN_USER.id)
      expect(call[0]).not.toBe(OTHER_USER.id)
    }
  })

  it('two sequential calls with different sessions load the correct token each time', async () => {
    // First call: User A
    mocks.mockGetCurrentUser.mockResolvedValueOnce(SUPER_ADMIN_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockListInboxMessages.mockResolvedValueOnce({ messages: [], nextPageToken: null })
    await fetchMoreInboxMessages('tok-a')

    // Second call: User B
    mocks.mockGetCurrentUser.mockResolvedValueOnce(OTHER_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockListInboxMessages.mockResolvedValueOnce({ messages: [], nextPageToken: null })
    await fetchMoreInboxMessages('tok-b')

    const calls = mocks.mockGetOAuthClient.mock.calls
    expect(calls[0][0]).toBe(SUPER_ADMIN_USER.id)
    expect(calls[1][0]).toBe(OTHER_USER.id)
  })
})
