import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import BrainView from '@/app/(marketing)/marketing/brain/BrainView'
import OrganicStrategySection from '@/app/(marketing)/marketing/brain/OrganicStrategySection'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import { savedRun } from '../../../helpers/creative-brain'
import { storedStrategy, validOutput } from '../../../helpers/organic-strategy'

const render = (strategy: Parameters<typeof OrganicStrategySection>[0]['strategy'], canRefresh = true) =>
  renderToStaticMarkup(<OrganicStrategySection strategy={strategy} canRefresh={canRefresh} />)
const carousel = (n: number) => ({
  concept_title: `Carousel concept ${n}`, opening_slide: 'The question people ask first', slide_structure: ['The question', 'The usual answer', 'What we actually do'],
  why_this_is_worth_testing: 'Tests whether the subject travels as a read.', evidence_basis: 'P1: 90,000 views as a video.',
})
const full = () => storedStrategy({ output: validOutput({ carousel_concepts: [carousel(1), carousel(2)] }) })
const brain = (organic?: ReturnType<typeof storedStrategy>): BrainData => {
  const run = savedRun()
  return { allowed: true, canRefresh: true, latestAttempt: null, error: null, run: { ...run, analytics: { ...run.analytics!, ...(organic ? { organic_strategy: organic } : {}) } } }
}

