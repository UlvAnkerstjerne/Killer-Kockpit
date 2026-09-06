/**
 * Tests for lib/ai/thread-context.ts
 *
 * Coverage:
 *   detectDirection
 *     • SENT label → outgoing (authoritative)
 *     • From-address match against mailboxEmail → outgoing (fallback)
 *     • From-address with display name format "<email>" → outgoing
 *     • No SENT label, no match → incoming
 *     • null mailboxEmail → incoming unless SENT label
 *   boundThreadMessages
 *     • Takes latest MAX_THREAD_MESSAGES (10) when more exist
 *     • Older messages are the ones dropped when count exceeds limit
 *     • Per-message body truncated to MAX_BODY_CHARS (4 000 chars)
 *     • Total body budget (MAX_TOTAL_CHARS 20 000 chars) drops oldest
 *     • Newest message is always retained regardless of total budget
 *     • Output remains chronological (oldest first) after bounding
 *   toThreadContext
 *     • Maps to ThreadMessageContext with correct direction, from, date, body
 *     • Direction applied correctly across a mixed thread
 */

import { describe, it, expect } from 'vitest'
import {
  detectDirection,
  boundThreadMessages,
  toThreadContext,
  MAX_THREAD_MESSAGES,
  MAX_BODY_CHARS,
  MAX_TOTAL_CHARS,
} from '@/lib/ai/thread-context'
import type { GmailThreadMessage } from '@/lib/google/gmail'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMsg(
  override: Omit<Partial<GmailThreadMessage>, 'internalDate'> & { internalDate?: string | number } = {},
): GmailThreadMessage {
  const { internalDate, ...rest } = override
  return {
    messageId:    'msg-001',
    threadId:     'thread-001',
    from:         'sender@example.com',
    date:         'Mon, 01 Sep 2026 09:00:00 +0000',
    internalDate: String(internalDate ?? 1000),
    body:         'Hello world',
    labelIds:     [],
    ...rest,
  }
}

function makeMsgs(count: number, startEpoch = 1000): GmailThreadMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMsg({ messageId: `msg-${i}`, internalDate: startEpoch + i }),
  )
}

// ─── detectDirection ────────────────────────────────────────────────────────

describe('detectDirection', () => {
  it('SENT label → outgoing (authoritative)', () => {
    const msg = makeMsg({ labelIds: ['INBOX', 'SENT'] })
    expect(detectDirection(msg, null)).toBe('outgoing')
  })

  it('SENT label takes priority over mailbox mismatch', () => {
    const msg = makeMsg({ labelIds: ['SENT'], from: 'other@example.com' })
    expect(detectDirection(msg, 'user@gmail.com')).toBe('outgoing')
  })

  it('From exact match → outgoing when no SENT label', () => {
    const msg = makeMsg({ labelIds: [], from: 'user@gmail.com' })
    expect(detectDirection(msg, 'user@gmail.com')).toBe('outgoing')
  })

  it('From match is case-insensitive', () => {
    const msg = makeMsg({ labelIds: [], from: 'User@Gmail.Com' })
    expect(detectDirection(msg, 'user@gmail.com')).toBe('outgoing')
  })

  it('From with display name "Name <email>" — extracts email for comparison', () => {
    const msg = makeMsg({ labelIds: [], from: 'Ulv Kerstjerne <ulv@killerkebab.com>' })
    expect(detectDirection(msg, 'ulv@killerkebab.com')).toBe('outgoing')
  })

  it('From mismatch, no SENT → incoming', () => {
    const msg = makeMsg({ labelIds: [], from: 'kristel@westisland.dk' })
    expect(detectDirection(msg, 'ulv@killerkebab.com')).toBe('incoming')
  })

  it('null mailboxEmail, no SENT → incoming', () => {
    const msg = makeMsg({ labelIds: [], from: 'anyone@example.com' })
    expect(detectDirection(msg, null)).toBe('incoming')
  })

  it('null mailboxEmail + SENT label → outgoing', () => {
    const msg = makeMsg({ labelIds: ['SENT'] })
    expect(detectDirection(msg, null)).toBe('outgoing')
  })
})

// ─── boundThreadMessages ────────────────────────────────────────────────────

