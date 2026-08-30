/**
 * lib/google/gmail-deadline.ts
 *
 * Server-side deadline extraction from email body text.
 *
 * Approach: deterministic NLP via chrono-node — no external API calls,
 * no email content leaves the server, no hallucination risk.
 *
 * Rules:
 * • Reference date = email's internalDate (Google's receipt timestamp), converted
 *   to ISO by the caller.  Relative dates are resolved against that.
 * • Only date expressions that appear near deadline-context keywords are considered
 *   (e.g. "by", "before", "ready", "due").  Incidental date references such as
 *   "content calendar for october" are excluded.
 * • Dates in the past relative to the email are ignored.
 * • Exactly one deadline-context future date → suggest it.  Zero or 2+ → null.
 * • Vague terms ("ASAP", "soon", "when you can") are not matched by
 *   chrono-node — they correctly return null.
 * • Timezone: Europe/Copenhagen, DST-aware.
 */

import * as chrono from 'chrono-node'

export type DeadlineResult = {
  /** ISO UTC datetime string, or null if no explicit deadline found. */
  dueDate: string | null
  /** The exact text snippet that was matched, for display to the user. */
  evidence: string | null
}

/**
 * Deadline-context keywords.
 * A date expression is only treated as a deadline candidate if its containing
 * sentence/clause includes one of these phrases.
 *
 * Design intent:
 * - "by Friday"                    → "by" triggers
 * - "before 3 September"           → "before" triggers
 * - "ready for me on Wed"          → "ready" triggers
 * - "have it ready by …"           → "ready" / "by" trigger
 * - "due on Friday"                → "due" triggers
 * - "deadline is Friday"           → "deadline" triggers
 * - "deliver by …"                 → "deliver" triggers
 * - "complete by …"                → "complete" triggers
 *
 * Intentionally excluded: "need", "send", "submit", "for", "in", "on", "at".
 * "need"/"send"/"submit" are too broad — "we need to make a content calendar
 * for october" would produce a false positive.  Those verbs only imply a
 * deadline when paired with "by"/"before"/etc., which are already in the list.
 */
const DEADLINE_CONTEXT_RE =
  /\b(by|before|due|deadline|ready|deliver(?:y)?|complete|finish|no later than|have it|get (this|it) to me)\b/i

/**
 * Returns the clause (sentence) of `body` that contains the span
 * [matchStart, matchEnd).
 *
 * Scans backwards for a sentence boundary (newline, or . ! ? followed by
 * whitespace) to find the clause start, and forwards for the clause end.
 * Falls back to the full body if no boundary is found.
 */
function getContainingClause(body: string, matchStart: number, matchEnd: number): string {
  // ── Clause start ──────────────────────────────────────────────────────────
  let start = 0
  for (let i = matchStart - 1; i >= 0; i--) {
    const ch   = body[i]
    const next = body[i + 1] ?? ''
    if (ch === '\n') { start = i + 1; break }
    if ((ch === '.' || ch === '!' || ch === '?') &&
        (next === '' || next === ' ' || next === '\t' || next === '\n')) {
      start = i + 1
      break
    }
  }

  // ── Clause end ────────────────────────────────────────────────────────────
  let end = body.length
  for (let i = matchEnd; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\n') { end = i; break }
    if (ch === '.' || ch === '!' || ch === '?') { end = i + 1; break }
  }

  return body.slice(start, end).trim()
}

/**
 * Returns true when the clause containing the date expression includes a
 * deadline-context keyword.  Operates at sentence/clause level rather than
 * a fixed character window, so long sentences ("The deadline for submitting
 * the first draft … is this coming Wednesday") are handled correctly
 * regardless of the distance between the keyword and the date.
 *
 * @param body       Full email body
 * @param matchIndex chrono-node result.index
 * @param matchText  chrono-node result.text
 */
function isDeadlineContext(body: string, matchIndex: number, matchText: string): boolean {
  const clause = getContainingClause(body, matchIndex, matchIndex + matchText.length)
  return DEADLINE_CONTEXT_RE.test(clause)
}

/**
 * Returns the Europe/Copenhagen UTC offset in minutes for the given date.
 * Uses Intl to handle CET (+60) vs CEST (+120) DST automatically.
 */
function getCopenhagenOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone:     'Europe/Copenhagen',
    timeZoneName: 'shortOffset',
  }).formatToParts(date)

  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  // Value is like "GMT+2" or "GMT+1"
  const match = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/)
  if (!match) return 60 // safe default: CET

  const sign    = match[1] === '+' ? 1 : -1
  const hours   = parseInt(match[2], 10)
  const minutes = parseInt(match[3] ?? '0', 10)
  return sign * (hours * 60 + minutes)
}

/**
 * Attempts to extract an explicit deadline from the plain-text email body.
 *
 * Returns `{ dueDate, evidence }` where dueDate is an ISO UTC string and
 * evidence is the matched text (e.g. "2nd of september").
 *
 * Returns `{ dueDate: null, evidence: null }` when:
 * - No date expression is found
 * - No date expression appears in a deadline-context (e.g. contextual month
 *   references like "content calendar for october" are excluded)
 * - All deadline-context dates are in the past relative to the email
 * - Multiple future deadline-context dates remain (still ambiguous)
 *
 * @param body         Safe plain-text email body (never raw HTML)
 * @param refDateStr   ISO string converted from Gmail internalDate by the caller;
 *                     falls back to the RFC 2822 Date header if internalDate absent
 */
export function extractDeadline(body: string, refDateStr: string): DeadlineResult {
  // Parse the email's received date as the resolution anchor
  let refDate: Date
  try {
    refDate = new Date(refDateStr)
    if (isNaN(refDate.getTime())) refDate = new Date()
  } catch {
    refDate = new Date()
  }

  const tzOffset = getCopenhagenOffsetMinutes(refDate)

  // chrono-node: parse all date expressions, resolved relative to email date.
  // timezone is passed via the ParsingReference object (second arg), not the option.
  const results = chrono.parse(body, { instant: refDate, timezone: tzOffset })

  if (results.length === 0) return { dueDate: null, evidence: null }

  // Keep only dates that:
  // 1. appear in a deadline-context (clause contains "by", "before", "ready", "due", etc.)
  // 2. are strictly after the email's received time
  // 3. do not have a weekday/calendar-date conflict (e.g. "Wednesday, September 3"
  //    when September 3 is a Thursday — the sender's intent is ambiguous)
  const candidates = results.filter((r) => {
    if (!isDeadlineContext(body, r.index, r.text)) return false
    if (r.date() <= refDate) return false
    // Reject when chrono parsed both a weekday and a calendar date as certain
    // but they disagree — silent guessing is worse than returning null.
    if (
      r.start.isCertain('weekday') &&
      r.start.isCertain('day') &&
      r.start.get('weekday') !== r.date().getDay()
    ) return false
    return true
  })

  // Exactly one unambiguous deadline-context future date → suggest it
  if (candidates.length !== 1) return { dueDate: null, evidence: null }

  const result = candidates[0]

  return {
    dueDate:  result.date().toISOString(),
    evidence: result.text.trim(),
  }
}
