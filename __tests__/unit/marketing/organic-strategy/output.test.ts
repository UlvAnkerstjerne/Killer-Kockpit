import { describe, expect, it } from 'vitest'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { validOutput } from '../../../helpers/organic-strategy'
import {
  CarouselConceptSchema, EVIDENCE_STRENGTHS, FIELD_MAX_CHARS, FIELD_TARGET_CHARS, MAX_CAROUSELS, MAX_LEARNINGS, MAX_OPPORTUNITIES, MAX_REELS, MAX_SLIDES,
  OrganicStrategyOutputSchema,
} from '@/lib/marketing/organic-strategy/types'
import { assertsClaim, OrganicStrategyValidationError, unmatchedFigures, validateOrganicStrategy } from '@/lib/ai/organic-strategy'

const ctx = { measuredInPrompt: 9, unmeasuredInPrompt: 12, businessItems: 2 }
const learning = (n: number, over: Record<string, unknown> = {}) => ({ ...validOutput().main_learnings[0], title: `Distinct learning ${n} title`, ...over })
const opportunity = (n: number, over: Record<string, unknown> = {}) => ({ ...validOutput().content_opportunities[0], title: `Distinct opportunity ${n}`, ...over })
const reel = (n: number, over: Record<string, unknown> = {}) => ({ ...validOutput().reel_concepts[0], concept_title: `Distinct reel ${n} title`, ...over })
const carousel = (n: number, over: Record<string, unknown> = {}) => ({
  concept_title: `Distinct carousel ${n} title`, opening_slide: 'The question people ask first', slide_structure: ['The question', 'The usual answer', 'What we actually do'],
  why_this_is_worth_testing: 'The subject drew shares as a video; a carousel tests whether it travels as a read.', evidence_basis: 'P1: 90,000 views and 700 shares as a video.', ...over,
})
const out = (over: Record<string, unknown>) => ({ ...validOutput(), ...over })
const rejects = (o: unknown, match: RegExp | string | (new (...args: never[]) => Error)) => expect(() => validateOrganicStrategy(o, ctx)).toThrow(match)

