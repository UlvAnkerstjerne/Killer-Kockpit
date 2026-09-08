/**
 * lib/ai/parse-deadline.ts
 *
 * Deadline parser for AI draft evidence strings, built on the same chrono-node
 * foundation as lib/google/gmail-deadline.ts.
 *
 * Unlike gmail-deadline.ts, which scans full email bodies for deadline-context phrases,
 * this module receives a pre-extracted evidence snippet from the AI — the AI has already
 * identified the deadline phrase in the transcript. We therefore skip the email-body
 * context-keyword filter but apply the same safety guards that gmail-deadline uses:
 *
 *   • Conflicting weekday + calendar date → null
 *     (e.g. "Wednesday, September 3" when Sep 3 is a Thursday — same check as gmail-deadline)
 *   • Multiple plausible candidates → null
 *     (e.g. "by September 2 or by September 15" — ambiguous, not guessed)
 *   • Dates not strictly after the reference date → null
 *   • Vague terms ("ASAP", "soon") — not parsed by chrono-node → null automatically
 *
 * referenceDate is the meeting's scheduled_start. Relative expressions ("Wednesday",
 * "next week") are resolved using the meeting's Europe/Copenhagen calendar date —
 * not the UTC date. This matters for meetings that span UTC midnight (e.g. a meeting
 * at 00:30 CEST is Sep 8 in Copenhagen even though its UTC instant is still Sep 7).
 * Without the correct timezone, "tomorrow" could resolve one day early.
 *
 * Output is normalized to UTC midnight of the resolved Copenhagen calendar date.
 */

import * as chrono from 'chrono-node'
import { utcToWall } from '@/lib/time'

/**
 * Returns the Europe/Copenhagen UTC offset in minutes at the given UTC instant.
 * DST-aware: +120 in summer (CEST), +60 in winter (CET).
 */
function copenhagenOffsetMinutes(utcDate: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate)

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const localAsUtcMs = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  )
  return (localAsUtcMs - utcDate.getTime()) / 60_000
}

/**
 * Parse a deadline from an AI-extracted evidence snippet.
 *
 * @param evidence      Short transcript quote (e.g. "by Wednesday, September 2").
 * @param referenceDate Meeting scheduled_start — anchor for relative date resolution.
 * @returns ISO-8601 UTC midnight string for the resolved Copenhagen calendar date,
 *          or null if no unambiguous future date is found.
 */
export function parseDeadlineFromEvidence(
  evidence: string | null,
  referenceDate: Date | null,
): string | null {
  if (!evidence?.trim()) return null

  const anchor = referenceDate ?? new Date()

  // Use the Copenhagen timezone offset so relative expressions are resolved from
  // the meeting's Copenhagen calendar date. Without this, a meeting at 00:30 CEST
  // (= 22:30 UTC the previous day) would anchor "tomorrow" one day early.
  const tzOffset = copenhagenOffsetMinutes(anchor)
  const results = chrono.parse(evidence, { instant: anchor, timezone: tzOffset })

  if (results.length === 0) return null

  const candidates = results.filter((r) => {
    // Discard dates not strictly after the reference (past or same instant as meeting)
    if (r.date() <= anchor) return false

    // Reject when chrono parsed both a certain weekday AND a certain calendar day
    // but they disagree — same guard as gmail-deadline.ts to avoid silent guessing.
    // Example: "Wednesday, September 3" when Sep 3, 2026 is a Thursday → null.
    if (
      r.start.isCertain('weekday') &&
      r.start.isCertain('day') &&
      r.start.get('weekday') !== r.date().getDay()
    ) return false

    return true
  })

  // Exactly one unambiguous future date → return it; zero or multiple → null
  if (candidates.length !== 1) return null

  // Normalize to UTC midnight of the resolved Copenhagen calendar date.
  // Using utcToWall extracts the Copenhagen local date from the chrono result,
  // which avoids the UTC-vs-Copenhagen date mismatch: e.g. "Sep 9 midnight CEST"
  // is "Sep 8 22:00 UTC" — getUTCDate() would give 8, but the intended date is 9.
  const d = candidates[0].date()
  const wallStr = utcToWall(d.toISOString())   // "YYYY-MM-DDTHH:MM" in Copenhagen
  return wallStr.slice(0, 10) + 'T00:00:00.000Z'
}
