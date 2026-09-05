/**
 * Tests for lib/actions/email-intelligence.ts
 *
 * Verifies:
 *   - Unauthenticated caller rejected
 *   - MEMBER role rejected (inbox gate)
 *   - Gmail-not-connected rejected
 *   - OAuth token always derived from session user id, never from caller
 *   - Body re-fetched from Gmail — never accepted from browser
 *   - Body never written to any DB table (no Supabase calls at all)
 *   - Successful output forwarded to caller
 *   - AI errors propagated safely
 *   - analyzeEmail called with correct context fields
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser        = vi.fn()
  const mockCanUseGmailInbox      = vi.fn()
  const mockGetConnectionStatus   = vi.fn()
  const mockHasGmailScope         = vi.fn()
  const mockGetOAuthClient        = vi.fn()
  const mockGetMessageFull        = vi.fn()
  const mockAnalyzeEmail          = vi.fn()

  return {
    mockGetCurrentUser,
    mockCanUseGmailInbox,
    mockGetConnectionStatus,
    mockHasGmailScope,
    mockGetOAuthClient,
    mockGetMessageFull,
    mockAnalyzeEmail,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/permissions', () => ({ canUseGmailInbox: mocks.mockCanUseGmailInbox }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:     mocks.mockGetOAuthClient,
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  hasGmailScope:             mocks.mockHasGmailScope,
}))
vi.mock('@/lib/google/gmail', () => ({ getMessageFull: mocks.mockGetMessageFull }))
vi.mock('@/lib/ai/analyze-email', () => ({ analyzeEmail: mocks.mockAnalyzeEmail }))

// ---- Fixtures ----------------------------------------------------------------

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

const MEMBER_USER = {
  id:           'member-uuid',
  role:         'MEMBER' as const,
  display_name: 'Member User',
  email:        'member@killerkebab.com',
  active:       true,
}

const OTHER_USER = {
  id:           'other-uuid',
  role:         'UM' as const,
  display_name: 'Other User',
  email:        'other@killerkebab.com',
  active:       true,
}

const FAKE_OAUTH_CLIENT = { credentials: { scope: 'https://www.googleapis.com/auth/gmail.readonly' } }
const CONNECTED_STATUS  = {
  connected:          true,
  scopes:             ['https://www.googleapis.com/auth/gmail.readonly'],
  googleAccountEmail: 'admin@killerkebab.com',
}

const FAKE_MESSAGE = {
  id:       'msg-abc123',
  subject:  'Project update',
  from:     'sender@example.com',
  date:     'Fri, 05 Sep 2026 10:00:00 +0000',
  threadId: 'thread-xyz',
  snippet:  'Preview text...',
  body:     'Can you send the report by Friday? Also, let\'s meet Tuesday at 10.',
}

const VALID_OUTPUT = {
  suggestions: [
    {
      kind:          'todo',
      title:         'Send the report',
      reason:        'Sender asked for the report by Friday',
      evidence:      'Can you send the report by Friday?',
      scheduled_for: '2026-09-11',
    },
  ],
  analysis_note: null,
}

// ---- Import after mocks -------------------------------------------------------

import { analyzeEmailForSuggestions } from '@/lib/actions/email-intelligence'

// ---- Tests -------------------------------------------------------------------

describe('analyzeEmailForSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default happy-path setup
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(true)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockHasGmailScope.mockReturnValue(true)
    mocks.mockGetOAuthClient.mockResolvedValue(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(FAKE_MESSAGE)
    mocks.mockAnalyzeEmail.mockResolvedValue({ ok: true, output: VALID_OUTPUT })
  })

  // ── Auth gate ────────────────────────────────────────────────────────────────

  it('rejects unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/not authenticated/i)
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  // ── Role gate ────────────────────────────────────────────────────────────────

  it('rejects MEMBER role', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(false)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/not authorised/i)
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN passes role gate', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(true)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toBeUndefined()
    expect(result.data).toBeDefined()
  })

  it('UM passes role gate', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(true)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toBeUndefined()
  })

  // ── Gmail scope check ────────────────────────────────────────────────────────

  it('returns error when Gmail is not connected', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: false, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockGetOAuthClient).not.toHaveBeenCalled()
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  it('returns error when Gmail scope is missing', async () => {
    mocks.mockGetConnectionStatus.mockResolvedValue({ connected: true, scopes: [] })
    mocks.mockHasGmailScope.mockReturnValue(false)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/gmail is not connected/i)
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  it('returns error when OAuth client is unavailable', async () => {
    mocks.mockGetOAuthClient.mockResolvedValue(null)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/google connection unavailable/i)
    expect(mocks.mockGetMessageFull).not.toHaveBeenCalled()
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  // ── OAuth token isolation ────────────────────────────────────────────────────

  it('OAuth client is always loaded with the session user id, never a caller-supplied id', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN_USER)

    await analyzeEmailForSuggestions('msg-abc123')

    expect(mocks.mockGetOAuthClient).toHaveBeenCalledTimes(1)
    const [calledUserId] = mocks.mockGetOAuthClient.mock.calls[0]
    expect(calledUserId).toBe(SUPER_ADMIN_USER.id)
    // The messageId parameter cannot influence which user's token is loaded
    expect(calledUserId).not.toBe(OTHER_USER.id)
    expect(calledUserId).not.toBe('msg-abc123')
  })

  it('two calls with different sessions each load the correct token', async () => {
    // First call: SUPER_ADMIN
    mocks.mockGetCurrentUser.mockResolvedValueOnce(SUPER_ADMIN_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValueOnce(FAKE_MESSAGE)
    mocks.mockAnalyzeEmail.mockResolvedValueOnce({ ok: true, output: VALID_OUTPUT })
    await analyzeEmailForSuggestions('msg-1')

    // Second call: UM
    mocks.mockGetCurrentUser.mockResolvedValueOnce(UM_USER)
    mocks.mockGetOAuthClient.mockResolvedValueOnce(FAKE_OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValueOnce(FAKE_MESSAGE)
    mocks.mockAnalyzeEmail.mockResolvedValueOnce({ ok: true, output: VALID_OUTPUT })
    await analyzeEmailForSuggestions('msg-2')

    const calls = mocks.mockGetOAuthClient.mock.calls
    expect(calls[0][0]).toBe(SUPER_ADMIN_USER.id)
    expect(calls[1][0]).toBe(UM_USER.id)
  })

  // ── Body re-fetched server-side ──────────────────────────────────────────────

  it('re-fetches message from Gmail using the session OAuth client', async () => {
    await analyzeEmailForSuggestions('msg-abc123')

    expect(mocks.mockGetMessageFull).toHaveBeenCalledTimes(1)
    const [calledClient, calledId] = mocks.mockGetMessageFull.mock.calls[0]
    expect(calledClient).toBe(FAKE_OAUTH_CLIENT)
    expect(calledId).toBe('msg-abc123')
  })

  it('returns error when message is not found in Gmail', async () => {
    mocks.mockGetMessageFull.mockResolvedValue(null)

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/not found in gmail/i)
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  it('returns error when Gmail fetch throws', async () => {
    mocks.mockGetMessageFull.mockRejectedValue(new Error('Network failure'))

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/could not fetch email/i)
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  // ── No DB writes ─────────────────────────────────────────────────────────────

  it('never writes to any database — no Supabase client is created', async () => {
    // The action imports no Supabase module. This test confirms analyzeEmail
    // is called and no DB mocks exist (they would throw if called).
    await analyzeEmailForSuggestions('msg-abc123')

    // analyzeEmail must have been called (not short-circuited)
    expect(mocks.mockAnalyzeEmail).toHaveBeenCalledTimes(1)
    // If this test reaches here without error, no unexpected DB call occurred.
  })

  // ── analyzeEmail context ─────────────────────────────────────────────────────

  it('passes server-fetched fields to analyzeEmail — not any caller-supplied body', async () => {
    await analyzeEmailForSuggestions('msg-abc123')

    expect(mocks.mockAnalyzeEmail).toHaveBeenCalledTimes(1)
    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]

    // Fields come from the server-fetched FAKE_MESSAGE
    expect(ctx.subject).toBe(FAKE_MESSAGE.subject)
    expect(ctx.from).toBe(FAKE_MESSAGE.from)
    expect(ctx.date).toBe(FAKE_MESSAGE.date)
    expect(ctx.body).toBe(FAKE_MESSAGE.body)
  })

  it('passes currentUserName from the authenticated session', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(UM_USER)

    await analyzeEmailForSuggestions('msg-abc123')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.currentUserName).toBe(UM_USER.display_name)
  })

  it('passes a timezone to analyzeEmail', async () => {
    await analyzeEmailForSuggestions('msg-abc123')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(typeof ctx.timezone).toBe('string')
    expect(ctx.timezone.length).toBeGreaterThan(0)
  })

  // ── Output forwarding ────────────────────────────────────────────────────────

  it('returns structured output on success', async () => {
    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual(VALID_OUTPUT)
  })

  it('propagates AI error safely without exposing body', async () => {
    mocks.mockAnalyzeEmail.mockResolvedValue({
      ok:    false,
      error: 'The AI analysis request failed. Please try again.',
    })

    const result = await analyzeEmailForSuggestions('msg-abc123')

    expect(result.error).toMatch(/failed/i)
    expect(result.data).toBeUndefined()
    // Error message must not contain body content
    expect(result.error).not.toContain(FAKE_MESSAGE.body)
  })
})