describe('Organic Strategy schema', () => {
  it('accepts a full valid output', () => {
    expect(OrganicStrategyOutputSchema.safeParse(validOutput()).success).toBe(true)
  })
  it('allows every list to be empty: slots are never filled to reach a maximum', () => {
    const empty = { main_learnings: [], content_opportunities: [], reel_concepts: [], carousel_concepts: [] }
    expect(OrganicStrategyOutputSchema.safeParse(empty).success).toBe(true)
    expect(validateOrganicStrategy(empty, ctx).output).toEqual(empty)
    // One Reel and zero carousels is a valid answer.
    expect(validateOrganicStrategy(validOutput({ carousel_concepts: [] }), ctx).output.carousel_concepts).toHaveLength(0)
  })
  it('enforces the maximum counts: 5 learnings, 5 opportunities, 3 Reels, 6 carousels', () => {
    expect([MAX_LEARNINGS, MAX_OPPORTUNITIES, MAX_REELS, MAX_CAROUSELS]).toEqual([5, 5, 3, 6])
    const upTo = (make: (n: number) => unknown, n: number) => Array.from({ length: n }, (_, i) => make(i + 1))
    expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: upTo(learning, 5) })).success).toBe(true)
    expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: upTo(learning, 6) })).success).toBe(false)
    expect(OrganicStrategyOutputSchema.safeParse(out({ content_opportunities: upTo(opportunity, 6) })).success).toBe(false)
    expect(OrganicStrategyOutputSchema.safeParse(out({ reel_concepts: upTo(reel, 3) })).success).toBe(true)
    expect(OrganicStrategyOutputSchema.safeParse(out({ reel_concepts: upTo(reel, 4) })).success).toBe(false)
    expect(OrganicStrategyOutputSchema.safeParse(out({ carousel_concepts: upTo(carousel, 6) })).success).toBe(true)
    expect(OrganicStrategyOutputSchema.safeParse(out({ carousel_concepts: upTo(carousel, 7) })).success).toBe(false)
  })
  it('accepts exactly the three evidence-strength values and nothing else', () => {
    expect([...EVIDENCE_STRENGTHS]).toEqual(['proven_pattern', 'reasonable_inference', 'weak_signal'])
    for (const s of EVIDENCE_STRENGTHS) expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: [learning(1, { evidence_strength: s })] })).success).toBe(true)
    for (const bad of ['proven', 'strong', 'PROVEN_PATTERN', '', 3]) expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: [learning(1, { evidence_strength: bad })] })).success).toBe(false)
  })
  it('requires every specified field and refuses anything extra (no captions, hashtags, IDs or scores)', () => {
    for (const key of Object.keys(learning(1))) {
      const partial: Record<string, unknown> = { ...learning(1) }; delete partial[key]
      expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: [partial] })).success, key).toBe(false)
    }
    for (const extra of ['caption', 'hashtags', 'score', 'media_id', 'post_url']) {
      expect(OrganicStrategyOutputSchema.safeParse(out({ reel_concepts: [{ ...reel(1), [extra]: 'x' }] })).success, extra).toBe(false)
    }
    expect(OrganicStrategyOutputSchema.safeParse({ ...validOutput(), extra: [] }).success).toBe(false)
  })
  it('bounds a carousel to 2 to 10 short slides', () => {
    expect(MAX_SLIDES).toBe(10)
    expect(CarouselConceptSchema.safeParse(carousel(1, { slide_structure: ['only one slide here'] })).success).toBe(false)
    expect(CarouselConceptSchema.safeParse(carousel(1, { slide_structure: Array.from({ length: 11 }, (_, i) => `Slide number ${i + 1}`) })).success).toBe(false)
    expect(CarouselConceptSchema.safeParse(carousel(1, { slide_structure: Array.from({ length: 10 }, (_, i) => `Slide number ${i + 1}`) })).success).toBe(true)
  })
  it('keeps hard maxima above the budgets the model is told, and rejects runaway fields', () => {
    for (const key of Object.keys(FIELD_TARGET_CHARS) as (keyof typeof FIELD_TARGET_CHARS)[]) expect(FIELD_MAX_CHARS[key], key).toBeGreaterThan(FIELD_TARGET_CHARS[key])
    expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: [learning(1, { interpretation: 'x '.repeat(FIELD_TARGET_CHARS.interpretation / 2 + 40) })] })).success).toBe(true) // mild overshoot survives
    expect(OrganicStrategyOutputSchema.safeParse(out({ main_learnings: [learning(1, { interpretation: 'x'.repeat(FIELD_MAX_CHARS.interpretation + 1) })] })).success).toBe(false)
  })
  it('compiles to a structured-output format for the Anthropic SDK', () => {
    const format = zodOutputFormat(OrganicStrategyOutputSchema)
    expect(JSON.stringify(format)).toContain('reel_concepts')
  })
})

