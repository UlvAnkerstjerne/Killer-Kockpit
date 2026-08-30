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
 * "next week") are resolved against it. Null falls back to now().
 *
 * Output is normalized to UTC midnight so the calendar date is unambiguous regardless
 * of what time-of-day chrono resolves internally.
 */

import * as chrono from 'chrono-node'

/**
 * Parse a deadline from an AI-extracted evidence snippet.
 *
 * @param evidence      Short transcript quote (e.g. "by Wednesday, September 2").
 * @param referenceDate Meeting scheduled_start — anchor for relative date resolution.
 * @returns ISO-8601 UTC midnight string, or null if no unambiguous future date is found.
 */
export function parseDeadlineFromEvidence(
  evidence: string | null,
  referenceDate: Date | null,
): string | null {
  if (!evidence?.trim()) return null

  const anchor = referenceDate ?? new Date()

  // Parse all date expressions using UTC (timezone: 0) so the calendar date is
  // consistent with how meeting timestamptz values are stored.
  const results = chrono.parse(evidence, { instant: anchor, timezone: 0 })

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

  // Normalize to UTC midnight — the date is what matters for deadlines
  const d = candidates[0].date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}