describe('Organic strategy section: a completed strategy', () => {
  const html = render(full())

  it('presents the four parts in the requested hierarchy', () => {
    const order = ['Main learnings', 'Content opportunities', 'Reel concepts', 'Carousel concepts'].map(t => html.indexOf(`>${t}`))
    expect(order.every(i => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('shows evidence apart from inference for each learning, with the limits kept light', () => {
    expect(html).toContain('What happened')
    expect(html).toContain('What it may mean')
    expect(html).toContain('Limits: Eight measured videos only.')
    expect(html.indexOf('What happened')).toBeLessThan(html.indexOf('What it may mean'))
  })

  it('labels evidence strength in plain, modest words', () => {
    const all = render(storedStrategy({ output: validOutput({
      main_learnings: ['proven_pattern', 'reasonable_inference', 'weak_signal'].map((s, i) => ({ ...validOutput().main_learnings[0], title: `Learning number ${i + 1}`, evidence_strength: s as 'proven_pattern' })),
    }) }))
    for (const label of ['Strong repeated pattern', 'Reasonable inference', 'Weak signal']) expect(all).toContain(label)
    expect(all).not.toContain('Proven pattern') // small data must never read as proof
    expect(html).toContain('Weak signal') // the opportunity in the fixture
    expect(html).toContain('Reasonable inference')
  })

  it('makes Reel concepts actionable: the hook up front, then idea, execution and the reason to test', () => {
    expect(html).toContain('“Why does our chicken take a day and a half?”')
    for (const label of ['The idea', 'How to make it', 'Why test it']) expect(html).toContain(label)
    expect(html).toContain('Open on the question as the first spoken line.')
  })

  it('shows carousel opening slide and numbered slide structure', () => {
    expect(html).toContain('Opening slide')
    expect(html).toContain('<ol')
    expect(html).toContain('<li>What we actually do</li>')
    expect(html.match(/Carousel concept \d/g)).toHaveLength(2)
  })

  it('shows what each idea is based on', () => {
    expect(html).toContain('Based on: P1: 90,000 views, 700 shares.')
  })

  it('shows provenance: date, how many posts, the skill and the model', () => {
    expect(html).toMatch(/based on 9 posts with performance data, published 10 Jul 2026 to 20 Sep\w* 2026 \(of 214 stored; the rest have no metrics\)/)
    expect(html).toContain('claude-ig@2.0.0#5e9b2d9')
    expect(html).toContain('synthetic-model')
    expect(html).toContain('AI suggestions for human review')
  })

  it('has no action buttons: it is advice, not a workflow', () => {
    expect(html).not.toContain('<button')
  })

  it('lists the posts behind the references, linking only to real Instagram URLs', () => {
    expect(html).toContain('Posts behind these references (3)')
    expect(html).toContain('href="https://www.instagram.com/p/abc/"')
    expect(html).not.toContain('evil.example')
    expect(html).toContain('P = has performance data. U = no metrics')
  })

  it('escapes model text instead of rendering it as markup', () => {
    const o = validOutput()
    const xss = render(storedStrategy({ output: { ...o, main_learnings: [{ ...o.main_learnings[0], title: '<script>alert(1)</script> bad title', evidence: '<img src=x onerror=alert(1)> evidence text here' }] } }))
    expect(xss).not.toContain('<script>')
    expect(xss).not.toContain('<img')
    expect(xss).toContain('&lt;script&gt;')
  })
})

describe('Organic strategy section: empty lists and non-completed states', () => {
  it('omits an empty part and does not invent filler for it', () => {
    const html = render(storedStrategy({ output: validOutput({ carousel_concepts: [], content_opportunities: [], main_learnings: [] }) }))
    expect(html).toContain('>Reel concepts')
    expect(html).not.toContain('>Carousel concepts')
    expect(html).not.toContain('>Content opportunities')
    expect(html).not.toContain('>Main learnings')
  })

  it('says plainly when the data does not support any recommendation', () => {
    const html = render(storedStrategy({ output: { main_learnings: [], content_opportunities: [], reel_concepts: [], carousel_concepts: [] } }))
    expect(html).toContain('The data does not support a recommendation yet.')
  })

  it('shows an unavailable strategy without alarming, and offers retry only to those who can refresh', () => {
    const s = storedStrategy({ status: 'unavailable', output: null, message: 'Organic Strategy analysis failed. Please try again.' })
    const admin = render(s, true)
    expect(admin).toContain('role="alert"')
    expect(admin).toContain('Organic Strategy is unavailable for this run')
    expect(admin).toContain('Organic Strategy analysis failed. Please try again.')
    expect(admin).toContain('The rest of this page is unaffected. Refresh Creative Intelligence to try again.')
    const reader = render(s, false)
    expect(reader).toContain('The rest of this page is unaffected.')
    expect(reader).not.toContain('to try again')
  })

  it('explains a skipped strategy as a normal state', () => {
    const html = render(storedStrategy({ status: 'skipped', output: null, message: 'Organic Strategy needs at least 3 posts with performance metrics; 2 found.' }))
    expect(html).toContain('Not enough measured posts yet')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alert"')
  })

  it('handles a run created before Organic Strategy existed', () => {
    expect(render(undefined, true)).toContain('No Organic Strategy for this run yet')
    expect(render(undefined, true)).toContain('Refresh Creative Intelligence to generate it')
    expect(render(undefined, false)).toContain('A SUPER_ADMIN can generate it')
  })
})

describe('carousel concepts stay quiet when the carousel evidence is thin', () => {
  const withCarousels = (n: number) => storedStrategy({
    posts: [
      ...Array.from({ length: n }, (_, i) => ({ ref: `P${i + 1}`, published_at: '2026-09-20T10:00:00Z', media_type: 'CAROUSEL_ALBUM', permalink: null })),
      { ref: `P${n + 1}`, published_at: '2026-09-01T10:00:00Z', media_type: 'VIDEO', permalink: null },
    ],
    output: validOutput({ carousel_concepts: [carousel(1)] }),
  })
  it('marks carousel ideas exploratory, says why, and drops the accent border, when fewer than 5 carousels are measured', () => {
    const html = render(withCarousels(1))
    expect(html).toContain('Exploratory: only 1 carousel has performance data, too few to show how the format performs.')
    expect(html).toContain('>Exploratory<')
    const card = html.slice(html.indexOf('Carousel concept 1') - 200, html.indexOf('Carousel concept 1'))
    expect(card).toContain('border-kk-line')
    expect(card).not.toContain('border-kk-brand/40')
  })
  it('treats measured carousels only: unmeasured (U) references do not count as evidence', () => {
    const html = render(storedStrategy({
      posts: [{ ref: 'P1', published_at: '2026-09-20T10:00:00Z', media_type: 'VIDEO', permalink: null },
        ...Array.from({ length: 6 }, (_, i) => ({ ref: `U${i + 1}`, published_at: '2026-09-01T10:00:00Z', media_type: 'CAROUSEL_ALBUM', permalink: null }))],
      output: validOutput({ carousel_concepts: [carousel(1)] }),
    }))
    expect(html).toContain('Exploratory: only 0 carousels have performance data')
  })
  it('keeps exploratory carousel ideas collapsed by default, so they never outweigh the Reels', () => {
    const html = render(withCarousels(1))
    const details = html.match(/<details[^>]*>(?:(?!<\/details>)[\s\S])*Carousel concepts/)?.[0] ?? ''
    expect(details).toContain('border-dashed')
    expect(details).not.toMatch(/<details[^>]*\sopen/)
    expect(html).toContain('Carousel concept 1') // still present for anyone who expands it
  })
  it('gives carousel ideas full prominence once there is a real carousel baseline (5 or more measured)', () => {
    const html = render(withCarousels(5))
    expect(html).not.toContain('Exploratory')
    expect(html).not.toContain('border-dashed bg-kk-panel/60') // no collapsed wrapper
    expect(html).toContain('border-kk-brand/40')
  })
  it('never lets carousels outweigh Reels in the page order', () => {
    const html = render(storedStrategy({ output: validOutput({ carousel_concepts: [carousel(1), carousel(2), carousel(3)] }) }))
    expect(html.indexOf('>Reel concepts')).toBeLessThan(html.indexOf('>Carousel concepts'))
  })
})

describe('inside the combined Marketing Brain (v2 + Organic Strategy)', () => {
  it('reads in order: coverage, what the evidence says (Brain v2), what to make next (Organic Strategy), then the deeper evidence', () => {
    const html = renderToStaticMarkup(<BrainView data={brain(full())} />)
    const at = (t: string) => html.indexOf(t)
    const order = [at('Analysis coverage'), at('id="learning-title"'), at('id="organic-strategy-title"'), at('Best hooks'), at('Format performance')]
    expect(order.every(i => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('tells the two layers apart with one short line each, not an essay', () => {
    const html = renderToStaticMarkup(<BrainView data={brain(full())} />)
    expect(html).toContain('What the evidence says')
    expect(html).toContain('What to make next')
    expect(html.indexOf('What the evidence says')).toBeLessThan(html.indexOf('What to make next'))
  })

  it('has exactly one "Brain\u2019s take": Organic Strategy does not compete with it', () => {
    const data = brain(full())
    const html = renderToStaticMarkup(<BrainView data={{ ...data, run: { ...data.run!, analytics: { ...data.run!.analytics!, brain_take: 'Debate-style Reels travelled furthest.' } } }} />)
    expect(html).toContain('Debate-style Reels travelled furthest.')
    expect(html.match(/<section aria-label="Brain(&#x27;|')s take"/g)).toHaveLength(1) // v2's single component
    expect(html.match(/>Brain’s take</g)).toHaveLength(1) // its one visible label
    const organic = html.slice(html.indexOf('id="organic-strategy-title"'), html.indexOf('Best hooks'))
    expect(organic).not.toMatch(/Brain(&#x27;|')s take|Brain’s take/) // nothing inside Organic Strategy competes with it
  })

  it('keeps every existing Creative Intelligence section visible alongside it', () => {
    const html = renderToStaticMarkup(<BrainView data={brain(full())} />)
    for (const text of ['What we’re learning', 'Best hooks', 'Best themes', 'Best products', 'Format performance', 'lifetime performance']) expect(html, text).toContain(text)
  })

  it('renders an existing run with no organic_strategy exactly as before, plus a gentle placeholder', () => {
    const before = renderToStaticMarkup(<BrainView data={brain()} />)
    for (const text of ['What we’re learning', 'Best hooks', 'Format performance']) expect(before, text).toContain(text)
    expect(before).toContain('No Organic Strategy for this run yet')
    expect(before).not.toContain('role="alert"')
  })

  it('still shows the strategy when the interpretation or classification was only partial', () => {
    const data = brain(full())
    const partial = renderToStaticMarkup(<BrainView data={{ ...data, run: { ...data.run!, status: 'partial', error: 'Interpretation unavailable.' } }} />)
    expect(partial).toContain('Organic strategy')
    expect(partial).toContain('Main learnings')
  })

  it('shows an unavailable strategy next to a fully intact Creative Intelligence', () => {
    const html = renderToStaticMarkup(<BrainView data={brain(storedStrategy({ status: 'unavailable', output: null, message: 'Organic Strategy analysis failed. Please try again.' }))} />)
    expect(html).toContain('Organic Strategy is unavailable for this run')
    expect(html).toContain('Best hooks')
    expect(html).toContain('Format performance')
  })
})

describe('the evidence window is explicit', () => {
  it('shows the publication dates of the evidence, which may be older than the Brain\'s 90-day window', () => {
    const html = render(storedStrategy({ evidence_window: { first_published: '2026-06-23', last_published: '2026-09-30', as_of: '2026-10-08' } }))
    expect(html).toContain('published 23 Jun 2026 to 30 Sep')
  })
  it('handles a single date and an absent window without breaking the line', () => {
    expect(render(storedStrategy({ evidence_window: { first_published: '2026-06-23', last_published: '2026-06-23', as_of: '2026-10-08' } }))).toContain('published 23 Jun 2026 (of')
    expect(render(storedStrategy({ evidence_window: { first_published: null, last_published: null, as_of: '2026-10-08' } }))).toContain('with performance data (of 214 stored')
  })
})