describe('Organic Strategy output validation: nothing invented', () => {
  it('passes a clean, evidence-led output', () => {
    expect(validateOrganicStrategy(validOutput(), ctx).output.main_learnings).toHaveLength(2)
  })

  it.each([
    ['URL', { evidence: 'P1 is described at https://instagram.com/p/abc with 90,000 views.' }],
    ['platform ID', { evidence: 'Media 17841400000000001 reached 90,000 views.' }],
    ['credential wording', { evidence: 'P1 reached 90,000 views. Use the access token to confirm.' }],
    ['payload shape', { evidence: 'P1 {"media_id": "abc"} reached 90,000 views.' }],
  ])('rejects %s', (_n, over) => rejects(out({ main_learnings: [learning(1, over)] }), OrganicStrategyValidationError))

  it('rejects demographic and audience claims anywhere except in a limitation that says none exist', () => {
    rejects(out({ content_opportunities: [opportunity(1, { suggested_angle: 'Aim this at women in their thirties who order late.' })] }), /demographic or audience claim/)
    rejects(out({ reel_concepts: [reel(1, { execution: 'Cast a student at the counter and open on the queue. Film the order from the till, then the plate.' })] }), /demographic or audience claim/)
    rejects(out({ main_learnings: [learning(1, { interpretation: 'It may resonate with millennials who like a debate.' })] }), /demographic or audience claim/)
    expect(validateOrganicStrategy(out({ main_learnings: [learning(1, { limitations: 'No demographic or age data exists, so no audience claim is possible.' })] }), ctx)).toBeTruthy()
  })

  it('rejects invented retention, completion or follower-split data in evidence and interpretation', () => {
    rejects(out({ main_learnings: [learning(1, { evidence: 'P1 had higher retention than P2, with 90,000 views.' })] }), /retention or follower-split/)
    rejects(out({ main_learnings: [learning(1, { evidence: 'P1 reached 90,000 views, mostly non-followers.' })] }), /retention or follower-split/)
    rejects(out({ main_learnings: [learning(1, { interpretation: 'The completion rate was probably strong on P1.' })] }), /retention or follower-split/)
    rejects(out({ reel_concepts: [reel(1, { evidence_basis: 'P1 kept viewers watching, with strong watch time and 90,000 views.' })] }), /retention or follower-split/)
  })

  it('still lets suggestions and limitations talk about the missing data', () => {
    const ok = out({
      main_learnings: [learning(1, { limitations: 'There is no retention data and reach is not split into followers and non-followers.' })],
      reel_concepts: [reel(1, { why_this_is_worth_testing: 'Insights will show watch time for this one, which we cannot see for the older posts.' })],
    })
    expect(validateOrganicStrategy(ok, ctx)).toBeTruthy()
  })

  it('rejects visual claims in evidence: the footage was never analysed', () => {
    rejects(out({ main_learnings: [learning(1, { evidence: 'P1 had a striking close-up thumbnail and reached 90,000 views.' })] }), /visual claim/)
    rejects(out({ content_opportunities: [opportunity(1, { evidence_basis: 'The footage in P1 was brightly lit and reached 90,000 views.' })] }), /visual claim/)
    // Execution is a suggestion for new content, so it may describe shots.
    expect(validateOrganicStrategy(out({ reel_concepts: [reel(1, { execution: 'Open on a close-up of the marinade tub, then cut wide to the prep station. Name the one surprising step, end on the plate.' })] }), ctx)).toBeTruthy()
  })

  it('rejects causal language in evidence fields but allows hedged inference', () => {
    rejects(out({ main_learnings: [learning(1, { evidence: 'P1 reached 90,000 views because of its question.' })] }), /causal language/)
    rejects(out({ content_opportunities: [opportunity(1, { evidence_basis: 'The claim in P1 drove 700 shares.' })] }), /causal language/)
    expect(validateOrganicStrategy(out({ main_learnings: [learning(1, { interpretation: 'The question may be part of why it was passed on; one post cannot show this.' })] }), ctx)).toBeTruthy()
  })

  it('rejects references to posts that are not in the data', () => {
    rejects(out({ main_learnings: [learning(1, { evidence: 'P10 reached 90,000 views.' })] }), /cites P10, which is not in the data/)
    rejects(out({ main_learnings: [learning(1, { evidence: 'P0 reached 90,000 views.' })] }), /cites P0/)
    rejects(out({ reel_concepts: [reel(1, { evidence_basis: 'U13 covered the subject before; 12 listed.' })] }), /cites U13/)
    rejects(out({ content_opportunities: [opportunity(1, { evidence_basis: 'Company note B3 mentions a delivery.' })] }), /cites B3/)
    expect(validateOrganicStrategy(out({ content_opportunities: [opportunity(1, { evidence_basis: 'Subject-matter idea from B2; U12 covered it before; P9 is the nearest measured post.' })] }), ctx)).toBeTruthy()
  })

  it('rejects duplicate titles within a list', () => {
    rejects(out({ main_learnings: [learning(1, { title: 'Same title here' }), learning(2, { title: 'same title here' })] }), /duplicate titles/)
    rejects(out({ reel_concepts: [reel(1, { concept_title: 'Same reel' }), reel(2, { concept_title: 'same REEL' })] }), /duplicate titles/)
  })
})

