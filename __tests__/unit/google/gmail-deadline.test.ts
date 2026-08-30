/**
 * Tests for lib/google/gmail-deadline.ts
 *
 * The reference timestamp is the email's internalDate (Google's receipt time),
 * converted to an ISO string by the route handler before being passed here.
 * All relative dates are resolved against that timestamp, not the test runner's
 * current time or the sender-controlled Date header.
 *
 * The route handler converts internalDate (epoch ms string) → ISO string:
 *   new Date(Number(message.internalDate)).toISOString()
 * and falls back to the RFC 2822 Date header if internalDate is absent.
 */

import { describe, it, expect } from 'vitest'
import { extractDeadline } from '@/lib/google/gmail-deadline'

// Simulates the ISO string produced by converting Gmail's internalDate.
// internalDate for Wed 2026-08-26 10:00:00 UTC = 1787738400000
// new Date(1787738400000).toISOString() === '2026-08-26T10:00:00.000Z'
const INTERNAL_DATE_MS = '1787738400000'
const REF_DATE = new Date(Number(INTERNAL_DATE_MS)).toISOString() // '2026-08-26T10:00:00.000Z'

describe('extractDeadline', () => {

  // ── Returns null when no deadline present ─────────────────────────────────

  it('returns null for empty body', () => {
    const result = extractDeadline('', REF_DATE)
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  it('returns null for body with no dates', () => {
    const result = extractDeadline('Hi, please review the attached document.', REF_DATE)
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  it('returns null for vague terms: ASAP', () => {
    const result = extractDeadline('Please send this ASAP.', REF_DATE)
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  it('returns null for vague terms: soon', () => {
    const result = extractDeadline('Could you get to this soon?', REF_DATE)
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  it('returns null for vague terms: when you can', () => {
    const result = extractDeadline('Reply when you can.', REF_DATE)
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  // ── Filters out past dates ─────────────────────────────────────────────────

  it('ignores dates that are in the past relative to the email', () => {
    // "last Monday" from 2026-08-26 Wed → would be 2026-08-17, which is past
    const result = extractDeadline('I sent this last Monday, just checking in.', REF_DATE)
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  // ── Resolves explicit future dates ────────────────────────────────────────

  it('detects "by Friday" and resolves relative to email date', () => {
    // REF_DATE is Wednesday 26 Aug 2026; "Friday" → 28 Aug 2026
    const result = extractDeadline('Please send this by Friday.', REF_DATE)
    expect(result.dueDate).not.toBeNull()
    expect(result.evidence).toMatch(/friday/i)
    // Should be 28 Aug 2026
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(28)
    expect(d.getUTCMonth()).toBe(7) // August = 7
  })

  it('detects "tomorrow" and resolves to the next day', () => {
    // REF_DATE is 2026-08-26; tomorrow → 2026-08-27
    const result = extractDeadline('Can you have it ready by tomorrow?', REF_DATE)
    expect(result.dueDate).not.toBeNull()
    expect(result.evidence).toMatch(/tomorrow/i)
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(27)
  })

  it('detects absolute date "3 September"', () => {
    const result = extractDeadline('I need this before 3 September.', REF_DATE)
    expect(result.dueDate).not.toBeNull()
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(3)
    expect(d.getUTCMonth()).toBe(8) // September = 8
  })

  it('detects "next week" relative to email date', () => {
    const result = extractDeadline('Could you get me a draft by next week?', REF_DATE)
    expect(result.dueDate).not.toBeNull()
    const d = new Date(result.dueDate!)
    // "next week" from 2026-08-26 should land after 26 Aug
    expect(d > new Date(REF_DATE)).toBe(true)
  })

  it('captures evidence text', () => {
    // Use an unambiguous future date so chrono resolves it correctly
    const result = extractDeadline('Please confirm by Friday afternoon.', REF_DATE)
    expect(result.evidence).not.toBeNull()
    expect(result.evidence!.length).toBeGreaterThan(0)
  })

  // ── Ambiguity: multiple future dates ─────────────────────────────────────

  it('returns null when multiple future dates are present (ambiguous)', () => {
    // Two unambiguous absolute future dates — do not guess which is the deadline
    const result = extractDeadline(
      'Could you send the first draft by September 10 and the final version by September 20?',
      REF_DATE,
    )
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  // ── Mixed past + future ───────────────────────────────────────────────────

  it('uses the single future date when a past date also appears', () => {
    // "last Monday" (past) + "by Friday" (future) → should return Friday
    const result = extractDeadline(
      'I sent the original request last Monday. Please respond by Friday.',
      REF_DATE,
    )
    expect(result.dueDate).not.toBeNull()
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(28) // Friday 28 Aug
  })

  // ── internalDate governs relative resolution ──────────────────────────────

  it('resolves "tomorrow" relative to internalDate, not the RFC 2822 Date header', () => {
    // If the route handler used the sender Date header (say, a day earlier) instead
    // of internalDate, "tomorrow" would resolve to a different date.
    // Here we simulate two different internalDate values for the same body.

    // Reference = Monday 24 Aug 2026 → tomorrow = Tuesday 25 Aug
    const mondayIso = new Date(Number('1787565600000')).toISOString() // Mon 24 Aug 2026 10:00 UTC
    const resultMon = extractDeadline('Please send this by tomorrow.', mondayIso)
    expect(resultMon.dueDate).not.toBeNull()
    expect(new Date(resultMon.dueDate!).getUTCDate()).toBe(25) // Tuesday

    // Reference = Thursday 27 Aug 2026 → tomorrow = Friday 28 Aug
    const thursdayIso = new Date(Number('1787824800000')).toISOString() // Thu 27 Aug 2026 10:00 UTC
    const resultThu = extractDeadline('Please send this by tomorrow.', thursdayIso)
    expect(resultThu.dueDate).not.toBeNull()
    expect(new Date(resultThu.dueDate!).getUTCDate()).toBe(28) // Friday

    // Resolution differs → confirms the reference timestamp drives the output
    expect(resultMon.dueDate).not.toBe(resultThu.dueDate)
  })

  it('accepts an ISO string reference (the form produced from internalDate)', () => {
    // The route converts: new Date(Number(internalDate)).toISOString()
    // Verify extractDeadline handles ISO format correctly
    const isoRef = '2026-08-26T10:00:00.000Z'
    const result = extractDeadline('Please reply by Friday.', isoRef)
    expect(result.dueDate).not.toBeNull()
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(28) // Friday 28 Aug relative to Wed 26 Aug
  })

  // ── Fallback / invalid reference ──────────────────────────────────────────

  it('does not throw when the reference string is invalid', () => {
    // Should not throw, even if reference date is garbage (falls back to new Date())
    expect(() => extractDeadline('Reply by Friday.', 'not-a-date')).not.toThrow()
  })

  it('does not throw for empty reference string', () => {
    expect(() => extractDeadline('', '')).not.toThrow()
  })

  // ── Keyword distance: clause-level detection, not character proximity ────

  it('detects deadline when context keyword is far from the date in the same sentence', () => {
    // "deadline" appears ~70 chars before "Wednesday, September 2" — well beyond
    // any fixed-window approach — but both are in the same sentence, so the
    // clause check must fire.  Sep 2 2026 IS a Wednesday (consistent).
    const body =
      'The deadline for submitting the first draft of the content calendar is on Wednesday, September 2.'
    const result = extractDeadline(body, REF_DATE)
    expect(result.dueDate).not.toBeNull()
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(2)
    expect(d.getUTCMonth()).toBe(8)   // September = 8
    expect(d.getUTCFullYear()).toBe(2026)
  })

  it('returns null for a contradictory weekday + calendar date', () => {
    // "Wednesday, September 3" — Sep 3 2026 is a Thursday, not a Wednesday.
    // The sender's intent is ambiguous; Kockpit must not silently guess.
    const result = extractDeadline(
      'Please have the final version ready by Wednesday, September 3.',
      REF_DATE,
    )
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  // ── Regression: contextual date not mistaken for deadline ─────────────────

  it('does not treat "content calendar for october" as a deadline', () => {
    // "october" appears in a scheduling context, not a deadline context
    const result = extractDeadline(
      'we need to make a new content calendar for october.',
      REF_DATE,
    )
    expect(result).toEqual({ dueDate: null, evidence: null })
  })

  it('detects deadline in email with contextual date reference', () => {
    // "october" is contextual (no deadline keyword nearby); "2nd of september" has "ready" within 35 chars
    const body = [
      'Hej Ulv',
      '',
      'we need to make a new content calendar for october. pls have the first',
      'draft ready for me on wednesday the 2nd of september. i want us to post to',
      'ig 3 times a week (two reels one carousel) plus three stories.',
    ].join('\n')
    const result = extractDeadline(body, REF_DATE)
    expect(result.dueDate).not.toBeNull()
    expect(result.evidence).toMatch(/2nd of september/i)
    const d = new Date(result.dueDate!)
    expect(d.getUTCDate()).toBe(2)
    expect(d.getUTCMonth()).toBe(8) // September = 8
    expect(d.getUTCFullYear()).toBe(2026)
  })
})
