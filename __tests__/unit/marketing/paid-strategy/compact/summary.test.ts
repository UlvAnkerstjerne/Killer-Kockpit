import { describe, expect, it } from 'vitest'
import { REAL_RECS } from '../../../../helpers/paid-strategy-real-recs'
import { compactSummary, splitSentences } from '@/lib/marketing/paid-strategy/summary'

const rec = (over: Partial<(typeof REAL_RECS)[number]> = {}) => ({ ...REAL_RECS[0], ...over })

describe('splitSentences', () => {
  it('splits on sentence boundaries, not on decimals, thousands separators, abbreviations in brackets or e.g.', () => {
    expect(splitSentences('Cost was 328.72 DKK at C2 (V1). Spend was 1,972 DKK. Done.')).toEqual(['Cost was 328.72 DKK at C2 (V1).', 'Spend was 1,972 DKK.', 'Done.'])
  })
})

describe('compactSummary: deterministic sentences taken from the stored text', () => {
  it('uses the first sentence of the action and the first sentence of the evidence, never cutting mid-word', () => {
    for (const r of REAL_RECS) {
      const { action, reason } = compactSummary(r)
      expect(action && r.exact_test_or_action.replace(/\s+/g, ' ')).toContain(action!.replace(/…$/, '').replace(/\.$/, ''))
      expect(reason).toBeTruthy()
      for (const s of [action!, reason!]) { expect(s.length).toBeLessThanOrEqual(232); expect(s).toMatch(/[.!?…]$/) }
    }
  })
  it('real production recommendations produce readable two-sentence summaries', () => {
    expect(compactSummary(REAL_RECS[0])).toEqual({
      action: 'Map the catering enquiry journey from form submission to confirmed booking.',
      reason: 'C2 (Killer Katering - Copenhagen Leads, V1) has spent 1,972 DKK over 21 days and recorded 6 leads, giving an observed cost per lead of 328.72 DKK.',
    })
    expect(compactSummary(REAL_RECS[2]).action).toBe('Create a new leads-objective campaign targeting the Malmö metro area, mirroring the S3 broad targeting logic.')
  })
  it('a long first sentence is shortened at a clause or word boundary, with an ellipsis', () => {
    const { action } = compactSummary(rec({ exact_test_or_action: `Create ${'a very careful and detailed '.repeat(12)}plan, then run it for two weeks. Second sentence.` }))
    expect(action!.endsWith('…')).toBe(true); expect(action!.length).toBeLessThanOrEqual(232); expect(action).not.toMatch(/\s…$/)
  })
  it('does not repeat the title: an action that restates it is skipped for the next sentence', () => {
    const title = 'Test a founder-led Reel angle'
    expect(compactSummary(rec({ title, exact_test_or_action: 'Test a founder-led Reel angle. Film one 20 second Reel with the founder explaining the catering offer, then run it for 14 days.' })).action).toMatch(/^Film one 20 second Reel/)
  })
  it('does not repeat itself in the reason either, and falls back to the interpretation when the evidence only repeats the action', () => {
    const r = compactSummary(rec({ exact_test_or_action: 'Map the catering enquiry journey from form submission to confirmed booking.', evidence: 'Map the catering enquiry journey from form submission to confirmed booking.', interpretation: 'One reading is that nothing downstream confirms the leads.' }))
    expect(r.reason).toBe('One reading is that nothing downstream confirms the leads.')
  })
  it('short fragments are joined to the next sentence; one-sentence texts work', () => {
    expect(compactSummary(rec({ exact_test_or_action: 'Do X. Then launch the new Malmö leads campaign for 21 days.' })).action).toBe('Do X. Then launch the new Malmö leads campaign for 21 days.')
    expect(compactSummary(rec({ evidence: 'Spend was 100 DKK across the whole account in the last window' })).reason).toBe('Spend was 100 DKK across the whole account in the last window.')
  })
  it('never mutates or shortens the stored recommendation', () => {
    const before = JSON.stringify(REAL_RECS); REAL_RECS.forEach(compactSummary); expect(JSON.stringify(REAL_RECS)).toBe(before)
  })
})
