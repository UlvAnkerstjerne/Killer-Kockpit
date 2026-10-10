import { describe, expect, it, vi } from 'vitest'
import { buildPaidStrategySystemPrompt, KOCKPIT_RULES, PAID_STRATEGY_PROMPT_VERSION } from '@/lib/ai/paid-strategy'
import { FIELD_TARGET_CHARS } from '@/lib/marketing/paid-strategy/types'

vi.mock('server-only', () => ({}))
describe('the prompt asks for plain management language in the display fields only', () => {
  const rules = KOCKPIT_RULES
  const section = rules.slice(rules.indexOf('Plain-language display copy'), rules.indexOf('Calibration and honesty'))
  it('requires display_title and display_summary, written last, as a faithful restatement', () => {
    expect(rules).toContain('display_title and display_summary'); expect(section).toMatch(/written last|Write them last/); expect(section).toMatch(/faithful restatement/)
    for (const f of ['display_title', 'display_summary']) expect(rules).toContain(`${f} ${FIELD_TARGET_CHARS[f as 'display_title']}`)
  })
  it('sets the voice: a colleague talking to management, plain conversational English, and gives the register examples', () => {
    expect(section).toMatch(/smart colleague explaining an idea to management/); expect(section).toMatch(/Plain conversational English/)
    expect(section).toContain('Track which catering leads actually become customers'); expect(section).toContain("Let's fix that before we spend more")
  })
  it('lists the jargon to avoid and how to translate it', () => {
    for (const term of ['downstream outcome', 'conversion event', 'conversion signal', 'funnel', 'CPM', 'CPC', 'CTR', 'attribution', 'social-proof angle', 'redemption mechanic', 'projected headroom', 'incremental budget', 'C1, C2, C3']) expect(section, term).toContain(term)
    for (const t of ['"a way to see which leads become real bookings"', '"our catering campaign"', '"an offer we can track"', '"an ad showing a real catering job or customer"', '"extra spend"']) expect(section, t).toContain(t)
  })
  it('simplifies the words, never the thinking: no new claims, rigor stays in the detailed fields', () => {
    expect(section).toMatch(/Simplify the WORDS, never the THINKING/); expect(section).toMatch(/Do not change the meaning, add a claim/)
    expect(section).toMatch(/evidence, limitations, thresholds and metrics belong in the detailed fields/)
    expect(rules).toMatch(/Every field except those two keeps its rigorous, technical voice/)
  })
  it('asks for a one-breath summary of about 160 to 220 characters, never over 280', () => {
    expect(section).toMatch(/one breath/); expect(section).toMatch(/about 160 to 220 characters, never more than 280/); expect(section).toMatch(/Do not fill the space just because it exists/)
    expect(FIELD_TARGET_CHARS.display_summary).toBe(220)
  })
  it('tells the model not to invent business infrastructure, with the exact bad and good examples', () => {
    expect(section).toMatch(/must NOT invent or assume business infrastructure/); expect(section).toMatch(/Never add a system, tool, workflow, integration, process/)
    expect(section).toContain('BAD: "Let\'s connect our booking system to Meta"'); expect(section).toContain('GOOD: "Let\'s track which catering enquiries actually turn into confirmed bookings."')
    expect(section).toMatch(/Simplify the language, not the situation/)
  })
  it('keeps the model aiming at 280 at most: the larger schema maximum is a safety margin it is not told about', () => {
    expect(section).toMatch(/never more than 280/); expect(section).not.toContain('320')
  })
  it('requires extra spend to be said plainly when above zero, in non-technical words', () => {
    expect(section).toMatch(/when incremental_budget_dkk is above 0, display_summary must say so plainly/); expect(section).toContain('This needs about 1,500 DKK extra spend.')
    expect(section).toMatch(/Never write incremental budget, headroom or projected capacity/)
  })
  it('bumps the prompt version, keeps the system prompt ending with the Kockpit rules, and leaves the vendored skill text alone', () => {
    expect(PAID_STRATEGY_PROMPT_VERSION).toBe('2026-10-14-v11')
    const prompt = buildPaidStrategySystemPrompt({ name: 'm', version: '1', ref: 'mesper-meta-ads@2.1.0#x', hash: 'h', text: 'SKILL BODY' })
    expect(prompt).toContain('SKILL BODY'); expect(prompt.endsWith(rules)).toBe(true)
  })
})