describe('Organic Strategy output validation: strength is earned', () => {
  const proven = (evidence: string) => out({ main_learnings: [learning(1, { evidence_strength: 'proven_pattern', evidence })] })
  it('keeps proven_pattern only with 5 or more measured posts and 3 or more distinct posts cited', () => {
    const solid = validateOrganicStrategy(proven('P1, P2 and P4 each reached above 7,000 views with shares well above the median.'), ctx)
    expect(solid.output.main_learnings[0].evidence_strength).toBe('proven_pattern')
    expect(solid.strengthDowngrades).toBe(0)
  })
  it('downgrades proven_pattern resting on fewer than 3 cited posts, and counts it', () => {
    const r = validateOrganicStrategy(proven('P1 and P2 reached 90,000 and 30,000 views.'), ctx)
    expect(r.output.main_learnings[0].evidence_strength).toBe('reasonable_inference')
    expect(r.strengthDowngrades).toBe(1)
  })
  it('downgrades proven_pattern when fewer than 5 posts are measured at all', () => {
    const r = validateOrganicStrategy(proven('P1, P2 and P3 all reached above 7,000 views.'), { ...ctx, measuredInPrompt: 4 })
    expect(r.output.main_learnings[0].evidence_strength).toBe('reasonable_inference')
  })
  it('applies the same discipline to content opportunities and leaves the weaker labels alone', () => {
    const r = validateOrganicStrategy(out({
      main_learnings: [learning(1, { evidence_strength: 'weak_signal' }), learning(2, { evidence_strength: 'reasonable_inference' })],
      content_opportunities: [opportunity(1, { evidence_strength: 'proven_pattern', evidence_basis: 'Only P1 supports this at 90,000 views.' })],
    }), ctx)
    expect(r.output.main_learnings.map(l => l.evidence_strength)).toEqual(['weak_signal', 'reasonable_inference'])
    expect(r.output.content_opportunities[0].evidence_strength).toBe('reasonable_inference')
    expect(r.strengthDowngrades).toBe(1)
  })
})

describe('Organic Strategy output validation: figure check is telemetry, not a gate', () => {
  const evidence = { posts: [{ caption: 'DATA:Why we marinate the chicken for 36 hours. Most places skip it.', metrics: { views: 90_021, shares: 700 }, rate: 7.8 }], sample: { measured_posts: 9 } }
  it('matches cited figures to the supplied data, including k/M rounding', () => {
    const o = validOutput({ main_learnings: [learning(1, { evidence: 'P1 reached about 90k views and 700 shares, a rate of 7.8 per 1,000. Nine posts, 2026.' })] })
    expect(unmatchedFigures(o, evidence)).toEqual([])
  })
  it('lists figures that appear nowhere in the data, without rejecting the output', () => {
    const o = validOutput({ main_learnings: [learning(1, { evidence: 'P1 reached 250,000 views and 4,321 shares.' })] })
    expect(unmatchedFigures(o, evidence)).toEqual(expect.arrayContaining(['250,000', '4,321']))
    const result = validateOrganicStrategy(o, ctx, evidence)
    expect(result.unmatchedFigures.length).toBeGreaterThan(0)
    expect(result.output.main_learnings).toHaveLength(1)
  })
})

// ── Regression: the first live evaluation rejected BOTH answers for sentences that DENY or HEDGE the claim ──

