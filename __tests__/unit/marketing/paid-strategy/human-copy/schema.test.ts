import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { HUMAN_COPY, NEW_RECS, REAL_RECS } from '../../../../helpers/paid-strategy-real-recs'
import { rec } from '../../../../helpers/paid-strategy'
import { FIELD_MAX_CHARS, FIELD_TARGET_CHARS, PaidStrategyOutputSchema, PaidStrategyRecommendationSchema } from '@/lib/marketing/paid-strategy/types'
import { validatePaidStrategy } from '@/lib/ai/paid-strategy'

const without = (key: string) => { const r: Record<string, unknown> = { ...rec() }; delete r[key]; return r }

describe('display_title and display_summary on new output', () => {
  it('are required: a new recommendation without either is rejected', () => {
    expect(PaidStrategyRecommendationSchema.safeParse(without('display_title')).success).toBe(false)
    expect(PaidStrategyRecommendationSchema.safeParse(without('display_summary')).success).toBe(false)
    expect(PaidStrategyOutputSchema.safeParse({ recommendations: [rec(1)] }).success).toBe(true)
  })
  it('the display title has a length floor and ceiling (target about 90, hard maximum above it)', () => {
    expect(FIELD_TARGET_CHARS.display_title).toBe(90); expect(FIELD_MAX_CHARS.display_title).toBeGreaterThan(90)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { display_title: 'Too short' })).success).toBe(false)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { display_title: 'x'.repeat(FIELD_MAX_CHARS.display_title + 1) })).success).toBe(false)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { display_title: 'x'.repeat(FIELD_MAX_CHARS.display_title) })).success).toBe(true)
  })
  it('the display summary has a length floor and ceiling (target about 300, hard maximum above it)', () => {
    expect(FIELD_TARGET_CHARS.display_summary).toBe(300); expect(FIELD_MAX_CHARS.display_summary).toBeGreaterThan(300)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { display_summary: 'Too short to explain.' })).success).toBe(false)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { display_summary: 'x'.repeat(FIELD_MAX_CHARS.display_summary + 1) })).success).toBe(false)
  })
  it('the tone targets fit the budgets and the database size bound', () => {
    for (const c of HUMAN_COPY) { expect(c.display_title.length).toBeLessThanOrEqual(90); expect(c.display_summary.length).toBeLessThanOrEqual(300) }
    expect(Object.values(FIELD_MAX_CHARS).reduce((a, b) => a + b, 0) * 3).toBeLessThan(30_000)
  })
  it('the detailed recommendation fields are unchanged by the new fields', () => {
    NEW_RECS.forEach((r, i) => { for (const k of Object.keys(REAL_RECS[i]) as (keyof (typeof REAL_RECS)[number])[]) expect(r[k], k).toEqual(REAL_RECS[i][k]) })
    for (const k of ['title', 'evidence', 'interpretation', 'hypothesis', 'exact_test_or_action', 'success_metric', 'evidence_limitations', 'incremental_budget_dkk', 'recommendation_type']) expect(Object.keys(PaidStrategyRecommendationSchema.shape)).toContain(k)
  })
  it('stays advisory: still no id, payload or execution field', () => {
    for (const extra of ['campaign_id', 'payload', 'target_id']) expect(PaidStrategyRecommendationSchema.safeParse({ ...rec(), [extra]: '1' }).success, extra).toBe(false)
  })
})

describe('display copy must be plain language', () => {
  const run = (over: Record<string, unknown>) => () => validatePaidStrategy({ recommendations: [rec(1, over as never)] })
  it('accepts the plain register', () => {
    for (const c of HUMAN_COPY) expect(run(c)).not.toThrow()
  })
  it.each(['Add a conversion event for C2', 'Test a funnel change', 'Lower CPM on the awareness ads', 'Improve CTR for the carousel', 'A social-proof angle for catering', 'Build a redemption mechanic', 'Use the projected headroom', 'Check attribution of leads', 'Spend the incremental budget'])('refuses jargon in the title: %s', t => {
    expect(run({ display_title: t.padEnd(12, '.') })).toThrow(/plain language/)
  })
  it('refuses jargon in the summary, but only in the display fields (the technical fields keep their vocabulary)', () => {
    expect(run({ display_summary: "C2 has a weak funnel, so let's improve the conversion signal before we spend more money." })).toThrow(/plain language/)
    expect(() => validatePaidStrategy({ recommendations: [rec(1, { evidence: 'C2 CPM is 91 DKK and the funnel conversion event fires twice.', hypothesis: 'A new conversion signal will improve attribution of leads.' })] })).not.toThrow()
  })
})

describe('no new AI call and no new consumer of the display fields', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('the analysis still makes exactly one model request per attempt', () => {
    expect(read('lib/ai/paid-strategy.ts').match(/messages\.parse\(/g)).toHaveLength(1)
    expect(read('lib/marketing/paid-strategy/generate.ts').match(/callPaidStrategyAI\(/g)).toHaveLength(1)
  })
  it('nothing in implementation, execution, budget or learning reads the display fields: they are presentation only', () => {
    for (const f of ['lib/marketing/paid-strategy/implementation/compile.ts', 'lib/marketing/paid-strategy/implementation/service.ts', 'lib/marketing/paid-strategy/implementation/execute.ts', 'lib/marketing/paid-strategy/evidence.ts', 'lib/marketing/paid-strategy/generate.ts', 'lib/actions/marketing/paid-strategy-implementation.ts']) expect(read(f), f).not.toMatch(/display_(title|summary)/)
  })
})
