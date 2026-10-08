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

  it('labels evidence strength in plain words', () => {
    const all = render(storedStrategy({ output: validOutput({
      main_learnings: ['proven_pattern', 'reasonable_inference', 'weak_signal'].map((s, i) => ({ ...validOutput().main_learnings[0], title: `Learning number ${i + 1}`, evidence_strength: s as 'proven_pattern' })),
    }) }))
    for (const label of ['Proven pattern', 'Reasonable inference', 'Weak signal']) expect(all).toContain(label)
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
    expect(html).toContain('based on 9 posts with performance data (of 214 stored; the rest have no metrics)')
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

describe('inside the existing Marketing Brain', () => {
  it('appears after the coverage summary and before the existing observations', () => {
    const html = renderToStaticMarkup(<BrainView data={brain(full())} />)
    const at = (t: string) => html.indexOf(t)
    expect(at('Analysis coverage')).toBeGreaterThan(-1)
    expect(at('Organic strategy')).toBeGreaterThan(at('Analysis coverage'))
    expect(at('Organic strategy')).toBeLessThan(at('id="learning-title"')) // the existing observations section
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
