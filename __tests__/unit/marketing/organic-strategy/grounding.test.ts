// Regression: the first live evaluation invented plausible Killer Kebab business facts inside creative
// concepts. Business facts must come from the supplied captions and company notes, and nowhere else.
import { describe, expect, it } from 'vitest'
import { businessItem, media, ORGANIC_NOW, validOutput } from '../../../helpers/organic-strategy'
import { buildOrganicEvidence } from '@/lib/marketing/organic-strategy/evidence'
import { groundingSources, normaliseForGrounding, ORGANIC_RULES, unsupportedBusinessFact, validateOrganicStrategy } from '@/lib/ai/organic-strategy'
import type { Media } from '@/lib/marketing/brain/types'

// Captions shaped like the real ones that mattered. What they do NOT say is the point of every test below:
// nothing says the chicken is marinated, nothing says how long the chicken took, nothing says the harissa
// is made in-house, and nothing says vegetables are bought elsewhere.
const CAPTIONS = {
  marinade: 'At Killer Kebab, we marinate our own meat... Every morning after finishing today\'s kebab, we start marinating the meat for tomorrow\'s. That means the meat spends almost 24 hours soaking up the flavours from our homemade yogurt marinade. Do you think its worth the effort?',
  age: '#KillerKraft - some say we\'re gentrifying kebab. We say we\'re respecting the craft. And 6 years after opening our first location, we still build our lamb kebab fresh - every, single, morning!',
  bread: 'At Killer Kebab, we serve both our kebab and our falafels in one of our homemade sourdough flatbreads. And we bake them fresh to order: Every. Single. Time.',
  falafel: 'We make our own falafel dough and always cook our falafels fresh to order.',
  catering: 'Finally. Killer Kebab now does Killer Katering. One menu, five dishes: two salads, two spreads, and Killer Falafels. Plus Killer Harissa and freshly baked sourdough flatbreads. 149 DKK per person. #KillerKatering #Copenhagen #homemade',
  chickenA: 'How do we make the new Killer Kylling? With zhug-urt, Killer Kucumbers, parsley and pointed cabbage, wrapped in one of our fabulously fluffy sourdough flatbreads. Come try it at Inner City.',
  chickenB: 'In case you haven\'t heard: We finally did it! The new KILLER KYLLING is here and it\'s delightfully delicious!',
}
const posts: Media[] = [
  media(1, { caption: CAPTIONS.marinade, plays: 150_000, reach: 120_000, published_at: '2026-08-10T10:00:00Z' }),
  media(2, { caption: CAPTIONS.age, plays: 500_000, reach: 400_000, published_at: '2026-06-23T10:00:00Z' }),
  media(3, { caption: CAPTIONS.bread, published_at: '2026-07-21T10:00:00Z' }),
  media(4, { caption: CAPTIONS.falafel, published_at: '2026-07-01T10:00:00Z' }),
]
const unmeasured = (n: number, caption: string): Media => media(n, {
  caption, reach: null, plays: null, shares: null, saved: null, comments_count: null, likes: null, total_interactions: null, published_at: `2026-05-0${n - 100}T10:00:00Z`,
})
const built = buildOrganicEvidence({
  media: [...posts, unmeasured(101, CAPTIONS.catering), unmeasured(102, CAPTIONS.chickenA), unmeasured(103, CAPTIONS.chickenB)],
  fingerprints: [], followersLatest: null, now: ORGANIC_NOW, businessContext: [businessItem(1, { body: 'Delivered a 120 person lunch for a design studio.' })],
})
const evidence = built.evidence
const ctx = { measuredInPrompt: built.summary.measured_in_prompt, unmeasuredInPrompt: built.summary.unmeasured_in_prompt, businessItems: built.summary.business_context_items }
const sources = groundingSources(evidence)

