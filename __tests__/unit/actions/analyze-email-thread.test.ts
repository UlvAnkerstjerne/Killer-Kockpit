/**
 * Tests for analyzeEmailForSuggestions (lib/actions/email-intelligence.ts)
 *
 * Thread-aware M7E-D1B coverage:
 *
 * THREAD FETCH / SECURITY:
 *   - threads.get called via authenticated user OAuth client (not caller-supplied)
 *   - SENT label recognised as outgoing direction
 *   - From-address comparison is the fallback for direction
 *   - Thread messages sorted chronologically before context is built
 *   - Thread fetch failure does NOT silently fall back to single-message analysis
 *
 * CURRENT-STATE CONTEXT (scenarios 1–7):
 *   All tests verify that analyzeEmail receives a ctx.thread with the correct
 *   direction labels so the AI can apply current-state reasoning.
 *   The AI response itself is mocked; these tests verify context construction.
 *
 *   1. Incoming with no reply  → direction='incoming', thread has 1 message
 *   2. Incoming + outgoing confirmation → two messages, second is 'outgoing'
 *   3. Incoming meeting proposal + outgoing confirmation → two messages, correct directions
 *   4. Incoming "send X" + outgoing "sent" → send is 'outgoing'
 *   5. External promise + outgoing "thanks" → promise 'incoming', thanks 'outgoing'
 *   6. Earlier date + later correction + outgoing confirm → all in thread in order
 *   7. Two actions: one resolved by outgoing, one still unresolved
 *      → both messages in thread for AI to reason about
 *
 * PROMPT STRUCTURE:
 *   - When thread is present, ctx.thread passed to analyzeEmail is populated
 *   - When thread is present, the root ctx.body is still populated (compat)
 *     but the prompt uses thread mode (verified via buildUserMessage unit tests)
 *   - CURRENT-STATE REASONING rule present in SYSTEM_PROMPT
 *   - "UNTRUSTED SOURCE MATERIAL" instruction present in SYSTEM_PROMPT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  mockGetCurrentUser:      vi.fn(),
  mockCanUseGmailInbox:    vi.fn(),
  mockGetConnectionStatus: vi.fn(),
  mockHasGmailScope:       vi.fn(),
  mockGetOAuthClient:      vi.fn(),
  mockGetMessageFull:      vi.fn(),
  mockGetThreadMessages:   vi.fn(),
  mockAnalyzeEmail:        vi.fn(),
}))

vi.mock('@/lib/auth',        () => ({ getCurrentUser:      mocks.mockGetCurrentUser }))
vi.mock('@/lib/permissions', () => ({ canUseGmailInbox:    mocks.mockCanUseGmailInbox }))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:     mocks.mockGetOAuthClient,
  getGoogleConnectionStatus: mocks.mockGetConnectionStatus,
  hasGmailScope:             mocks.mockHasGmailScope,
}))
vi.mock('@/lib/google/gmail', () => ({
  getMessageFull:      mocks.mockGetMessageFull,
  getThreadMessages:   mocks.mockGetThreadMessages,
}))
vi.mock('@/lib/ai/analyze-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/analyze-email')>()
  return {
    ...actual,
    analyzeEmail: mocks.mockAnalyzeEmail,
  }
})

// ── Fixtures ───────────────────────────────────────────────────────────────

const AUTHED_USER = {
  id: 'user-uuid', role: 'MEMBER' as const,
  display_name: 'Ulv Kerstjerne', email: 'ulv@kk.com', active: true,
}

const OAUTH_CLIENT = { credentials: {} }

const CONNECTED_STATUS = {
  connected: true,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  googleAccountEmail: 'ulv@kk.com',
}

const SELECTED_MSG = {
  messageId:    'msg-sel',
  threadId:     'thread-abc',
  subject:      'Let me know',
  from:         'kristel@westisland.dk',
  date:         'Mon, 01 Sep 2026 09:00:00 +0000',
  internalDate: '1000',
  snippet:      'Can you confirm Monday?',
  body:         'Can you confirm Monday works for the photo session?',
  labelIds:     ['INBOX'],
}

const OK_ANALYSIS = {
  ok: true,
  output: { suggestions: [], analysis_note: null },
} as const

// Helper to build a thread message fixture
function threadMsg(
  override: {
    messageId?: string
    internalDate?: string | number
    from?: string
    labelIds?: string[]
    body?: string
    date?: string
  },
) {
  return {
    messageId:    override.messageId ?? 'msg-001',
    threadId:     'thread-abc',
    from:         override.from         ?? 'kristel@westisland.dk',
    date:         override.date         ?? 'Mon, 01 Sep 2026 09:00:00 +0000',
    internalDate: String(override.internalDate ?? 1000),
    body:         override.body         ?? 'Hello',
    labelIds:     override.labelIds     ?? [],
  }
}

// ── Import after mocks ─────────────────────────────────────────────────────

import { analyzeEmailForSuggestions } from '@/lib/actions/email-intelligence'

// ── Test suite ─────────────────────────────────────────────────────────────

describe('analyzeEmailForSuggestions — thread-aware', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(AUTHED_USER)
    mocks.mockCanUseGmailInbox.mockReturnValue(true)
    mocks.mockGetConnectionStatus.mockResolvedValue(CONNECTED_STATUS)
    mocks.mockHasGmailScope.mockReturnValue(true)
    mocks.mockGetOAuthClient.mockResolvedValue(OAUTH_CLIENT)
    mocks.mockGetMessageFull.mockResolvedValue(SELECTED_MSG)
    mocks.mockGetThreadMessages.mockResolvedValue([SELECTED_MSG])
    mocks.mockAnalyzeEmail.mockResolvedValue(OK_ANALYSIS)
  })

  // ── Thread fetch / security ──────────────────────────────────────────────

  it('calls getThreadMessages with the authenticated user\'s OAuth client', async () => {
    await analyzeEmailForSuggestions('msg-sel')
    expect(mocks.mockGetThreadMessages).toHaveBeenCalledWith(OAUTH_CLIENT, 'thread-abc')
  })

  it('uses the threadId from the server-fetched message, not from the caller', async () => {
    // Caller only supplies messageId — threadId is taken from server-fetched message
    const msgWithDifferentThread = { ...SELECTED_MSG, threadId: 'server-thread-xyz' }
    mocks.mockGetMessageFull.mockResolvedValue(msgWithDifferentThread)
    mocks.mockGetThreadMessages.mockResolvedValue([msgWithDifferentThread])

    await analyzeEmailForSuggestions('msg-sel')

    expect(mocks.mockGetThreadMessages).toHaveBeenCalledWith(OAUTH_CLIENT, 'server-thread-xyz')
    expect(mocks.mockGetThreadMessages).not.toHaveBeenCalledWith(expect.anything(), 'msg-sel')
  })

  it('SENT label is recognised as outgoing direction', async () => {
    const sentMsg = threadMsg({ messageId: 'msg-sent', labelIds: ['SENT'], from: 'ulv@kk.com', internalDate: 2000, body: 'Confirmed.' })
    const incomingMsg = threadMsg({ messageId: 'msg-in',  labelIds: ['INBOX'], from: 'kristel@westisland.dk', internalDate: 1000, body: 'Can you confirm?' })
    mocks.mockGetThreadMessages.mockResolvedValue([incomingMsg, sentMsg])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread).toHaveLength(2)
    expect(ctx.thread[1].direction).toBe('outgoing')  // newest = SENT label
    expect(ctx.thread[0].direction).toBe('incoming')
  })

  it('From-address comparison is the fallback for outgoing detection', async () => {
    // Message has no SENT label but from matches mailboxEmail
    const sentByUser = threadMsg({ labelIds: [], from: 'ulv@kk.com', internalDate: 2000, body: 'Sent.' })
    mocks.mockGetThreadMessages.mockResolvedValue([SELECTED_MSG, sentByUser])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread[1].direction).toBe('outgoing')
  })

  it('thread is sorted chronologically before being passed to analyzeEmail', async () => {
    const msg1 = threadMsg({ messageId: 'a', internalDate: 3000 })
    const msg2 = threadMsg({ messageId: 'b', internalDate: 1000 })
    const msg3 = threadMsg({ messageId: 'c', internalDate: 2000 })
    mocks.mockGetThreadMessages.mockResolvedValue([msg1, msg2, msg3])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    // thread-context.toThreadContext works on the output of boundThreadMessages
    // which already sorts; confirm ctx.thread order matches chronological order
    const bodies = ctx.thread.map((m: { body: string }) => m.body)
    // msg2 (1000) < msg3 (2000) < msg1 (3000)
    expect(bodies[0]).toBe(msg2.body)
    expect(bodies[1]).toBe(msg3.body)
    expect(bodies[2]).toBe(msg1.body)
  })

  it('thread fetch failure does NOT silently fall back to single-message analysis', async () => {
    mocks.mockGetThreadMessages.mockRejectedValue(new Error('Gmail API error'))

    const result = await analyzeEmailForSuggestions('msg-sel')

    expect(result.error).toMatch(/couldn't read the full email conversation/i)
    // analyzeEmail must NOT have been called — no stale single-message suggestions
    expect(mocks.mockAnalyzeEmail).not.toHaveBeenCalled()
  })

  it('thread fetch failure returns a user-safe message (no API internals)', async () => {
    mocks.mockGetThreadMessages.mockRejectedValue(new Error('Request failed with status 403'))

    const result = await analyzeEmailForSuggestions('msg-sel')

    // Must NOT expose 403 or "Request failed" to the user
    expect(result.error).not.toMatch(/403/)
    expect(result.error).not.toMatch(/request failed/i)
    // Must be a safe user-facing string
    expect(result.error).toBeTruthy()
  })

  // ── Current-state context: scenarios 1–7 ────────────────────────────────

  it('[scenario 1] incoming with no reply → thread has 1 incoming message', async () => {
    const incoming = threadMsg({ labelIds: ['INBOX'], from: 'kristel@westisland.dk', body: 'Can you confirm Monday?' })
    mocks.mockGetThreadMessages.mockResolvedValue([incoming])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread).toHaveLength(1)
    expect(ctx.thread[0].direction).toBe('incoming')
  })

  it('[scenario 2] incoming ask + outgoing confirmation → second message is outgoing', async () => {
    const incoming = threadMsg({ messageId: 'in-1', internalDate: 1000, labelIds: ['INBOX'], from: 'kristel@westisland.dk', body: 'Can you confirm Monday?' })
    const outgoing = threadMsg({ messageId: 'out-2', internalDate: 2000, labelIds: ['SENT'], from: 'ulv@kk.com', body: 'Monday works.' })
    mocks.mockGetThreadMessages.mockResolvedValue([incoming, outgoing])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread).toHaveLength(2)
    expect(ctx.thread[0].direction).toBe('incoming')
    expect(ctx.thread[1].direction).toBe('outgoing')
    expect(ctx.thread[1].body).toBe('Monday works.')
  })

  it('[scenario 3] meeting proposal + outgoing confirms → directions correct', async () => {
    const proposal = threadMsg({ messageId: 'in', internalDate: 1000, labelIds: ['INBOX'], from: 'kristel@westisland.dk', body: "Let's meet Tuesday at 10." })
    const confirm  = threadMsg({ messageId: 'out', internalDate: 2000, labelIds: ['SENT'], from: 'ulv@kk.com', body: 'Tuesday at 10 works for me.' })
    mocks.mockGetThreadMessages.mockResolvedValue([proposal, confirm])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread[0]).toMatchObject({ direction: 'incoming', body: "Let's meet Tuesday at 10." })
    expect(ctx.thread[1]).toMatchObject({ direction: 'outgoing', body: 'Tuesday at 10 works for me.' })
  })

  it('[scenario 4] incoming "send something" + outgoing "sent" → both in thread, outgoing is resolved', async () => {
    const ask  = threadMsg({ messageId: 'ask',  internalDate: 1000, labelIds: ['INBOX'], body: 'Please send the Q3 figures.' })
    const sent = threadMsg({ messageId: 'sent', internalDate: 2000, labelIds: ['SENT'], from: 'ulv@kk.com', body: 'Sent just now.' })
    mocks.mockGetThreadMessages.mockResolvedValue([ask, sent])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread[0].direction).toBe('incoming')
    expect(ctx.thread[1].direction).toBe('outgoing')
  })

  it('[scenario 5] external promise + outgoing "thanks" → external is incoming, thanks is outgoing', async () => {
    const promise = threadMsg({ messageId: 'ext', internalDate: 1000, labelIds: ['INBOX'], from: 'lawyer@firm.dk', body: "We'll send the contract by Friday." })
    const thanks  = threadMsg({ messageId: 'thx', internalDate: 2000, labelIds: ['SENT'], from: 'ulv@kk.com', body: 'Thanks, looking forward to it.' })
    mocks.mockGetThreadMessages.mockResolvedValue([promise, thanks])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread[0]).toMatchObject({ direction: 'incoming', body: "We'll send the contract by Friday." })
    expect(ctx.thread[1]).toMatchObject({ direction: 'outgoing', body: 'Thanks, looking forward to it.' })
  })

  it('[scenario 6] earlier date + correction + outgoing confirm → all three in chronological order', async () => {
    const first   = threadMsg({ messageId: 'm1', internalDate: 1000, labelIds: ['INBOX'], body: "Let's meet 7 Sept." })
    const correct = threadMsg({ messageId: 'm2', internalDate: 2000, labelIds: ['INBOX'], body: 'Sorry, I meant 14 Sept.' })
    const confirm = threadMsg({ messageId: 'm3', internalDate: 3000, labelIds: ['SENT'], from: 'ulv@kk.com', body: '14th works.' })
    mocks.mockGetThreadMessages.mockResolvedValue([first, correct, confirm])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread).toHaveLength(3)
    expect(ctx.thread[0].body).toBe("Let's meet 7 Sept.")
    expect(ctx.thread[1].body).toBe('Sorry, I meant 14 Sept.')
    expect(ctx.thread[2]).toMatchObject({ direction: 'outgoing', body: '14th works.' })
  })

  it('[scenario 7] two actions — one resolved by outgoing, one unresolved — all messages in thread', async () => {
    // Thread has: incoming (two requests), then outgoing (resolves only one)
    const incoming1 = threadMsg({ messageId: 'in1', internalDate: 1000, labelIds: ['INBOX'], body: 'Can you confirm Monday AND send the menu?' })
    const outgoing1 = threadMsg({ messageId: 'out1', internalDate: 2000, labelIds: ['SENT'], from: 'ulv@kk.com', body: "Monday works! I'll send the menu later." })
    // A follow-up incoming asking again about the menu (still unresolved)
    const incoming2 = threadMsg({ messageId: 'in2', internalDate: 3000, labelIds: ['INBOX'], body: 'Any news on the menu?' })
    mocks.mockGetThreadMessages.mockResolvedValue([incoming1, outgoing1, incoming2])

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread).toHaveLength(3)
    expect(ctx.thread[0].direction).toBe('incoming')
    expect(ctx.thread[1].direction).toBe('outgoing')
    expect(ctx.thread[2].direction).toBe('incoming')
    // Latest incoming is at index 2 — AI can see the menu is still unresolved
    expect(ctx.thread[2].body).toBe('Any news on the menu?')
  })

  // ── Prompt structure ─────────────────────────────────────────────────────

  it('when thread is present, ctx.thread is populated (not undefined)', async () => {
    const msgs = [SELECTED_MSG]
    mocks.mockGetThreadMessages.mockResolvedValue(msgs)

    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.thread).toBeDefined()
    expect(Array.isArray(ctx.thread)).toBe(true)
  })

  it('analyzeEmail is called with the correct user display name', async () => {
    await analyzeEmailForSuggestions('msg-sel')

    const [ctx] = mocks.mockAnalyzeEmail.mock.calls[0]
    expect(ctx.currentUserName).toBe('Ulv Kerstjerne')
  })
})

// ── SYSTEM_PROMPT content tests ──────────────────────────────────────────────

import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/ai/analyze-email'

describe('SYSTEM_PROMPT — current-state and security rules', () => {
  it('contains CURRENT-STATE REASONING section', () => {
    expect(SYSTEM_PROMPT).toContain('CURRENT-STATE REASONING')
  })

  it('instructs not to suggest already-completed actions', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not suggest actions that have already been completed/i)
  })

  it('outgoing message is evidence of something already done', () => {
    expect(SYSTEM_PROMPT).toMatch(/outgoing.*already done/i)
  })

  it('UNTRUSTED SOURCE MATERIAL instruction is present', () => {
    expect(SYSTEM_PROMPT).toContain('UNTRUSTED SOURCE MATERIAL')
  })

  it('email sender cannot override task or behaviour', () => {
    expect(SYSTEM_PROMPT).toMatch(/cannot.*override|cannot.*modify/i)
  })
})

describe('buildUserMessage — thread mode vs single-message mode', () => {
  const baseCtx = {
    subject:         'Test subject',
    from:            'sender@example.com',
    date:            'Mon, 01 Sep 2026 09:00:00 +0000',
    body:            'Single message body',
    currentUserName: 'Ulv',
    timezone:        'Europe/Copenhagen',
  }

  it('thread mode: message body appears in thread section, not separately as root body', () => {
    const ctx = {
      ...baseCtx,
      thread: [
        { direction: 'incoming' as const, from: 'kristel@west.dk', date: 'Mon, 01 Sep 2026 09:00:00 +0000', body: 'Thread message content' },
      ],
    }
    const msg = buildUserMessage(ctx)

    // Thread content present
    expect(msg).toContain('Thread message content')
    // Root body NOT present (the single-message body)
    expect(msg).not.toContain('Single message body')
    // Thread section label present
    expect(msg).toContain('Email thread')
  })

  it('thread mode: UNTRUSTED SOURCE MATERIAL instruction present', () => {
    const ctx = {
      ...baseCtx,
      thread: [
        { direction: 'incoming' as const, from: 'sender@ex.com', date: '', body: 'content' },
      ],
    }
    const msg = buildUserMessage(ctx)
    expect(msg).toContain('UNTRUSTED SOURCE MATERIAL')
  })

  it('thread mode: outgoing messages labelled as sent by user', () => {
    const ctx = {
      ...baseCtx,
      thread: [
        { direction: 'outgoing' as const, from: 'ulv@kk.com', date: 'Tue', body: 'My reply' },
      ],
    }
    const msg = buildUserMessage(ctx)
    expect(msg).toContain('OUTGOING')
    expect(msg).toContain('sent by you')
  })

  it('thread mode: incoming messages labelled with sender', () => {
    const ctx = {
      ...baseCtx,
      thread: [
        { direction: 'incoming' as const, from: 'kristel@west.dk', date: 'Mon', body: 'Their message' },
      ],
    }
    const msg = buildUserMessage(ctx)
    expect(msg).toContain('INCOMING')
    expect(msg).toContain('kristel@west.dk')
  })

  it('single-message mode (no thread): shows root body', () => {
    const msg = buildUserMessage(baseCtx)
    expect(msg).toContain('Single message body')
    expect(msg).toContain('UNTRUSTED SOURCE MATERIAL')
    expect(msg).not.toContain('Email thread')
  })

  it('empty thread array falls through to single-message mode', () => {
    const ctx = { ...baseCtx, thread: [] }
    const msg = buildUserMessage(ctx)
    expect(msg).toContain('Single message body')
    expect(msg).not.toContain('Email thread')
  })
})
