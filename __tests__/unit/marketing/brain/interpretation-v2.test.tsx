// Marketing Brain v2 interpretation: voice, synthesis, validation, stale-run protection, legacy rendering.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('server-only', () => ({}))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { parse: vi.fn() } } }))

import BrainView from '@/app/(marketing)/marketing/brain/BrainView'
import { INTERPRETATION_SYSTEM_PROMPT, InterpretationSchema, validateInterpretation, callCreativeInterpretation } from '@/lib/ai/creative-interpretation'
import { INTERPRETATION_PROMPT_VERSION } from '@/lib/marketing/brain/taxonomy'
import { isInsight } from '@/lib/marketing/brain/types'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import type { MarketingBusinessContextItem } from '@/lib/marketing/brain/business-context'
import { currentRun, savedRun, twoReelsSample, twoReelsV2Output, TWO_REELS_V2_COPY, LEGACY_PROMPT_VERSION } from '../../../helpers/creative-brain'

const base: BrainData = { allowed: true, canRefresh: false, run: null, latestAttempt: null, error: null }
const facts = { posts_in_analysis: 7, measured_posts: 7 }
const exceptionalIds = () => twoReelsSample().signals.filter(s => s.type === 'exceptional_post').map(s => s.id)
const katering: MarketingBusinessContextItem = {
  update_id: 'upd-1', project_id: 'p1', project_title: 'Killer Katering', parent_project_title: null,
  body: 'Killer Katering completed its first catering delivery.', occurred_on: '2026-10-04', created_at: '2026-10-04T10:00:00Z', age_days: 4,
}

describe('version and stale-run protection', () => {
  it('pins the interpretation prompt version to v2 and keeps the bump comment', async () => {
    expect(INTERPRETATION_PROMPT_VERSION).toBe('2026-10-08-v2')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('lib/marketing/brain/taxonomy.ts', 'utf8')).toContain('Bump this whenever interpretation semantics, schema or voice materially change.')
  })
  it('old runs still display but show "Refresh recommended"', () => {
    const run = { ...savedRun(), prompt_version: LEGACY_PROMPT_VERSION }
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    expect(html).toContain('Generated with an older Brain version · Refresh recommended')
    expect(html).toContain('What we learned') // legacy observations still render
    expect(html).toContain('Best hooks')
  })
  it('current runs do not show the stale warning', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: currentRun() }} />)
    expect(html).not.toContain('older Brain version')
    expect(html).not.toContain('Refresh recommended')
  })
})

describe('legacy v1 runs', () => {
  it('render through the compatibility path and are not insights', () => {
    const run = savedRun()
    expect(run.observations.every(o => !isInsight(o))).toBe(true)
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    expect(html).toContain('Try next')
    expect(html).not.toContain("Brain&#x27;s take")
  })
})

describe('v2 synthesis', () => {
  it('two related exceptional Reels can be synthesised into ONE insight', () => {
    const ids = exceptionalIds()
    expect(ids).toHaveLength(2)
    const { insights, brain_take } = validateInterpretation(twoReelsV2Output(ids), twoReelsSample().signals, [], facts)
    expect(insights).toHaveLength(1)
    expect(insights[0].signal_ids).toEqual(ids)
    expect(brain_take).toContain('two Reels')
  })
  it('the representative evidence matches the production screen (11.1× and 7.3×)', () => {
    const metrics = twoReelsSample().signals.filter(s => s.type === 'exceptional_post').map(s => s.current.toFixed(1)).sort()
    expect(metrics).toEqual(['11.1', '7.3'])
  })
  it('renders Brain’s take, one card with both reels, and "Try next"', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: currentRun() }} />)
    expect(html).toContain('Brain&#x27;s take')
    expect(html).toContain(TWO_REELS_V2_COPY.headline)
    expect(html).toContain('Try next')
    expect(html).toContain('11.1× format median')
    expect(html).toContain('7.3× format median')
    expect(html.match(/Two reels are doing the heavy lifting/g)).toHaveLength(1)
    expect(html).not.toContain('What we learned')
    expect(html).not.toContain('Test next')
  })
  it('zero insights is valid and shows the take without filler', () => {
    const out = { brain_take: "There's nothing here strong enough to change what we do. Keep posting and check again once we have more.", insights: [] }
    expect(validateInterpretation(out, twoReelsSample().signals, [], facts).insights).toEqual([])
    const run = { ...currentRun(), observations: [], analytics: { ...currentRun().analytics!, brain_take: out.brain_take } }
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    expect(html).toContain('nothing here strong enough')
    expect(html).not.toContain('No AI observations were produced')
  })
})