// The shared fixture's concept is written against ITS captions (36 hours); these captions say no such thing, so start from a neutral concept.
const reel = (over: Record<string, unknown>) => ({
  ...validOutput().reel_concepts[0],
  concept_title: 'The question we keep getting', hook: 'People ask us this every week.',
  core_idea: 'Answer one question from the counter, in plain words.', execution: 'Open on the question. A founder answers it. Show the finished wrap. End on the plate.',
  ...over,
})
const asReel = (over: Record<string, unknown>) => validOutput({ reel_concepts: [reel(over)] as never })
const asCarousel = (slides: string[]) => validOutput({
  carousel_concepts: [{ concept_title: 'A carousel idea', opening_slide: 'The question people ask first', slide_structure: slides,
    why_this_is_worth_testing: 'Tests whether the subject travels as a read.', evidence_basis: 'Subject-matter idea; no organic evidence.' }],
})
const rejects = (o: unknown) => expect(() => validateOrganicStrategy(o, ctx, evidence)).toThrow(/states|supplied caption|no source gives|history/)
const accepts = (o: unknown) => expect(validateOrganicStrategy(o, ctx, evidence)).toBeTruthy()

describe('the evidence does not state the four facts the strategist invented', () => {
  const all = sources.join(' | ')
  it('says nothing about chicken and a marinade, a six-year wait, in-house harissa, or externally sourced vegetables', () => {
    expect(sources.some(s => /(chicken|kylling)/.test(s) && /(marinat|yogurt|yoghurt)/.test(s))).toBe(false)
    expect(all).not.toMatch(/took us|waited|for years/)
    expect(sources.some(s => /harissa/.test(s) && /(in house|from scratch|our own|made in)/.test(s))).toBe(false)
    expect(all).not.toMatch(/sourced|supplier|bought|externally/)
  })
})

describe('invented business facts are rejected', () => {
  it('rejects: the chicken uses the same 24-hour yogurt marinade as the lamb', () => {
    rejects(asReel({ concept_title: 'The marinade decision: why the chicken spent 24 hours in yogurt before it reached the menu' }))
    rejects(asReel({ core_idea: 'The same 24-hour yogurt marinade process used for the lamb was applied to chicken before it was considered ready.' }))
    rejects(asReel({ execution: 'Open on the marinating process. A container of chicken in yogurt marinade. Close on the finished wrap and the plate with no price.' }))
  })
  it('rejects: it took us six years to launch chicken, however it is phrased', () => {
    rejects(asReel({ hook: 'We could have opened with chicken on day one. We did not. Here is why it took us six years.' }))
    rejects(asReel({ execution: 'A team member says: We have been asked about chicken for years. We said no until we could do it properly. Then close on the wrap and the sign.' }))
    rejects(asReel({ why_this_is_worth_testing: 'The team waited 6 years before adding it, which makes the decision the story and the proof of the standard.' }))
  })
  it('rejects: the harissa is made in-house', () => {
    rejects(asReel({ core_idea: 'A walkthrough of the sourdough flatbread, the lamb cuts and the homemade harissa. One contrast per reel in total.' }))
    rejects(asCarousel(['Cover: what homemade means', 'The harissa: made in the Killer kitchen, not a branded sauce']))
  })
  it('rejects: vegetables are sourced externally, and its negation (not made ourselves)', () => {
    rejects(asCarousel(['Cover: what homemade means', 'What we do NOT make ourselves: vegetables sourced externally']))
    rejects(asCarousel(['Cover: what homemade means', 'The falafel dough: mixed in-house, not bought pre-formed']))
  })
  it('rejects a duration no source states, even when it sounds like craft', () => {
    rejects(asReel({ hook: 'Our lamb rests for 36 hours before the spit. Here is why.' }))
    rejects(asReel({ core_idea: 'Show the three month trial that preceded the launch, one decision at a time.' }))
  })
  it('reports where the problem is, so the answer can be traced', () => {
    expect(() => validateOrganicStrategy(asReel({ hook: 'It took us six years to get the chicken right.' }), ctx, evidence)).toThrow(/reel_concepts\[0\]\.hook: states company history no source gives/)
  })
})

