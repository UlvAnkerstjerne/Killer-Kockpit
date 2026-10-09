import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../../../helpers/paid-strategy'
import { REAL_RECS } from '../../../../helpers/paid-strategy-real-recs'
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

const latest = run({ id: 'run-1' }); latest.recommendations = REAL_RECS
const previous = run({ id: 'run-0', generated_at: '2026-09-01T10:00:00Z' }); previous.recommendations = REAL_RECS
const data: PaidStrategyData = { allowed: true, canGenerate: false, latest, previous: [previous], latestAttempt: null, error: null }
const view = (over: Partial<ImplementationView> = {}): ImplementationView => ({ id: 'i1', strategyRunId: 'run-1', recommendationIndex: 2, mode: 'campaign_creation', status: 'waiting_for_access', budgetReservedDkk: 0, error: null, approvedAt: 'x', blockers: [], message: null, review: null, linkedTaskId: null, ...over })
const render = (implementations?: Partial<StrategyImplementationData>, d: PaidStrategyData = data) => renderToStaticMarkup(
  <PaidStrategySection data={d} implementations={implementations ? { canApprove: true, views: [], error: null, ...implementations } : undefined} />)
/** The first three cards (the latest run), as separate strings. */
const cards = (html: string) => html.slice(0, html.indexOf('Previous runs')).split('<article').slice(1).map(c => c.slice(0, c.indexOf('</article>')))
const outsideDetails = (card: string) => card.replace(/<details[\s\S]*?<\/details>/g, '')

describe('collapsed by default', () => {
  it('every detailed section sits inside a closed <details>, not in the visible card', () => {
    const html = render({ canApprove: true })
    expect(cards(html)).toHaveLength(3)
    for (const c of cards(html)) {
      expect(c).toMatch(/<details class="group[^"]*">/); expect(c).not.toMatch(/<details[^>]*\sopen/)
      const visible = outsideDetails(c)
      for (const label of ['Facts · from our data', 'Interpretation · inference, not fact', 'Hypothesis', 'Test or action', 'Extra budget needed', 'Success metric', 'Evidence limitations']) {
        expect(visible, label).not.toContain(label); expect(c, label).toContain(label)
      }
    }
  })
  it('keeps the number, the title and the type chip, and adds the compact summary', () => {
    const [first, , third] = cards(render({ canApprove: true }))
    const visible = outsideDetails(first)
    expect(visible).toContain('1. Add a measurable conversion event'); expect(visible).toContain('Tracking')
    const { action, reason } = compactSummary(REAL_RECS[0])
    expect(visible).toContain(action!); expect(visible.replace(/<[^>]+>/g, '')).toContain(reason!)
    expect(outsideDetails(third)).toContain('Create a new leads-objective campaign targeting the Malmö metro area')
    expect(visible.replace(/<[^>]+>/g, '').length).toBeLessThan(first.replace(/<[^>]+>/g, '').length / 2) // far shorter than the full card
  })
})

describe('Read more', () => {
  it('is a native, keyboard-accessible <details>/<summary> that swaps Read more for Show less when open, and each card has its own', () => {
    const html = render({ canApprove: true })
    for (const c of cards(html)) {
      expect(c.match(/<summary/g)).toHaveLength(1)
      expect(c).toContain('group-open:hidden">Read more</span>'); expect(c).toContain('hidden group-open:inline">Show less</span>')
    }
    expect(cards(html).join('').match(/<details/g)).toHaveLength(3)
  })
  it('reveals every existing field with the stored text exactly, including the budget line', () => {
    const html = render({ canApprove: true }).replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    for (const [i, c] of cards(html).entries()) {
      const r = REAL_RECS[i]; const inside = c.slice(c.indexOf('<details'))
      for (const text of [r.evidence, r.interpretation, r.hypothesis, r.exact_test_or_action, r.success_metric, r.evidence_limitations]) expect(inside).toContain(text)
      expect(inside).toContain(r.incremental_budget_dkk! > 0 ? '2,100 DKK on top of existing spend' : 'None (no extra spend)')
    }
  })
  it('the recommendation data itself is unchanged by rendering', () => {
    const before = JSON.stringify(REAL_RECS); render({ canApprove: true }); expect(JSON.stringify(REAL_RECS)).toBe(before)
  })
})