describe('v2 validation', () => {
  const signals = () => twoReelsSample().signals
  const one = () => twoReelsV2Output(exceptionalIds()).insights[0]
  const withInsight = (patch: Record<string, unknown>) => ({ ...twoReelsV2Output(exceptionalIds()), insights: [{ ...one(), ...patch }] })

  it('every insight must reference valid supplied signal IDs (1–4)', () => {
    expect(() => validateInterpretation(withInsight({ signal_ids: ['not-a-signal'] }), signals(), [], facts)).toThrow()
    expect(() => validateInterpretation(withInsight({ signal_ids: [] }), signals(), [], facts)).toThrow()
    expect(() => validateInterpretation(withInsight({ signal_ids: ['a', 'b', 'c', 'd', 'e'] }), signals(), [], facts)).toThrow()
    expect(() => validateInterpretation(withInsight({ signal_ids: [exceptionalIds()[0], 'not-a-signal'] }), signals(), [], facts)).toThrow()
  })
  it('rejects redundant insights over the same signal set', () => {
    const out = { ...twoReelsV2Output(exceptionalIds()), insights: [one(), { ...one(), headline: 'A different headline here' }] }
    expect(() => validateInterpretation(out, signals(), [], facts)).toThrow(/same signals/)
    const [a, b] = exceptionalIds()
    const distinct = { ...twoReelsV2Output([a]), insights: [{ ...one(), signal_ids: [a] }, { ...one(), signal_ids: [b], headline: 'The other reel stands out too' }] }
    expect(validateInterpretation(distinct, signals(), [], facts).insights).toHaveLength(2)
  })
  it('cannot invent numbers (digits, percentages or unsupported counts in words)', () => {
    for (const take of ['These two got 11 times more views than usual.', 'That is a 40% jump over our normal reel.', 'We looked at nineteen posts and these two stood out.', 'It roughly doubled the usual views for us.']) {
      expect(() => validateInterpretation(withInsight({ take }), signals(), [], facts), take).toThrow()
    }
    expect(() => validateInterpretation(withInsight({ take: 'With only seven posts we still cannot say why these two stood out.' }), signals(), [], facts)).not.toThrow()
  })
  it('cannot invent demographics', () => {
    for (const take of ['Younger women clearly love these two reels more than anyone.', 'This is what students and parents respond to in our reels.', 'Teens in Copenhagen are driving these two reels.']) {
      expect(() => validateInterpretation(withInsight({ take }), signals(), [], facts), take).toThrow()
    }
  })
  it('cannot state causes as proven fact', () => {
    expect(() => validateInterpretation(withInsight({ take: 'The caption hook definitely made these two reels take off.' }), signals(), [], facts)).toThrow()
    expect(() => validateInterpretation(withInsight({ take: "We don't know yet what caused it, so I wouldn't credit the caption hook." }), signals(), [], facts)).not.toThrow()
  })
  it('business context cannot become performance evidence but can shape the next move', () => {
    const bad = withInsight({ take: 'Katering content performs well with our followers.' })
    expect(() => validateInterpretation(bad, signals(), [katering], facts)).toThrow(/performance evidence/)
    const good = withInsight({ next_move: 'Use the first Killer Katering delivery as the subject of the next Reel and borrow the strongest shared trait of the two standout reels.', business_context: [{ update_id: 'upd-1', role: 'subject_matter' }] })
    const { insights } = validateInterpretation(good, signals(), [katering], facts)
    expect(insights[0].business_context?.[0].update_id).toBe('upd-1')
  })
  it('the schema keeps at most three insights', () => {
    const out = { ...twoReelsV2Output(exceptionalIds()), insights: Array(4).fill(one()) }
    expect(() => InterpretationSchema.parse(out)).toThrow()
  })
})

describe('voice', () => {
  it('the prompt asks for plain human voice and lists robotic phrases to avoid', () => {
    for (const phrase of ['tentative cue', 'cohort baseline', 'considerable margin', 'this remains observational', 'unrelated external factors', 'difficult to isolate', 'statistically proven', 'algorithm amplification', 'holding other variables constant', 'suggests broader reach', 'warrants further investigation']) {
      expect(INTERPRETATION_SYSTEM_PROMPT).toContain(phrase)
    }
    for (const human of ["I wouldn't conclude", "We don't know yet whether the creative caused this", "one post isn't a pattern", 'brain_take', 'Zero is fine']) {
      expect(INTERPRETATION_SYSTEM_PROMPT).toContain(human)
    }
    expect(INTERPRETATION_SYSTEM_PROMPT).toContain('opening video visuals are not analysed yet')
  })
  it('the representative fixture copy is natural, not academic', () => {
    const text = `${TWO_REELS_V2_COPY.brain_take} ${TWO_REELS_V2_COPY.headline} ${TWO_REELS_V2_COPY.take} ${TWO_REELS_V2_COPY.next_move}`.toLowerCase()
    for (const robotic of ['tentative cue', 'cohort baseline', 'considerable margin', 'remains observational', 'external factors', 'difficult to isolate', 'statistically', 'algorithm', 'other variables', 'warrants further']) {
      expect(text).not.toContain(robotic)
    }
    expect(text).toMatch(/we don't know|isn't enough to tell us/)
    expect(() => validateInterpretation(twoReelsV2Output(exceptionalIds()), twoReelsSample().signals, [], facts)).not.toThrow()
  })
  it('no signals means no AI call and no take', async () => {
    expect(await callCreativeInterpretation([])).toEqual({ ok: true, brain_take: null, insights: [], model: null })
  })
})
