/**
 * lib/ai/thread-context.ts
 *
 * Pure helpers for building thread analysis context from raw Gmail thread messages.
 * All functions are deterministic and side-effect-free — suitable for unit testing.
 *
 * Privacy: all inputs are transient server-side values. Nothing is persisted here.
 */

import type { GmailThreadMessage } from '@/lib/google/gmail'
import type { ThreadMessageContext } from '@/lib/ai/analyze-email'

// ─── Thread bounding constants ──────────────────────────────────────────────

export const MAX_THREAD_MESSAGES = 10
export const MAX_BODY_CHARS      = 4_000
export const MAX_TOTAL_CHARS     = 20_000

// ─── Direction detection ────────────────────────────────────────────────────

/**
 * Determines whether a Gmail thread message was sent by the authenticated user.
 *
 * Priority:
 * 1. Gmail SENT label — authoritative; set by Gmail when the user sends.
 * 2. From-address match against the connected mailbox email (fallback for
 *    messages where labels may not include SENT, e.g. messages in sub-labels).
 * 3. Default: incoming.
 *
 * The mailboxEmail must come from server-side connection status — never from
 * caller-supplied input. SUPER_ADMIN has no mailbox impersonation capability.
 */
export function detectDirection(
  msg: Pick<GmailThreadMessage, 'labelIds' | 'from'>,
  mailboxEmail: string | null,
): 'incoming' | 'outgoing' {
  // 1. SENT label — authoritative
  if (msg.labelIds.includes('SENT')) return 'outgoing'

  // 2. From-address comparison against authenticated mailbox
  if (mailboxEmail) {
    const fromEmail =
      msg.from.match(/<([^>]+)>/)?.[1]?.toLowerCase() ??
      msg.from.toLowerCase().trim()
    if (fromEmail === mailboxEmail.toLowerCase()) return 'outgoing'
  }

  return 'incoming'
}

// ─── Thread bounding ────────────────────────────────────────────────────────

/**
 * Applies deterministic size limits to a chronologically-sorted thread.
 *
 * Steps:
 * 1. Takes the latest MAX_THREAD_MESSAGES messages (from the end of the array).
 * 2. Truncates each body to MAX_BODY_CHARS.
 * 3. Allocates total body budget (MAX_TOTAL_CHARS) newest-first:
 *    older messages are dropped before newer content is discarded.
 * 4. The most-recent message is always retained regardless of budget.
 *
 * Input must be sorted ascending by internalDate (oldest first).
 * Output preserves the same chronological order.
 *
 * Body content is never logged when truncation or dropping occurs.
 */
export function boundThreadMessages(
  messages: GmailThreadMessage[],
): GmailThreadMessage[] {
  // Take latest N (input is oldest-first, so take from the end)
  const recent = messages.slice(-MAX_THREAD_MESSAGES)

  // Per-message body cap
  const truncated = recent.map((m) => ({
    ...m,
    body: m.body.slice(0, MAX_BODY_CHARS),
  }))

  // Newest-first budget allocation
  let totalChars = 0
  const retained: typeof truncated = []

  for (let i = truncated.length - 1; i >= 0; i--) {
    const isNewest = retained.length === 0  // newest is processed first
    const msgChars = truncated[i].body.length

    if (!isNewest && totalChars + msgChars > MAX_TOTAL_CHARS) {
      // Older message exceeds remaining budget — drop it
      continue
    }

    totalChars += msgChars
    retained.unshift(truncated[i])
  }

  return retained
}

// ─── Context builder ────────────────────────────────────────────────────────

/**
 * Converts bounded Gmail thread messages into the transient ThreadMessageContext
 * array passed to the AI analyzer.
 *
 * @param messages      Bounded, chronologically-sorted thread messages.
 * @param mailboxEmail  Authenticated user's email address for direction detection.
 */
export function toThreadContext(
  messages: GmailThreadMessage[],
  mailboxEmail: string | null,
): ThreadMessageContext[] {
  return messages.map((msg) => ({
    direction: detectDirection(msg, mailboxEmail),
    from:      msg.from,
    date:      msg.date,
    body:      msg.body,
  }))
}
