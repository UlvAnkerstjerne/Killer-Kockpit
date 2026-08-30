/**
 * Tests for lib/ai/parse-deadline.ts
 *
 * parseDeadlineFromEvidence wraps chrono-node with the same safety guards used
 * in lib/google/gmail-deadline.ts (conflicting weekday/date → null, multiple
 * candidates → null, past dates → null, vague terms → null).
 *
 * Coverage:
 *   - null / empty / whitespace evidence → null
 *   - vague terms ("ASAP", "soon") → null (not parsed by chrono-node)
 *   - explicit ISO date in evidence string
 *   - month name + day (year inferred from reference)
 *   - abbreviated month names
 *   - month + day + explicit year
 *   - month + day that is before reference → rolls to next year
 *   - weekday relative to reference date
 *   - conflicting weekday + explicit date → null
 *   - multiple genuine deadline candidates → null
 *   - evidence with surrounding text still extracts the date
 */

import { describe, it, expect } from 'vitest'
import { parseDeadlineFromEvidence } from '@/lib/ai/parse-deadline'

// Reference: Saturday 2026-08-29 at 10:00 UTC (matches meeting fixture in other tests)
const REF = new Date('2026-08-29T10:00:00Z')

describe('parseDeadlineFromEvidence', () => {

  // ── Null / empty inputs ─────────────────────────────────────────────────────

  it('returns null for null evidence', () => {
    expect(parseDeadlineFromEvidence(null, REF)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseDeadlineFromEvidence('', REF)).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseDeadlineFromEvidence('   ', REF)).toBeNull()
  })

  // ── Vague terms (required regression cases) ────────────────────────────────
  // chrono-node does not parse these → 0 results → null

  it('returns null for "ASAP"', () => {
    expect(parseDeadlineFromEvidence('ASAP', REF)).toBeNull()
  })

  it('returns null for "soon"', () => {
    expect(parseDeadlineFromEvidence('soon', REF)).toBeNull()
  })

  it('returns null for "when you can"', () => {
    expect(parseDeadlineFromEvidence('when you can', REF)).toBeNull()
  })

  // ── Explicit ISO date ───────────────────────────────────────────────────────

  it('parses an ISO date literal in the evidence', () => {
    const result = parseDeadlineFromEvidence('deadline is 2026-09-15', REF)
    expect(result).toBe('2026-09-15T00:00:00.000Z')
  })

  // ── Month name + day (required regression case) ────────────────────────────

  it('parses "by Wednesday, September 2" from a meeting on 29 Aug 2026 → 2026-09-02', () => {
    // Sep 2 2026 IS a Wednesday: Aug 29 Sat, Aug 30 Sun, Aug 31 Mon, Sep 1 Tue, Sep 2 Wed
    const result = parseDeadlineFromEvidence('by Wednesday, September 2', REF)
    expect(result).toBe('2026-09-02T00:00:00.000Z')
  })

  it('parses abbreviated month "Sept 2nd"', () => {
    const result = parseDeadlineFromEvidence('Sept 2nd', REF)
    expect(result).toBe('2026-09-02T00:00:00.000Z')
  })

  it('parses "Sep 2" (3-letter abbreviation)', () => {
    const result = parseDeadlineFromEvidence('before Sep 2', REF)
    expect(result).toBe('2026-09-02T00:00:00.000Z')
  })

  it('parses month + day with explicit year', () => {
    const result = parseDeadlineFromEvidence('September 2, 2027', REF)
    expect(result).toBe('2027-09-02T00:00:00.000Z')
  })

  it('rolls to next year when month+day is before the reference date', () => {
    // January 15 is before Aug 29 2026 → chrono infers Jan 15 2027
    const result = parseDeadlineFromEvidence('January 15', REF)
    expect(result).toBe('2027-01-15T00:00:00.000Z')
  })

  // ── Weekday relative to reference ──────────────────────────────────────────

  it('parses "next Wednesday" as 2026-09-02 relative to reference 2026-08-29', () => {
    // Reference is Saturday 2026-08-29; "next Wednesday" unambiguously means Sep 2
    const result = parseDeadlineFromEvidence('by end of day next Wednesday', REF)
    expect(result).toBe('2026-09-02T00:00:00.000Z')
  })

  it('parses "next Friday" as 2026-09-04 relative to reference 2026-08-29', () => {
    // Reference is Saturday 2026-08-29; "next Friday" unambiguously means Sep 4
    const result = parseDeadlineFromEvidence('ship by next Friday', REF)
    expect(result).toBe('2026-09-04T00:00:00.000Z')
  })

  it('returns null for bare "Wednesday" when nearest occurrence is in the past', () => {
    // Reference is Saturday Aug 29; nearest Wednesday is Aug 26 (past) → filtered → null
    // Same as gmail-deadline.ts behaviour for a bare weekday with no forward context.
    // Use explicit date ("Wednesday, September 2") or "next Wednesday" for forward resolution.
    const result = parseDeadlineFromEvidence('by end of day Wednesday', REF)
    expect(result).toBeNull()
  })

  // ── Conflicting weekday + explicit date (required regression case) ──────────

  it('returns null when weekday and explicit date conflict', () => {
    // Sep 3 2026 is a Thursday, but "Wednesday" is specified → conflict → null
    const result = parseDeadlineFromEvidence('by Wednesday, September 3', REF)
    expect(result).toBeNull()
  })

  // ── Multiple genuine deadline candidates (required regression case) ─────────

  it('returns null when there are multiple plausible deadline candidates', () => {
    // Two unambiguous future dates — cannot determine which was intended
    const result = parseDeadlineFromEvidence('by September 2 or by September 15', REF)
    expect(result).toBeNull()
  })

  // ── Surrounding text ────────────────────────────────────────────────────────

  it('still extracts the date when surrounded by transcript text', () => {
    const result = parseDeadlineFromEvidence(
      '"we committed to having this done by October 1st at the latest"',
      REF,
    )
    expect(result).toBe('2026-10-01T00:00:00.000Z')
  })
})
