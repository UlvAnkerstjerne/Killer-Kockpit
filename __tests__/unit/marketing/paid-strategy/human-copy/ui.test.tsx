import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../../../helpers/paid-strategy'
import { HUMAN_COPY, NEW_RECS, REAL_RECS } from '../../../../helpers/paid-strategy-real-recs'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'

vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), resumeStrategyImplementation: vi.fn(), activateStrategyImplementation: vi.fn(), cancelStrategyImplementation: vi.fn(),
  rejectStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import PaidStrategySection from '@/app/(marketing)/marketing/brain/PaidStrategySection'
import { compactSummary } from '@/lib/marketing/paid-strategy/summary'

const withRecs = (id: string, recs: typeof NEW_RECS | typeof REAL_RECS) => { const r = run({ id }); r.recommendations = recs as never; return r }
const dataFor = (latest: ReturnType<typeof run>, previous: ReturnType<typeof run>[] = []): PaidStrategyData => ({ allowed: true, canGenerate: false, latest, previous, latestAttempt: null, error: null })
const render = (d: PaidStrategyData, impl?: Partial<StrategyImplementationData>) => renderToStaticMarkup(<PaidStrategySection data={d} implementations={impl ? { canApprove: true, views: [], error: null, ...impl } : undefined} />)
const cards = (html: string) => html.slice(0, html.indexOf('Previous runs') === -1 ? undefined : html.indexOf('Previous runs')).split('<article').slice(1).map(c => c.slice(0, c.indexOf('</article>')))
const outsideDetails = (c: string) => c.replace(/<details[\s\S]*?<\/details>/g, '')
const text = (c: string) => c.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")

describe('new runs: the card speaks plainly', () => {
  const html = render(dataFor(withRecs('run-1', NEW_RECS)), { canApprove: true })
  it('the collapsed card shows display_title and display_summary, not the technical title', () => {
    cards(html).forEach((c, i) => {
      const visible = text(outsideDetails(c))
      expect(visible).toContain(`${i + 1}. ${HUMAN_COPY[i].display_title}`); expect(visible).toContain(HUMAN_COPY[i].display_summary)
      expect(visible).not.toContain(REAL_RECS[i].title); expect(visible).not.toContain(compactSummary(REAL_RECS[i]).action!)
    })
  })
  it('the technical title and every detailed field stay under Read more, exactly as stored', () => {
    const clean = html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    cards(clean).forEach((c, i) => {
      const inside = c.slice(c.indexOf('<details')); const r = REAL_RECS[i]
      expect(inside).toContain('Full title'); expect(inside).toContain(r.title)
      for (const t of [r.evidence, r.interpretation, r.hypothesis, r.exact_test_or_action, r.success_metric, r.evidence_limitations]) expect(inside).toContain(t)
      for (const label of ['Facts · from our data', 'Interpretation · inference, not fact', 'Hypothesis', 'Test or action', 'Success metric', 'Evidence limitations']) expect(inside).toContain(label)
    })
  })
  it('the jargon-heavy technical wording is not in the collapsed card', () => {
    for (const c of cards(html)) expect(text(outsideDetails(c))).not.toMatch(/\bC[123]\b|\bCPM\b|funnel|conversion event|downstream|redemption|social-proof|headroom/i)
  })
  it('budget chip, Reject, Approve & implement and the Read more control stay visible on the collapsed card', () => {
    const third = outsideDetails(cards(html)[2])
    expect(third).toContain('+2,100 DKK test budget'); expect(third).toContain('>Reject</button>'); expect(third).toContain('Approve &amp; implement</button>')
    expect(cards(html)[0]).toContain('Read more'); expect(outsideDetails(cards(html)[0])).toContain('No extra spend')
  })
  it('implementation and rejection state stay visible, with the plain title above them', () => {
    const view: ImplementationView = { id: 'c', strategyRunId: 'run-1', recommendationIndex: 2, mode: 'campaign_creation', status: 'rejected', budgetReservedDkk: 0, error: null, approvedAt: 'x', blockers: [], message: null, review: null, linkedTaskId: null, rejectionReason: 'We do not want to run ads in Sweden for our catering offer.' }
    const third = outsideDetails(cards(render(dataFor(withRecs('run-1', NEW_RECS)), { views: [view] }))[2])
    expect(third).toContain('Rejected'); expect(third).toContain('We do not want to run ads in Sweden for our catering offer.'); expect(third).toContain('Give our Copenhagen awareness ads something measurable')
  })
})

describe('old runs keep rendering, unchanged and never rewritten', () => {
  const old = withRecs('run-1', REAL_RECS)
  it('fall back to the existing title and the deterministic summary', () => {
    cards(render(dataFor(old), { canApprove: true })).forEach((c, i) => {
      const visible = text(outsideDetails(c)); const s = compactSummary(REAL_RECS[i])
      expect(visible).toContain(`${i + 1}. ${REAL_RECS[i].title}`); expect(visible).toContain(s.action!); expect(visible).toContain(s.reason!)
      expect(c).not.toContain('Full title')
    })
  })
  it('a run with only one of the two display fields is treated as old (no half-human card)', () => {
    const half = withRecs('run-1', REAL_RECS.map(r => ({ ...r, display_title: 'Only a title here for sure' })) as never)
    expect(text(outsideDetails(cards(render(dataFor(half)))[0]))).toContain(REAL_RECS[0].title)
  })
  it('previous runs: old ones stay old, new ones use the plain copy, both collapsed with no actions', () => {
    const html = render(dataFor(withRecs('run-2', NEW_RECS), [withRecs('run-0', REAL_RECS), withRecs('run-9', NEW_RECS)]), { canApprove: true })
    const prev = html.slice(html.indexOf('Previous runs'), html.indexOf('Advisory only'))
    expect(prev).toContain(REAL_RECS[0].title); expect(prev).toContain(HUMAN_COPY[0].display_title)
    expect(prev).not.toContain('>Reject<'); expect(prev).not.toMatch(/<details[^>]*\sopen/)
  })
  it('rendering never mutates the stored recommendations', () => {
    const before = JSON.stringify([REAL_RECS, NEW_RECS]); render(dataFor(withRecs('run-1', NEW_RECS)), { canApprove: true }); render(dataFor(old)); expect(JSON.stringify([REAL_RECS, NEW_RECS])).toBe(before)
  })
})
