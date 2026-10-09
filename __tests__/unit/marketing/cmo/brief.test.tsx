import React from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../../helpers/paid-strategy'
import { HUMAN_COPY, NEW_RECS, REAL_RECS } from '../../../helpers/paid-strategy-real-recs'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { ImplementationStatus, ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), resumeStrategyImplementation: vi.fn(), activateStrategyImplementation: vi.fn(), cancelStrategyImplementation: vi.fn(),
  rejectStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn(),
}))
vi.mock('@/lib/actions/marketing/gbp-review-desk', () => ({ getGbpReviewDesk: vi.fn(), getSavedGbpReviews: vi.fn() }))
vi.mock('@/lib/actions/marketing/morning-brief', () => ({ getLatestMorningBrief: vi.fn(), getLastReadyMorningBrief: vi.fn() }))
vi.mock('@/lib/actions/marketing/platform-snapshot', () => ({ getPlatformSnapshot: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
import { MorningBriefContent } from '@/app/(marketing)/marketing/page'
import PaidStrategySection from '@/app/(marketing)/marketing/brain/PaidStrategySection'
import { cmoBriefData } from '@/lib/marketing/paid-strategy/implementation/surface'

const strategyRun = (id: string, recs: typeof NEW_RECS | typeof REAL_RECS) => { const r = run({ id }); r.recommendations = recs as never; return r }
const strategy = (over: Partial<PaidStrategyData> = {}): PaidStrategyData => ({ allowed: true, canGenerate: false, latest: strategyRun('run-1', NEW_RECS), previous: [strategyRun('run-0', REAL_RECS.map(r => ({ ...r, title: `Previous-run idea: ${r.title}` })) as never)], latestAttempt: null, error: null, ...over })
const view = (index: number, status: ImplementationStatus, over: Partial<ImplementationView> = {}): ImplementationView => ({ id: `i${index}`, strategyRunId: 'run-1', recommendationIndex: index, mode: 'campaign_creation', status, budgetReservedDkk: 0, error: null, approvedAt: 'x', blockers: [], message: null, review: null, linkedTaskId: null, ...over })
const impl = (views: ImplementationView[] = [], over: Partial<StrategyImplementationData> = {}): StrategyImplementationData => ({ canApprove: true, views, error: null, ...over })

const obs = { signal_id: 's1', category: 'paid', source: 'meta_paid', observation: 'Spend is on pace', evidence: 'Yesterday matched the weekly average.', interpretation: 'Nothing unusual.', recommended_action: 'No action needed.', creative_start: null }
const sections = { observations: [obs], needs_review: { total: 0, items: [] }, paid: { anomalies: [], assessment: 'ok', active_campaign_summaries: [] }, organic: { assessment: 'ok', ig: { metrics: [], notable_posts: [] }, fb: { available: false, metrics: [] } }, gbp: { assessment: 'ok', integration_kind: 'connected', new_reviews_yesterday: null, avg_star_rating_7d: null, pending_reply_count: 0 }, content: {} } as never
const brief = { id: 'b', brief_date: '2026-10-09', status: 'ready', overall_status: null, overall_reason: null, ai_summary: null, sections_json: sections, generated_at: '2026-10-09T06:00:00Z' } as never
const render = (s: PaidStrategyData, i: StrategyImplementationData | null) => renderToStaticMarkup(<MorningBriefContent brief={brief} snapshot={null} cmo={cmoBriefData(s, i)} />)
const cmoPart = (html: string) => { const a = html.indexOf('data-cmo-recommendations'); return a < 0 ? '' : html.slice(a, html.indexOf('</section>', a)) }
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
const outside = (c: string) => c.replace(/<details[\s\S]*?<\/details>/g, '')

describe('placement', () => {
  it('CMO recommendations render directly beneath "What\'s happening?" and above the rest of the brief', () => {
    const html = render(strategy(), impl())
    const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => text(m[1]))
    expect(headings.slice(0, 3)).toEqual(["What's happening?", 'CMO recommendations', 'Details'])
    const between = html.slice(html.indexOf("happening?"), html.indexOf('data-cmo-recommendations'))
    expect(between).toContain('Spend is on pace') // the observations come first, nothing else is wedged in between
    expect(between).not.toContain('Needs Review'); expect(between.match(/<h2/g)).toBeNull() // no other section heading sits between them
  })
  it('has a subtle "Open CMO" link to the unchanged /marketing/brain route', () => {
    expect(cmoPart(render(strategy(), impl()))).toMatch(/<a href="\/marketing\/brain"[^>]*>Open CMO →<\/a>/)
  })
})

describe('what is shown', () => {
  it('only the latest completed Paid Strategy, never previous-run recommendations', () => {
    const part = cmoPart(render(strategy(), impl()))
    expect(part.match(/<article/g)).toHaveLength(3)
    expect(part).not.toContain('Previous-run idea')
    const only = strategy({ latest: strategyRun('run-1', NEW_RECS.slice(0, 1) as never) })
    expect(cmoPart(render(only, impl())).match(/<article/g)).toHaveLength(1)
  })
  it('shows the plain display title and summary, the type chip and the budget chip', () => {
    const cards = cmoPart(render(strategy(), impl())).split('<article').slice(1)
    cards.forEach((c, i) => { const v = text(outside(c)); expect(v).toContain(HUMAN_COPY[i].display_title); expect(v).toContain(HUMAN_COPY[i].display_summary) })
    expect(text(outside(cards[0]))).toContain('Tracking'); expect(text(outside(cards[2]))).toContain('+2,100 DKK test budget'); expect(text(outside(cards[0]))).toContain('No extra spend')
  })
  it('keeps the full technical detail behind Read more', () => {
    const c = cmoPart(render(strategy(), impl())).replace(/&#x27;/g, "'").split('<article').slice(1)[0]
    expect(outside(c)).not.toContain('Evidence limitations'); const inside = c.slice(c.indexOf('<details'))
    for (const t of [REAL_RECS[0].title, REAL_RECS[0].evidence, REAL_RECS[0].exact_test_or_action, REAL_RECS[0].evidence_limitations, 'Facts · from our data', 'Success metric']) expect(inside).toContain(t)
    expect(c).toContain('Read more')
  })
  it('old runs without display fields still render through the existing fallback', () => {
    const old = strategy({ latest: strategyRun('run-1', REAL_RECS) })
    expect(cmoPart(render(old, impl()))).toContain(REAL_RECS[0].title)
  })
})

describe('actions and permissions', () => {
  it('approvers get Reject and Approve & implement on a fresh recommendation, without leaving the Brief', () => {
    const c = cmoPart(render(strategy(), impl([]))).split('<article').slice(1)
    for (const card of c) { const v = outside(card); expect(v).toContain('>Reject</button>'); expect(v).toContain('Approve &amp; implement</button>'); expect(v.indexOf('>Reject</button>')).toBeLessThan(v.indexOf('Approve &amp; implement</button>')) }
  })
  it('a reader who cannot approve sees the recommendations but gets no action controls', () => {
    const part = cmoPart(render(strategy(), impl([], { canApprove: false })))
    expect(part.match(/<article/g)).toHaveLength(3); expect(part).not.toContain('>Reject<'); expect(part).not.toContain('Approve &amp; implement')
  })
  it('someone without Paid Strategy access gets no section at all', () => {
    for (const html of [render(strategy({ allowed: false, latest: null }), impl()), render(strategy(), null), render(strategy(), impl([], { error: 'x' })), render(strategy({ error: 'x' }), impl())]) expect(html).not.toContain('CMO recommendations')
  })
})

describe('which states stay and which go', () => {
  const shown = (views: ImplementationView[]) => cmoPart(render(strategy(), impl(views))).match(/<article/g)?.length ?? 0
  it('a rejected recommendation disappears immediately', () => {
    expect(shown([view(2, 'rejected', { rejectionReason: 'No' })])).toBe(2)
    expect(cmoPart(render(strategy(), impl([view(2, 'rejected')])))).not.toContain(HUMAN_COPY[2].display_title)
  })
  it.each(['in_motion', 'completed', 'cancelled', 'started'] as const)('%s needs no decision, so it is not kept', status => { expect(shown([view(1, status)])).toBe(2) })
  it.each(['waiting_for_access', 'waiting_for_input', 'needs_attention', 'needs_input', 'prepared', 'failed', 'approved', 'executing'] as const)('%s stays, with its current state', status => {
    const part = cmoPart(render(strategy(), impl([view(1, status, { blockers: status === 'waiting_for_access' ? [{ kind: 'access', code: 'c', message: 'Kockpit cannot see bookings.', unblock: 'Say where bookings are recorded.' }] : [] })])))
    expect(part.match(/<article/g)).toHaveLength(3)
  })
  it('ready to activate still surfaces with its existing activation control and reservation', () => {
    const part = cmoPart(render(strategy(), impl([view(2, 'ready_to_activate', { budgetReservedDkk: 2100, review: { kind: 'campaign', title: 'T', lines: [], notes: [] } })])))
    const third = part.split('<article').slice(1)[2]
    expect(outside(third)).toContain('Ready to activate'); expect(outside(third)).toContain('2,100 DKK reserved'); expect(outside(third)).toContain('Review &amp; activate')
  })
  it('only the hidden ones vanish: with everything settled the whole section is omitted, with no empty-state card', () => {
    const html = render(strategy(), impl([view(0, 'rejected'), view(1, 'completed'), view(2, 'in_motion')]))
    expect(html).not.toContain('CMO recommendations'); expect(html).not.toContain('data-cmo-recommendations');     expect(html).toContain("What&#x27;s happening?")
  })
  it('a view from another run never hides a recommendation of the latest run', () => {
    expect(shown([view(0, 'rejected', { strategyRunId: 'run-0' })])).toBe(3)
  })
})

describe('one source of truth with the CMO page', () => {
  it('the Brief and the CMO page render the very same card for the same recommendation and state', () => {
    const i = impl([view(2, 'waiting_for_access')]); const s = strategy()
    const brief3 = cmoPart(render(s, i)).split('<article').slice(1)[2].split('</article>')[0]
    const cmo = renderToStaticMarkup(<PaidStrategySection data={s} implementations={i} />).split('<article').slice(1)[2].split('</article>')[0]
    expect(brief3).toBe(cmo)
  })
  it('both surfaces use the one RecommendationCard and the one ImplementationControl; there is no second approval path', () => {
    const read = (p: string) => readFileSync(p, 'utf8')
    expect(read('app/(marketing)/marketing/CmoRecommendations.tsx')).toContain("from './brain/PaidStrategyCard'")
    expect(read('app/(marketing)/marketing/brain/PaidStrategySection.tsx')).toContain("from './PaidStrategyCard'")
    expect(read('app/(marketing)/marketing/brain/PaidStrategyCard.tsx')).toContain("import ImplementationControl from './ImplementationControl'")
    expect(read('app/(marketing)/marketing/CmoRecommendations.tsx')).not.toMatch(/use server|createServiceClient|\.rpc\(|StrategyImplementation\(/)
  })
  it('actions refresh both pages, and read the same server-side state (getPaidStrategy / getStrategyImplementations)', () => {
    const a = readFileSync('lib/actions/marketing/paid-strategy-implementation.ts', 'utf8')
    expect(a).toContain("revalidatePath('/marketing/brain')"); expect(a).toContain("revalidatePath('/marketing')")
    const page = readFileSync('app/(marketing)/marketing/page.tsx', 'utf8')
    expect(page).toContain('getPaidStrategy()'); expect(page).toContain('getStrategyImplementations()')
  })
})

describe('the Morning Brief itself is untouched', () => {
  it('no JSON or schema change: recommendations are not part of the stored sections, the generator or any migration', () => {
    const types = readFileSync('lib/marketing/brief/types.ts', 'utf8')
    expect(types).not.toMatch(/cmo|paid_strategy|display_title/i)
    for (const f of ['lib/marketing/brief/generate-brief.ts']) if (existsSync(f)) expect(readFileSync(f, 'utf8')).not.toMatch(/paid[-_]strategy|cmo/i)
    expect(Object.keys((sections as unknown as Record<string, unknown>)).sort()).toEqual(['content', 'gbp', 'needs_review', 'observations', 'organic', 'paid'])
  })
})

describe('layout', () => {
  it('desktop: up to three cards in one row; mobile: one column, no fixed widths or horizontal scrolling', () => {
    const part = cmoPart(render(strategy(), impl()))
    expect(part).toContain('grid items-start gap-4 grid-cols-1 lg:grid-cols-3')
    expect(part).not.toMatch(/\bw-\[\d|min-w-\[|whitespace-nowrap|overflow-x-(auto|scroll)/)
  })
})

describe('CMO rename and navigation', () => {
  const shell = readFileSync('components/layout/MarketingShell.tsx', 'utf8')
  const nav = [...shell.slice(shell.indexOf('const MARKETING_NAV'), shell.indexOf('] as const')).matchAll(/href: '([^']+)',\s+label: '([^']+)'/g)].map(m => [m[1], m[2]])
  it('the nav label is CMO and it sits directly beneath Morning Brief, in the requested order', () => {
    expect(nav.map(n => n[1])).toEqual(['Morning Brief', 'CMO', 'Needs Review', 'Paid', 'Organic', 'Google', 'Google Business Profile', 'Content', 'Creative Studio'])
    expect(shell).not.toContain("label: 'Marketing Brain'")
  })
  it('the route is unchanged: CMO still points at /marketing/brain and the page still lives there', () => {
    expect(nav.find(n => n[1] === 'CMO')![0]).toBe('/marketing/brain'); expect(existsSync('app/(marketing)/marketing/brain/page.tsx')).toBe(true)
    expect(readFileSync('app/(marketing)/marketing/brain/page.tsx', 'utf8')).toContain("title: 'CMO | Killer Kockpit'")
  })
})