describe('budget indicator', () => {
  it('shows +2,100 DKK test budget when extra budget is involved, and a quiet "No extra spend" when not', () => {
    const [first, second, third] = cards(render({ canApprove: true }))
    expect(outsideDetails(third)).toContain('+2,100 DKK test budget'); expect(outsideDetails(third)).not.toContain('No extra spend')
    for (const c of [first, second]) { expect(outsideDetails(c)).toContain('No extra spend'); expect(outsideDetails(c)).not.toContain('test budget') }
  })
  it('older rows without the budget field show no indicator at all', () => {
    const old = run({ id: 'run-1' }); old.recommendations = REAL_RECS.map(({ incremental_budget_dkk: _x, ...r }) => r)
    expect(render({ canApprove: true }, { ...data, latest: old, previous: [] })).not.toMatch(/No extra spend<\/span>|test budget/)
  })
})

describe('actions and state stay visible while collapsed', () => {
  it('Reject and Approve & implement are outside Read more, Reject first', () => {
    for (const c of cards(render({ canApprove: true }))) {
      const visible = outsideDetails(c)
      expect(visible).toContain('>Reject</button>'); expect(visible).toContain('Approve &amp; implement</button>')
      expect(visible.indexOf('>Reject</button>')).toBeLessThan(visible.indexOf('Approve &amp; implement</button>'))
    }
    expect(render({ canApprove: false })).not.toContain('>Reject<')
  })
  it('the implementation state is visible without opening anything: blocked, ready to activate, rejected', () => {
    const blocked = cards(render({ views: [view({ blockers: [{ kind: 'access', code: 'c', message: 'Kockpit cannot see bookings.', unblock: 'Say where bookings are recorded.' }] })] }))[2]
    expect(outsideDetails(blocked)).toContain('Blocked — needs access: Kockpit cannot see bookings.'); expect(outsideDetails(blocked)).toContain('Say where bookings are recorded.')
    const ready = cards(render({ views: [view({ status: 'ready_to_activate', budgetReservedDkk: 2100, review: { kind: 'campaign', title: 'T', lines: [], notes: [] } })] }))[2]
    expect(outsideDetails(ready)).toContain('Ready to activate'); expect(outsideDetails(ready)).toContain('2,100 DKK reserved'); expect(outsideDetails(ready)).toContain('Review &amp; activate')
    const rejected = cards(render({ views: [view({ status: 'rejected', rejectionReason: 'We do not want to run ads in Sweden for our catering offer.', metaObjectsExist: true })] }))[2]
    expect(outsideDetails(rejected)).toContain('Rejected'); expect(outsideDetails(rejected)).toContain('We do not want to run ads in Sweden for our catering offer.')
    expect(outsideDetails(rejected)).not.toContain('Approve &amp; implement')
  })
})

describe('previous runs and layout', () => {
  it('previous runs use the same compact cards, collapsed, with no actions', () => {
    const html = render({ canApprove: true }); const prev = html.slice(html.indexOf('Previous runs'), html.indexOf('Advisory only'))
    expect(prev.match(/<article/g)).toHaveLength(3); expect(prev.match(/data-summary/g)).toHaveLength(3); expect(prev.match(/Read more<\/span>/g)).toHaveLength(3)
    expect(prev).not.toContain('>Reject<'); expect(prev).not.toContain('Approve &amp; implement'); expect(prev).not.toMatch(/<details[^>]*\sopen/)
  })
  it('keeps the three-column desktop grid without forcing equal heights, and a single column below it (no fixed widths)', () => {
    const html = render({ canApprove: true })
    expect(html).toContain('grid items-start gap-4 lg:grid-cols-3')
    expect(html).not.toMatch(/\bw-\[\d|min-w-\[|whitespace-nowrap/)
  })
})
