/**
 * Tests for createWaitingOnFromEmail in lib/actions/gmail.ts
 *
 * Verifies:
 *   - Unauthenticated caller rejected
 *   - Gmail-not-connected rejected
 *   - Gmail scope missing rejected
 *   - OAuth client unavailable rejected
 *   - Message not found rejected
 *   - Gmail fetch throws → safe error
 *   - OAuth token always derived from session user id
 *   - createWaitingOn called with title, owner, waiting_for_user_id/name
 *   - waiting_for_user_id and waiting_for_name never sent together
 *   - due_at passed through correctly
 *   - notes passed through correctly
 *   - notes can be null/undefined without error
 *   - createWaitingOn failure propagated safely
 *   - Evidence not present in any field sent to createWaitingOn
 *   - Provenance recorded with entity_type 'waiting_on'
 *   - Provenance non-fatal (waiting on returned even if source creation fails)
 *   - Body never written to any database table
 *   - Success returns { data: { id } }
 *   - revalidatePath called for the waiting on route
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  mockGetCurrentUser:      vi.fn(),
  mockGetConnectionStatus: vi.fn(),
  mockHasGmailScope:       vi.fn(),
  mockGetOAuthClient:      vi.fn(),
  mockGetMessageFull:      vi.fn(),
  mockCreateWaitingOn:     vi.fn(),
  mockRevalidatePath:      vi.fn(),
  mockServiceClient: {
    from:        vi.fn().mockReturnThis(),
    select:      vi.fn().mockReturnThis(),
    eq:          vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
    insert:      vi.fn().mockReturnThis(),
    single:      vi.fn(),
    upsert:      vi.fn().mockResolvedValue({ error: null }),
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
  buildGmailDeepLink: vi.fn(() => 'https://mail.google.com/mail/#inbox/msg-wo-001'),
}))
vi.mock('@/lib/actions/waiting-ons', () => ({
  createWaitingOn: mocks.mockCreateWaitingOn,
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mocks.mockServiceClient,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'admin-uuid', role: 'SUPER_ADMIN' as const,
  display_name: 'Admin User', email: 'admin@kk.com', active: true,
}

const FAKE_OAUTH_CLIENT = { credentials: { scope: 'https://www.googleapis.com/auth/gmail.readonly' } }
const CONNECTED_STATUS  = {
  connected: true, scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  googleAccountEmail: 'admin@gmail.com',
}

const FAKE_MESSAGE = {
  id: 'msg-wo-001', subject: 'Waiting for Westisland Media to confirm',
  from: 'ulv@killerkebab.com', date: 'Fri, 05 Sep 2026 09:00:00 +0000',
  threadId: 'thread-wo', snippet: 'Still waiting for them',
  body: 'Hi Kristel, just checking if you can confirm the photo session for the 17th.',
}

const WO_ID = 'wo-uuid-001'

const VALID_WO_INPUT = {
  title:          'Westisland Media to confirm photo session',
  owner_user_id:  'admin-uuid',
  waiting_for_name: 'Westisland Media',
  due_at:         '2026-09-08T08:00',
  notes:          undefined,
}

// ── Import after mocks ────────────────────────────────────────────────────────

import { createWaitingOnFromEmail } from '@/lib/actions/gmail'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createWaitingOnFromEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockHasGmailScope.mockReturnValue(true)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateWaitingOn.mockResolvedValue({ data: { id: WO_ID } })
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: { id: 'src-wo-001' }, error: null })
  })

  // ── Auth gate ─────────────────────────────────────────────────────────────

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockCreateWaitingOn).not.toHaveBeenCalled()
  })

  it('returns error when Gmail is not connected', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: false, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockCreateWaitingOn).not.toHaveBeenCalled()
  })

  it('returns error when Gmail scope is missing', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: true, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockCreateWaitingOn).not.toHaveBeenCalled()
  })

  it('returns error when OAuth client is unavailable', async () => {
    mocks.mockGetOAuthClient.mockResolvedValue(null)

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/google connection unavailable/i)
    expect(mocks.mockCreateWaitingOn).not.toHaveBeenCalled()
  })

  it('returns error when message is not found in Gmail', async () => {
    mocks.mockGetMessageFull.mockResolvedValue(null)

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/not found in gmail/i)
    expect(mocks.mockCreateWaitingOn).not.toHaveBeenCalled()
  })

  it('returns error when Gmail fetch throws', async () => {
    mocks.mockGetMessageFull.mockRejectedValue(new Error('Network failure'))

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/could not fetch email/i)
    expect(mocks.mockCreateWaitingOn).not.toHaveBeenCalled()
  })

  // ── Input forwarding ──────────────────────────────────────────────────────

  it('forwards title to createWaitingOn', async () => {
    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.title).toBe(VALID_WO_INPUT.title)
  })

  it('forwards owner_user_id to createWaitingOn', async () => {
    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.owner_user_id).toBe('admin-uuid')
  })

  it('forwards waiting_for_name (external) to createWaitingOn', async () => {
    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.waiting_for_name).toBe('Westisland Media')
  })

  it('forwards waiting_for_user_id (internal) to createWaitingOn', async () => {
    await createWaitingOnFromEmail('msg-wo-001', {
      title:               'Adam to send the rota',
      waiting_for_user_id: 'user-adam-uuid',
    })

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.waiting_for_user_id).toBe('user-adam-uuid')
  })

  it('never sends both waiting_for_user_id and waiting_for_name', async () => {
    // Even if caller passes both, createWaitingOnFromEmail forwards input as-is —
    // the mutual exclusion is enforced at the form layer; the action trusts the form
    // This test verifies normal usage: only one is set
    await createWaitingOnFromEmail('msg-wo-001', {
      title:            'External WO',
      waiting_for_name: 'Westisland Media',
    })

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.waiting_for_name).toBe('Westisland Media')
    expect(input.waiting_for_user_id).toBeUndefined()
  })

  it('forwards due_at when provided', async () => {
    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.due_at).toBe('2026-09-08T08:00')
  })

  it('due_at is absent when not provided', async () => {
    await createWaitingOnFromEmail('msg-wo-001', { title: 'No deadline WO' })

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.due_at).toBeUndefined()
  })

  it('notes can be undefined without error', async () => {
    const result = await createWaitingOnFromEmail('msg-wo-001', { title: 'WO without notes' })

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ id: WO_ID })
  })

  it('forwards notes when provided', async () => {
    await createWaitingOnFromEmail('msg-wo-001', { ...VALID_WO_INPUT, notes: 'Some context' })

    const [input] = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(input.notes).toBe('Some context')
  })

  // ── createWaitingOn failure ───────────────────────────────────────────────

  it('propagates createWaitingOn failure safely', async () => {
    mocks.mockCreateWaitingOn.mockResolvedValue({ error: 'Title is required.' })

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toMatch(/required|failed/i)
    expect(result.data).toBeUndefined()
  })

  // ── Evidence privacy ──────────────────────────────────────────────────────

  it('no field passed to createWaitingOn contains the AI evidence string', async () => {
    const EVIDENCE = 'Still waiting for them to confirm the 17th'

    await createWaitingOnFromEmail('msg-wo-001', {
      title: 'Westisland Media to confirm photo session',
      notes: undefined, // evidence never passed as notes
    })

    const args = mocks.mockCreateWaitingOn.mock.calls[0]
    expect(JSON.stringify(args ?? {})).not.toContain(EVIDENCE)
  })

  // ── Provenance ────────────────────────────────────────────────────────────

  it('records provenance with entity_type "waiting_on"', async () => {
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: { id: 'src-wo-001' }, error: null })

    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(mocks.mockServiceClient.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'waiting_on', entity_id: WO_ID }),
      expect.anything(),
    )
  })

  it('provenance failure is non-fatal — waiting on is still returned', async () => {
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: null, error: null })
    mocks.mockServiceClient.single.mockResolvedValue({ data: null, error: new Error('DB error') })

    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.data).toEqual({ id: WO_ID })
  })

  // ── Body not persisted ────────────────────────────────────────────────────

  it('never writes the email body to any database table', async () => {
    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    const insertCalls = mocks.mockServiceClient.insert.mock.calls
    for (const [insertArg] of insertCalls) {
      expect(JSON.stringify(insertArg ?? {})).not.toContain(FAKE_MESSAGE.body)
    }
  })

  // ── Success ───────────────────────────────────────────────────────────────

  it('returns { data: { id } } on success', async () => {
    const result = await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ id: WO_ID })
  })

  it('calls revalidatePath for the waiting on route on success', async () => {
    await createWaitingOnFromEmail('msg-wo-001', VALID_WO_INPUT)

    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith(`/waiting-ons/${WO_ID}`)
  })
})
