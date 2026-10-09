import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { buildOrganicSystemPrompt, ORGANIC_RULES, ORGANIC_STRATEGY_PROMPT_VERSION, unmatchedFigures } from '@/lib/ai/organic-strategy'
import { buildPaidStrategySystemPrompt, KOCKPIT_RULES, PAID_STRATEGY_PROMPT_VERSION } from '@/lib/ai/paid-strategy'
import { loadPriorInsights, MAX_PRIOR_INSIGHTS, neutraliseRefs, priorInsightsEvidence, rankPriorInsights, type PriorInsightInput } from '@/lib/marketing/insights/prior'
import { buildOrganicEvidence } from '@/lib/marketing/organic-strategy/evidence'
import { buildPaidStrategyEvidence, dataText } from '@/lib/marketing/paid-strategy/evidence'
import { strategyInputs } from '../../../helpers/paid-strategy'
import { fingerprint, ORGANIC_NOW, smallMeasuredSet } from '../../../helpers/organic-strategy'
import { day } from '../../../helpers/insights'

const prior = (n: number, over: Partial<PriorInsightInput> = {}): PriorInsightInput => ({
  id: `i${n}`, kind: 'finding', statement: `Earlier conclusion number ${n}`, strength: 'reasonable_inference', trend: 'steady', times_observed: 2,
  first_seen_at: day(1), last_supported_at: day(n + 1), ...over,
})
const text = (v: string, max: number) => `DATA:${v.slice(0, max)}`

describe('prior insights as context', () => {
  it('is absent when there is nothing to say', () => {
    expect(priorInsightsEvidence([], text)).toBeNull()
  })
  it('is bounded, strongest and most recent first, and labelled as not-evidence', () => {
    const items = Array.from({ length: 12 }, (_, n) => prior(n, n === 5 ? { strength: 'strong_pattern' } : {}))
    const ev = priorInsightsEvidence(items, text)!
    expect(ev.items).toHaveLength(MAX_PRIOR_INSIGHTS)
    expect(ev.items[0].statement).toContain('number 5') // the strong one first
    expect(ev.purpose).toMatch(/not current data and not proof/i)
    expect(ev.items.every(i => i.statement.startsWith('DATA:'))).toBe(true)
    expect(rankPriorInsights(items)).toHaveLength(MAX_PRIOR_INSIGHTS)
  })
  it('neutralises run-local post refs and caps statement length', () => {
    expect(neutraliseRefs('P1 and U12 beat B3')).toBe('a post and a post beat a post')
    const ev = priorInsightsEvidence([prior(1, { statement: `${'x'.repeat(500)} P2` })], text)!
    expect(ev.items[0].statement.length).toBeLessThanOrEqual('DATA:'.length + 220)
    expect(ev.items[0].statement).not.toMatch(/\bP\d/)
  })
  it('exposes dates and counts, never ids or recommendation state', () => {
    const ev = priorInsightsEvidence([prior(1)], text)!
    expect(JSON.stringify(ev)).not.toMatch(/"id"|\bi1\b|implementation|approved|rejected/i)
    expect(ev.items[0]).toMatchObject({ seen_in_runs: 2, first_seen_on: day(1).slice(0, 10), kind: 'finding', trend: 'steady' })
  })
  it('a read failure only costs context', async () => {
    const throwing = { from: () => { throw new Error('no table') } }
    expect(await loadPriorInsights(throwing as never, ['paid'])).toEqual([])
    const failing = { from: () => ({ select: () => ({ in: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: 'x' } }) }) }) }) }) }) }
    expect(await loadPriorInsights(failing as never, ['paid'])).toEqual([])
  })
})

describe('Paid Strategy wiring', () => {
  it('adds prior_insights to the evidence only when there are some (a first run sees exactly what it always did)', () => {
    const inputs = strategyInputs()
    expect(buildPaidStrategyEvidence(inputs)).not.toHaveProperty('prior_insights')
    expect(buildPaidStrategyEvidence({ ...inputs, priorInsights: [] })).not.toHaveProperty('prior_insights')
    const ev = buildPaidStrategyEvidence({ ...inputs, priorInsights: [prior(1)] }) as { prior_insights?: { items: { statement: string }[] } }
    expect(ev.prior_insights?.items[0].statement).toBe(dataText('Earlier conclusion number 1', 220))
  })
  it('tells the model prior insights are context, not evidence, and bumps the prompt version', () => {
    expect(KOCKPIT_RULES).toMatch(/prior_insights/)
    expect(KOCKPIT_RULES).toMatch(/NOT current data and NOT proof/)
    expect(KOCKPIT_RULES).toMatch(/never a reason to recommend/)
    expect(PAID_STRATEGY_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/)
    expect(PAID_STRATEGY_PROMPT_VERSION).not.toBe('2026-10-12-v9')
    expect(buildPaidStrategySystemPrompt({ ref: 'r', hash: 'h', text: 'skill' } as never)).toContain('prior_insights')
  })
})

describe('Organic Strategy wiring', () => {
  const media = smallMeasuredSet()
  const input = { media, fingerprints: media.map(m => fingerprint(m)), businessContext: [], followersLatest: 5000, now: ORGANIC_NOW }
  it('adds prior_insights only when there are some', () => {
    expect(buildOrganicEvidence(input).evidence).not.toHaveProperty('prior_insights')
    const ev = buildOrganicEvidence({ ...input, priorInsights: [prior(1, { statement: 'Marinade stories beat product shots on P1' })] }).evidence as { prior_insights?: { items: { statement: string }[] } }
    expect(ev.prior_insights?.items[0].statement).toMatch(/^DATA:Marinade stories beat product shots on a post/)
  })
  it('prior insight figures never make an output figure look grounded', () => {
    const ev = buildOrganicEvidence({ ...input, priorInsights: [prior(1, { statement: 'It reached 777,777 views' })] }).evidence
    const output = { main_learnings: [{ title: 'Some title here', evidence: 'It reached 777,777 views overall.', interpretation: 'x', evidence_strength: 'weak_signal', limitations: 'y' }], content_opportunities: [], reel_concepts: [], carousel_concepts: [] }
    expect(unmatchedFigures(output as never, ev)).toContain('777,777')
  })
  it('tells the model prior insights are context, not evidence, and bumps the prompt version', () => {
    expect(ORGANIC_RULES).toMatch(/Prior insights/)
    expect(ORGANIC_RULES).toMatch(/NOT current data and NOT proof/)
    expect(ORGANIC_STRATEGY_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/)
    expect(ORGANIC_STRATEGY_PROMPT_VERSION).not.toBe('2026-10-09-v3')
    expect(buildOrganicSystemPrompt({ ref: 'r', text: 'skill' } as never)).toContain('prior_insights')
  })
})