describe('Organic Strategy validation: asserted claims are rejected, negated or hedged ones are not', () => {
  const opp = (evidence_basis: string) => out({ content_opportunities: [opportunity(1, { evidence_basis })] })
  const reelEvidence = (evidence_basis: string) => out({ reel_concepts: [reel(1, { evidence_basis })] })
  const learningEvidence = (evidence: string) => out({ main_learnings: [learning(1, { evidence })] })

  it('accepts the exact sentence that failed live attempt 1: it denies causality', () => {
    const live = 'P9: 35× format median, 3.8 shares/1k views — highest share rate in the dataset. Single post; cannot confirm the opening line drove reach, but the combination of the framing and the result is notable.'
    expect(validateOrganicStrategy(opp(live), ctx)).toBeTruthy()
  })
  it('accepts the exact sentence that failed live attempt 2: it says the visual angle is untested', () => {
    const live = 'P2 1.04x median; P4 0.58x with highest save rate (3.6/1k); P5 11.1x median; P7 0.96x. Process-subject consistency across 4 posts. Format variation (visual-first) is untested.'
    expect(validateOrganicStrategy(reelEvidence(live), ctx)).toBeTruthy()
  })
  it('accepts statements that the data is missing, which is what we want the model to say', () => {
    expect(validateOrganicStrategy(learningEvidence('P1 reached 90,000 views. There is no retention data for these posts, so watch time is unknown.'), ctx)).toBeTruthy()
    expect(validateOrganicStrategy(learningEvidence('P1 reached 90,000 views. Whether it reached non-followers is unknown.'), ctx)).toBeTruthy()
  })

  it.each([
    ['causal, bare', 'The question in P1 drove reach and 700 shares.'],
    ['causal, because of', 'P1 reached 90,000 views because of its question.'],
    ['causal, led to', 'The strong claim in P2 led to 30,000 views.'],
  ])('still rejects an asserted cause: %s', (_n, text) => {
    rejects(opp(text), /causal language/)
  })
  it.each([
    ['visual, bare', 'The footage in P1 was brightly lit and reached 90,000 views.'],
    ['visual, thumbnail', 'P1 had a striking thumbnail and reached 90,000 views.'],
  ])('still rejects an asserted visual claim: %s', (_n, text) => {
    rejects(reelEvidence(text), /visual claim/)
  })
  it.each([
    ['retention, bare', 'P1 had higher retention than P2, with 90,000 views.'],
    ['follower split, bare', 'P1 reached 90,000 views, mostly non-followers.'],
  ])('still rejects invented data: %s', (_n, text) => {
    rejects(learningEvidence(text), /retention or follower-split/)
  })

  it('a hedge in a DIFFERENT sentence does not rescue an assertion', () => {
    rejects(opp('There is no other explanation in the data. The question in P1 drove reach.'), /causal language/)
    rejects(reelEvidence('Nothing else was analysed. The footage in P1 was bright.'), /visual claim/)
  })
  it('a far-away hedge in the same sentence does not rescue an assertion either', () => {
    rejects(opp('The question in P1 drove reach across all nine posts that were measured in the dataset and shown here, which is a result.'), /causal language/)
  })

  describe('assertsClaim', () => {
    const causal = /\b(drove|caused?)\b/
    it('flags unhedged matches and clears hedged or negated ones', () => {
      expect(assertsClaim('P1 drove reach.', causal)).toBe(true)
      expect(assertsClaim('P1 may be why, but we cannot say it drove reach.', causal)).toBe(false)
      expect(assertsClaim('It is unclear whether the caption caused the spike.', causal)).toBe(false)
      expect(assertsClaim('The caption caused the spike, which is not proven.', causal)).toBe(false)
      expect(assertsClaim('No post is the cause. P2 caused the spike.', causal)).toBe(true)
    })
    it('treats every sentence separately and handles empty text', () => {
      expect(assertsClaim('', causal)).toBe(false)
      expect(assertsClaim('Nothing here.', causal)).toBe(false)
      expect(assertsClaim('Cannot confirm anything; P3 caused it.', causal)).toBe(true)
    })
    it('lets a denial reach back across a long clause, but a "but" ends its scope (live false positive)', () => {
      const visual = /\b(visual(?:ly)?|footage)\b/i
      expect(assertsClaim('No measured or unmeasured post has used raw cuts as the primary visual subject.', visual)).toBe(false)
      expect(assertsClaim('No retention data exists, but the opening footage clearly held attention.', visual)).toBe(true)
      expect(assertsClaim('P5 used raw cuts as the primary visual subject.', visual)).toBe(true)
    })
    it('does not read a caption explaining the brand as a causal claim, but still rejects "explains why it performed"', () => {
      const out = (evidence: string) => ({ ...validOutput(), main_learnings: [{ ...validOutput().main_learnings[0], evidence }] })
      expect(() => validateOrganicStrategy(out('P1: the caption explains why Killer Kebab uses the word kebab, and drew 90,000 views.'), ctx)).not.toThrow()
      expect(() => validateOrganicStrategy(out('P1: the opening line explains why it performed so well.'), ctx)).toThrow('causal language')
    })
  })
})