describe('supported facts and honest concepts still pass', () => {
  it('keeps a concept that uses only what the captions say', () => {
    accepts(asReel({
      concept_title: 'Why we call it kebab: a sequel on another naming question',
      hook: 'Last time we explained the name. Here is the next question we keep getting asked.',
      core_idea: 'Explain what makes the Killer Kylling preparation different, using only what the team can say on camera.',
      execution: 'Open on the question. A founder answers in plain words. Show the zhug-urt and the cucumbers in the wrap. Close on a question back to the viewer.',
      why_this_is_worth_testing: 'The explainer format reached well above the median once and has been used once.', evidence_basis: 'P1: 150,000 views. Subject-matter idea beyond that.',
    }))
  })
  it('allows facts the sources DO state, for the product they state them about', () => {
    accepts(asReel({ core_idea: 'The meat is marinated for almost 24 hours in the homemade yogurt marinade, and the team starts tomorrow\'s marinade after today\'s kebab.', execution: 'Open on the marinade tub. Name the step. Cut to the finished kebab. End on the plate and no price.' }))
    accepts(asReel({ core_idea: 'The sourdough flatbreads are homemade and baked fresh to order, every single time.', execution: 'Start on the flatbread on the grill. Name the contrast. Show the finished wrap. End on the plate.' }))
    accepts(asReel({ core_idea: 'The falafel dough is made in-house: they make their own falafel dough and cook the falafels fresh to order.', execution: 'Show the dough. Show the fryer. Show the plate. End on the box and the counter.' }))
  })
  it('allows six years when a source gives it as the business\'s age, but not as how long something took', () => {
    accepts(asReel({ core_idea: 'Six years after opening the first location, the lamb kebab is still built fresh every morning. Make that the story.', execution: 'Open on the morning build. Say the line. Show the finished kebab. End on the shop front and the sign.' }))
  })
  it('does not read "organic" (unpaid reach) as a sourcing claim', () => {
    accepts(asReel({ core_idea: 'The Killer Kylling has no measured video yet, so its organic traction on video is unknown. Test one reel.' }))
  })
  it('lets a concept ask for confirmation instead of inventing the detail', () => {
    accepts(asReel({ execution: 'Explain what makes the Killer Kylling preparation different. Confirm the exact preparation detail internally before using it. Close on the finished wrap.' }))
    accepts(asReel({ execution: 'Check whether the harissa is made in-house before saying so. Otherwise show the plate and name the dish. End on the box.' }))
  })
  it('does not apply the rule to limitations, which may say what the data does not contain', () => {
    const o = asReel({})
    accepts({ ...o, main_learnings: [{ ...o.main_learnings[0], limitations: 'No caption says how the chicken is prepared or whether the harissa is made in-house.' }] })
  })
  it('is skipped when no evidence is supplied (content-only unit tests)', () => {
    expect(validateOrganicStrategy(asReel({ hook: 'It took us six years to get the chicken right.' }), ctx)).toBeTruthy()
  })
})

describe('helpers', () => {
  it('normalises number words and hyphens so "24-hour" and "twenty..." compare fairly', () => {
    expect(normaliseForGrounding('A 24-hour soak, six years')).toBe('a 24 hour soak, 6 years')
  })
  it('uses only the captions and notes the model was given as sources', () => {
    expect(sources.length).toBe(4 + 3 + 2) // 4 measured + 3 unmeasured + project and note
    expect(sources.every(s => !s.startsWith('data:'))).toBe(true)
  })
  it('flags nothing in a concept that states no business fact', () => {
    expect(unsupportedBusinessFact('Open on a question. Cut to the counter. End on the plate.', sources)).toBeNull()
  })
})

describe('prompt contract: the strategist is told the grounding rule', () => {
  it.each([
    ['Ground every business fact in the supplied sources'],
    ['must be supported by the supplied evidence'],
    ['The ONLY supported sources are: the captions and data of measured posts (P), the captions of unmeasured posts (U), and the company notes in creative_context (B)'],
    ['If a fact is not in those sources, do NOT state it as true'],
    ['Do not fill gaps from general knowledge'],
    ['A detail stated for one product, step or post is not true of another'],
    ['Never state a number, duration (hours, months, years) or piece of company history that no source states'],
    ['Never state where something is made or from whom it is bought'],
    ['do not put an unsupported fact in anyone\'s mouth'],
    ['REMOVE the detail and keep the concept at the level the sources support'],
    ['Confirm the exact preparation detail internally before using it'],
    ['the default is a concept written entirely from known facts'],
  ])('contains: %s', text => { expect(ORGANIC_RULES).toContain(text) })

  it('keeps the rule generic: no product, recipe or benchmark names leak into our prompt', () => {
    expect(ORGANIC_RULES).not.toMatch(/kylling|chicken|harissa|falafel|yogh?urt|marinade|catering|killer ?kraft|gentrif|shawarma|d[oö]ner/i)
  })
})
