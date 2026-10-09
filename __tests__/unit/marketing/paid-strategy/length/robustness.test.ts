import { describe, expect, it } from 'vitest'
import { rec } from '../../../../helpers/paid-strategy'
import { buildPaidStrategySystemPrompt, KOCKPIT_RULES, PAID_STRATEGY_PROMPT_VERSION, validatePaidStrategy } from '@/lib/ai/paid-strategy'
import { FIELD_MAX_CHARS, FIELD_TARGET_CHARS, PaidStrategyOutputSchema, PaidStrategyRecommendationSchema } from '@/lib/marketing/paid-strategy/types'

const sentence = 'The result is a directional signal only, given the small sample and the unknown close rate. '
/** Exactly n characters, ending in a non-space so no trimming changes the length. */
const text = (n: number) => sentence.repeat(Math.ceil(n / sentence.length)).slice(0, n).replace(/\s$/, '.')
const ok = (over: Record<string, unknown>) => PaidStrategyRecommendationSchema.safeParse(rec(1, over as never)).success

describe('production failure of v8: modest overshoots in the detailed fields must not discard a good strategy', () => {
  it('success_metric over 450 characters (attempt 1 of the failure) validates', () => {
    for (const n of [451, 520, 600]) { expect(ok({ success_metric: text(n) }), String(n)).toBe(true) }
  })
  it('evidence_limitations over 800 characters (attempt 2 of the failure) validates', () => {
    for (const n of [801, 900, 1000]) { expect(ok({ evidence_limitations: text(n) }), String(n)).toBe(true) }
  })
  it('a whole output with several fields over their old limits validates end to end', () => {
    const over = { success_metric: text(540), evidence_limitations: text(930), evidence: text(1000), interpretation: text(900), hypothesis: text(700), exact_test_or_action: text(1200), title: text(200) }
    expect(validatePaidStrategy({ recommendations: [rec(1, over as never), rec(2, { ...over, title: `${text(150)} two` } as never), rec(3, { ...over, title: `${text(150)} three` } as never)] }).length).toBe(3)
  })
  it('absurdly huge strings still fail, field by field', () => {
    for (const key of Object.keys(FIELD_MAX_CHARS) as (keyof typeof FIELD_MAX_CHARS)[]) {
      expect(ok({ [key]: text(FIELD_MAX_CHARS[key] + 1) }), key).toBe(false)
      expect(ok({ [key]: text(FIELD_MAX_CHARS[key] * 4) }), key).toBe(false)
    }
  })
})

describe('hard maximum is a safety ceiling, the target is what the model is told', () => {
  it('every target is unchanged', () => {
    expect(FIELD_TARGET_CHARS).toEqual({ title: 120, evidence: 600, interpretation: 500, hypothesis: 400, exact_test_or_action: 700, success_metric: 300, evidence_limitations: 500, display_title: 90, display_summary: 220 })
  })
  it('every detailed ceiling is about twice its target (generous but bounded)', () => {
    for (const k of ['title', 'evidence', 'interpretation', 'hypothesis', 'exact_test_or_action', 'success_metric', 'evidence_limitations'] as const) {
      expect(FIELD_MAX_CHARS[k], k).toBeGreaterThanOrEqual(FIELD_TARGET_CHARS[k] * 1.9); expect(FIELD_MAX_CHARS[k], k).toBeLessThanOrEqual(FIELD_TARGET_CHARS[k] * 2.1)
    }
    expect(FIELD_MAX_CHARS).toMatchObject({ title: 240, evidence: 1200, interpretation: 1000, hypothesis: 800, exact_test_or_action: 1400, success_metric: 600, evidence_limitations: 1000 })
  })
  it('the display copy is NOT loosened: display_summary stays capped at 320 and display_title at 130', () => {
    expect(FIELD_MAX_CHARS.display_summary).toBe(320); expect(FIELD_MAX_CHARS.display_title).toBe(130)
    expect(ok({ display_summary: text(320) })).toBe(true); expect(ok({ display_summary: text(321) })).toBe(false)
    expect(ok({ display_title: text(130) })).toBe(true); expect(ok({ display_title: text(131) })).toBe(false)
  })
  it('the prompt still tells the model the targets and never mentions the larger ceilings', () => {
    const prompt = buildPaidStrategySystemPrompt({ name: 'm', version: '1', ref: 'r', hash: 'h', text: 'SKILL' })
    for (const [field, chars] of Object.entries(FIELD_TARGET_CHARS)) expect(prompt, field).toContain(`${field} ${chars}`)
    for (const [field, chars] of Object.entries(FIELD_MAX_CHARS)) if (chars !== FIELD_TARGET_CHARS[field as keyof typeof FIELD_TARGET_CHARS] && ![220, 90].includes(chars)) expect(KOCKPIT_RULES, `${field} ${chars}`).not.toContain(`${field} ${chars}`)
    expect(KOCKPIT_RULES).not.toMatch(/\b(1400|1200|1000)\b/)
    expect(KOCKPIT_RULES).toMatch(/Stay inside these budgets/)
  })
  it('the prompt version moved to v9', () => { expect(PAID_STRATEGY_PROMPT_VERSION).toBe('2026-10-12-v9') })
  it('nothing is silently truncated: an over-ceiling string is rejected, not cut', () => {
    const r = PaidStrategyRecommendationSchema.safeParse(rec(1, { success_metric: text(2000) }))
    expect(r.success).toBe(false); expect(() => validatePaidStrategy({ recommendations: [rec(1, { success_metric: text(2000) })] })).toThrow()
  })
})

describe('three maximal recommendations still fit the database row bound', () => {
  it('serialised, three recommendations with every field at its ceiling stay under the 30,000-byte check', () => {
    const maximal = (n: number) => rec(n, Object.fromEntries(Object.entries(FIELD_MAX_CHARS).map(([k, v]) => [k, text(v)])) as never)
    const json = JSON.stringify({ recommendations: [maximal(1), maximal(2), maximal(3)] })
    expect(Buffer.byteLength(json)).toBeLessThan(30_000)
    expect(PaidStrategyOutputSchema.safeParse({ recommendations: [maximal(1), maximal(2), maximal(3)] }).success).toBe(true)
  })
})
