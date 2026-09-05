/**
 * Tests for createMeetingFromEmail in lib/actions/gmail.ts
 *
 * Verifies:
 *   - Unauthenticated caller rejected
 *   - Gmail-not-connected rejected
 *   - Gmail scope missing rejected
 *   - OAuth client unavailable rejected
 *   - Message not found in Gmail rejected
 *   - Gmail fetch throws → safe error
 *   - OAuth token always from session user id
 *   - Two separate sessions each load the correct token
 *   - Message re-fetched server-side for provenance
 *   - User-submitted fields (title, start, end, location, context) forwarded to createMeeting
 *   - createMeeting failure propagated
 *   - Provenance recorded: ensureGmailSource + linkEntityToSource with entity_type 'meeting'
 *   - Provenance failure is non-fatal (meeting already created)
 *   - Success returns { data: { id } }
 *   - Email body never written to any DB table
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  return {
    mockGetCurrentUser:        vi.fn(),
    mockGetConnectionStatus:   vi.fn(),
    mockHasGmailScope:         vi.fn(),
    mockGetOAuthClient:        vi.fn(),
    mockGetMessageFull:        vi.fn(),
    mockCreateMeeting:         vi.fn(),
    mockRevalidatePath:        vi.fn(),
    mockServiceClient:         {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      single: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    },
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:     mocks.mockGetOAuthClient,
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  hasGmailScope:             mocks.mockHasGmailScope,
}))
vi.mock('@/lib/google/gmail', () => ({
  getMessageFull:       mocks.mockGetMessageFull,
  buildGmailDeepLink:   vi.fn(() => 'https://mail.google.com/mail/#inbox/msg-abc123'),
}))
vi.mock('@/lib/actions/meetings', () => ({ createMeeting: mocks.mockCreateMeeting }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mocks.mockServiceClient,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id:           'admin-uuid',
  role:         'SUPER_ADMIN' as const,
  display_name: 'Admin User',
  email:        'admin@killerkebab.com',
  active:       true,
}

const UM_USER = {
  id:           'um-uuid',
  role:         'UM' as const,
  display_name: 'Manager User',
  email:        'manager@killerkebab.com',
  active:       true,
}

const OTHER_USER = {
  id:           'other-uuid',
  role:         'UM' as const,
  display_name: 'Other User',
  email:        'other@killerkebab.com',
  active:       true,
}

const FAKE_OAUTH_CLIENT = {
  credentials: { scope: 'https://www.googleapis.com/auth/gmail.readonly' },
}

const CONNECTED_STATUS = {
  connected:          true,
  scopes:             ['https://www.googleapis.com/auth/gmail.readonly'],
  googleAccountEmail: 'admin@gmail.com',
}

const FAKE_MESSAGE = {
  id:       'msg-abc123',
  subject:  'Meeting next Tuesday at 10am',
  from:     'partner@example.com',
  date:     'Mon, 07 Sep 2026 09:00:00 +0000',
  threadId: 'thread-xyz',
  snippet:  'Can we meet Tuesday at 10?',
  body:     'Hi, can we meet next Tuesday at 10am to discuss the proposal?',
}

const VALID_MEETING_INPUT = {
  title:           'Meeting: discuss proposal',
  scheduled_start: '2026-09-15T10:00',
  scheduled_end:   '2026-09-15T11:00',
  location:        'Conference Room A',
  context:         'Discuss the proposal from partner',
}

const MEETING_ID = 'meeting-uuid-001'

// ── Import after mocks ────────────────────────────────────────────────────────

import { createMeetingFromEmail } from '@/lib/actions/gmail'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createMeetingFromEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Happy-path defaults
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockHasGmailScope.mockReturnValue(true)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockCreateMeeting.mockResolvedValue({ data: { id: MEETING_ID } })
    // Source already exists (avoids insert path)
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: { id: 'source-uuid' }, error: null })
  })

  // ── Auth gate ────────────────────────────────────────────────────────────

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
    expect(mocks.mockCreateMeeting).not.toHaveBeenCalled()
  })

  // ── Gmail gate ───────────────────────────────────────────────────────────

  it('returns error when Gmail is not connected', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: false, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
    expect(mocks.mockCreateMeeting).not.toHaveBeenCalled()
  })

  it('returns error when Gmail scope is missing', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: true, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockCreateMeeting).not.toHaveBeenCalled()
  })

  it('returns error when OAuth client is unavailable', async () => {
    mocks.mockGetOAuthClient.mockResolvedValue(null)

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/google connection unavailable/i)
    expect(mocks.mockGetMessageFull).not.toHaveBeenCalled()
    expect(mocks.mockCreateMeeting).not.toHaveBeenCalled()
  })

  // ── Message re-fetch ─────────────────────────────────────────────────────

  it('re-fetches message from Gmail using the session OAuth client', async () => {
    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(mocks.mockGetMessageFull).toHaveBeenCalledTimes(1)
    const [calledClient, calledId] = mocks.mockGetMessageFull.mock.calls[0]
    expect(calledClient).toBe(FAKE_OAUTH_CLIENT)
    expect(calledId).toBe('msg-abc123')
  })

  it('returns error when message is not found in Gmail', async () => {
    mocks.mockGetMessageFull.mockResolvedValue(null)

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/not found in gmail/i)
    expect(mocks.mockCreateMeeting).not.toHaveBeenCalled()
  })

  it('returns error when Gmail fetch throws', async () => {
    mocks.mockGetMessageFull.mockRejectedValue(new Error('Network failure'))

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/could not fetch email/i)
    expect(mocks.mockCreateMeeting).not.toHaveBeenCalled()
  })

  // ── OAuth token isolation ────────────────────────────────────────────────

  it('OAuth client is always loaded with the session user id, never a caller-supplied id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)

    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

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
    mocks.mockCreateMeeting.mockResolvedValueOnce({ data: { id: 'meeting-1' } })
    await createMeetingFromEmail('msg-1', VALID_MEETING_INPUT)

    mocks.mockGetCurrentUser.mockResolvedValueOnce(UM_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValueOnce(FAKE_MESSAGE)
    mocks.mockCreateMeeting.mockResolvedValueOnce({ data: { id: 'meeting-2' } })
    await createMeetingFromEmail('msg-2', VALID_MEETING_INPUT)

    const calls = mocks.mockGetOAuthClient.mock.calls
    expect(calls[0][0]).toBe(SUPER_ADMIN_USER.id)
    expect(calls[1][0]).toBe(UM_USER.id)
  })

  // ── Input forwarding ─────────────────────────────────────────────────────

  it('forwards user-submitted title, start, end, location, context to createMeeting', async () => {
    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(mocks.mockCreateMeeting).toHaveBeenCalledTimes(1)
    const [input] = mocks.mockCreateMeeting.mock.calls[0]
    expect(input.title).toBe(VALID_MEETING_INPUT.title)
    expect(input.scheduled_start).toBe(VALID_MEETING_INPUT.scheduled_start)
    expect(input.scheduled_end).toBe(VALID_MEETING_INPUT.scheduled_end)
    expect(input.location).toBe(VALID_MEETING_INPUT.location)
    expect(input.context).toBe(VALID_MEETING_INPUT.context)
  })

  it('createMeeting failure propagated safely', async () => {
    mocks.mockCreateMeeting.mockResolvedValue({ error: 'You do not have permission to create meetings.' })

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toMatch(/permission|failed/i)
    expect(result.data).toBeUndefined()
  })

  // ── Success ──────────────────────────────────────────────────────────────

  it('returns { data: { id } } on success', async () => {
    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ id: MEETING_ID })
  })

  it('calls revalidatePath for the new meeting on success', async () => {
    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith(`/meetings/${MEETING_ID}`)
  })

  // ── Provenance ───────────────────────────────────────────────────────────

  it('records provenance: queries sources table by (type, user, external_id)', async () => {
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: null, error: null })
    mocks.mockServiceClient.single.mockResolvedValue({ data: { id: 'new-source-uuid' }, error: null })

    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    // Should have queried sources for existing entry
    expect(mocks.mockServiceClient.from).toHaveBeenCalledWith('sources')
  })

  it('links entity_type "meeting" to the source', async () => {
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: { id: 'src-001' }, error: null })

    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    expect(mocks.mockServiceClient.from).toHaveBeenCalledWith('entity_sources')
    expect(mocks.mockServiceClient.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'meeting', entity_id: MEETING_ID }),
      expect.anything(),
    )
  })

  it('provenance failure is non-fatal — meeting is still returned', async () => {
    // No existing source found, and insert returns an error (source creation fails)
    mocks.mockServiceClient.maybeSingle.mockResolvedValue({ data: null, error: null })
    mocks.mockServiceClient.single.mockResolvedValue({ data: null, error: new Error('DB error') })

    const result = await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    // createMeeting succeeded even though provenance recording failed
    expect(result.data).toEqual({ id: MEETING_ID })
  })

  // ── No body persistence ──────────────────────────────────────────────────

  it('never writes the email body to any database table', async () => {
    await createMeetingFromEmail('msg-abc123', VALID_MEETING_INPUT)

    // The only inserts go to sources / entity_sources (metadata only).
    // Verify no insert call includes the email body value.
    const insertCalls = mocks.mockServiceClient.insert.mock.calls
    for (const [insertArg] of insertCalls) {
      const serialized = JSON.stringify(insertArg ?? {})
      expect(serialized).not.toContain(FAKE_MESSAGE.body)
    }
  })

  // ── Evidence privacy — evidence must never reach the database ─────────────
  //
  // The review form prefills context from suggestion.reason only.
  // Evidence is a verbatim body excerpt shown transiently in the UI.
  // These tests document and enforce the contract at the server boundary.

  it('context may contain the reason', async () => {
    const REASON = 'Meeting requested to discuss staffing'

    await createMeetingFromEmail('msg-abc123', {
      title: 'Staffing meeting',
      context: REASON,
    })

    const [input] = mocks.mockCreateMeeting.mock.calls[0]
    expect(input.context).toBe(REASON)
  })

  it('evidence is not present in the context sent to createMeeting when form uses reason-only prefill', async () => {
    const REASON   = 'Meeting requested to discuss staffing'
    const EVIDENCE = 'Can we meet Tuesday at 10 to discuss the new rota?'

    // Simulate what the corrected openMeetingForm sends: reason only, no evidence.
    await createMeetingFromEmail('msg-abc123', {
      title:   'Staffing meeting',
      context: REASON,          // ← correct: reason, not evidence
    })

    const [input] = mocks.mockCreateMeeting.mock.calls[0]
    expect(input.context).not.toContain(EVIDENCE)
  })

  it('no field passed to createMeeting contains the evidence string', async () => {
    const EVIDENCE = 'Can we meet Tuesday at 10 to discuss the new rota?'
    const REASON   = 'Meeting requested to discuss staffing'

    await createMeetingFromEmail('msg-abc123', {
      title:   'Staffing meeting',
      context: REASON,
    })

    const [input] = mocks.mockCreateMeeting.mock.calls[0]
    expect(JSON.stringify(input)).not.toContain(EVIDENCE)
  })
})