describe('boundThreadMessages', () => {
  it('returns all messages when count ≤ MAX_THREAD_MESSAGES', () => {
    const msgs = makeMsgs(5)
    const result = boundThreadMessages(msgs)
    expect(result).toHaveLength(5)
  })

  it('drops oldest when count exceeds MAX_THREAD_MESSAGES', () => {
    const msgs = makeMsgs(15, 1000)
    const result = boundThreadMessages(msgs)
    expect(result).toHaveLength(MAX_THREAD_MESSAGES)
    // Latest 10 should be the last 10 (internalDate 1005..1014)
    const ids = result.map((m) => m.messageId)
    expect(ids).not.toContain('msg-0')
    expect(ids).not.toContain('msg-4')
    expect(ids).toContain('msg-5')
    expect(ids).toContain('msg-14')
  })

  it('output is chronological (oldest first) after bounding', () => {
    const msgs = makeMsgs(12, 1000)
    const result = boundThreadMessages(msgs)
    const dates = result.map((m) => Number(m.internalDate))
    expect(dates).toEqual([...dates].sort((a, b) => a - b))
  })

  it('truncates individual body to MAX_BODY_CHARS', () => {
    const longBody = 'x'.repeat(MAX_BODY_CHARS + 500)
    const msgs = [makeMsg({ body: longBody })]
    const result = boundThreadMessages(msgs)
    expect(result[0].body).toHaveLength(MAX_BODY_CHARS)
  })

  it('always retains the newest message regardless of total budget', () => {
    // One huge message that exceeds total budget alone
    const hugeBody = 'x'.repeat(MAX_TOTAL_CHARS + 1000)
    const msgs = [makeMsg({ internalDate: 9999, body: hugeBody.slice(0, MAX_BODY_CHARS) })]
    const result = boundThreadMessages(msgs)
    // Newest (and only) message must be retained
    expect(result).toHaveLength(1)
    expect(result[0].internalDate).toBe('9999')
  })

  it('drops older messages to stay within MAX_TOTAL_CHARS budget', () => {
    // Each body = exactly MAX_BODY_CHARS (4 000) chars — no per-message truncation.
    // 6 messages × 4 000 = 24 000 > MAX_TOTAL_CHARS (20 000).
    // Budget newest-first: msg-5..msg-1 fit (5 × 4 000 = 20 000 ≤ 20 000).
    // msg-0 (oldest) causes 24 000 > 20 000 and is dropped.
    const body = 'x'.repeat(MAX_BODY_CHARS)
    const msgs = Array.from({ length: 6 }, (_, i) =>
      makeMsg({ messageId: `msg-${i}`, internalDate: i, body }),
    )
    const result = boundThreadMessages(msgs)
    const ids = result.map((m) => m.messageId)
    // Newest is always retained
    expect(ids).toContain('msg-5')
    // Oldest exceeds total budget and is dropped
    expect(ids).not.toContain('msg-0')
    // Others are retained
    expect(ids).toContain('msg-1')
    expect(ids).toContain('msg-4')
  })

  it('newest outgoing reply cannot be discarded to retain older history', () => {
    // If we have 11 messages and the newest is an outgoing reply,
    // it must be retained even though it falls outside the 10-message limit.
    // (The 10-message limit takes the *last* 10, so newest is always in the window.)
    const msgs = makeMsgs(11, 1000)
    msgs[10].labelIds = ['SENT']  // newest is outgoing
    const result = boundThreadMessages(msgs)
    // Last message (highest internalDate = 1010) is retained
    const retainedDates = result.map((m) => Number(m.internalDate))
    expect(Math.max(...retainedDates)).toBe(1010)
  })

  it('returns empty array for empty input', () => {
    expect(boundThreadMessages([])).toEqual([])
  })
})

// ─── toThreadContext ─────────────────────────────────────────────────────────

describe('toThreadContext', () => {
  it('maps to ThreadMessageContext with direction, from, date, body', () => {
    const msgs = [
      makeMsg({ from: 'kristel@west.dk', date: 'Mon, 01 Sep 2026 09:00:00 +0000', body: 'Hi', labelIds: [] }),
      makeMsg({ from: 'ulv@kk.com',      date: 'Mon, 01 Sep 2026 10:00:00 +0000', body: 'Hello', labelIds: ['SENT'] }),
    ]
    const result = toThreadContext(msgs, 'ulv@kk.com')
    expect(result).toEqual([
      { direction: 'incoming', from: 'kristel@west.dk', date: 'Mon, 01 Sep 2026 09:00:00 +0000', body: 'Hi' },
      { direction: 'outgoing', from: 'ulv@kk.com',      date: 'Mon, 01 Sep 2026 10:00:00 +0000', body: 'Hello' },
    ])
  })

  it('uses SENT label for direction regardless of mailboxEmail', () => {
    const msgs = [makeMsg({ labelIds: ['SENT'], from: 'anyone@example.com' })]
    const result = toThreadContext(msgs, null)
    expect(result[0].direction).toBe('outgoing')
  })

  it('returns empty array for empty input', () => {
    expect(toThreadContext([], 'user@kk.com')).toEqual([])
  })
})
