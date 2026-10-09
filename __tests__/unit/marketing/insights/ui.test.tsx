import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { InsightsData } from '@/lib/actions/marketing/insights'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/actions/marketing/insights', () => ({ getMarketingInsights: vi.fn(), captureMarketingInsights: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), resumeStrategyImplementation: vi.fn(), activateStrategyImplementation: vi.fn(),
  cancelStrategyImplementation: vi.fn(), rejectStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn(),
}))
vi.mock('@/lib/actions/marketing/gbp-review-desk', () => ({ getGbpReviewDesk: vi.fn(), getSavedGbpReviews: vi.fn() }))
vi.mock('@/lib/actions/marketing/morning-brief', () => ({ getLatestMorningBrief: vi.fn(), getLastReadyMorningBrief: vi.fn() }))
vi.mock('@/lib/actions/marketing/platform-snapshot', () => ({ getPlatformSnapshot: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
import InsightsSection from '@/app/(marketing)/marketing/brain/InsightsSection'
import BrainView from '@/app/(marketing)/marketing/brain/BrainView'
import BriefInsights from '@/app/(marketing)/marketing/BriefInsights'
import { MorningBriefContent } from '@/app/(marketing)/marketing/page'
import { selectBriefInsights } from '@/lib/marketing/insights/brief'
import { cmoBriefData } from '@/lib/marketing/paid-strategy/implementation/surface'
import { day, insightView, paidRunAt } from '../../../helpers/insights'

const strategy = (): PaidStrategyData => ({ allowed: true, canGenerate: false, latest: paidRunAt('p1', day(9)), previous: [], latestAttempt: null, error: null })
const impl = (views: StrategyImplementationData['views'] = []): StrategyImplementationData => ({ canApprove: true, views, error: null })
const data = (insights = [insightView()], over: Partial<InsightsData> = {}): InsightsData => ({ allowed: true, canCapture: false, insights, error: null, ...over })
const render = (d: InsightsData, s = strategy(), i = impl()) => renderToStaticMarkup(<InsightsSection data={d} strategy={s} implementations={i} />)
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('CMO page Insights section', () => {
  it('renders nothing without access, and nothing for a non-admin when there are no insights', () => {
    expect(render(data([], { allowed: false }))).toBe('')
    expect(render(data([]))).toBe('')
  })
  it('lets a SUPER_ADMIN capture from saved runs when there are none yet, and explains why', () => {
    const html = render(data([], { canCapture: true }))
    expect(html).toContain('data-cmo-insights')
    expect(html).toContain('Capture insights from saved runs')
    expect(text(html)).toMatch(/saved automatically after the next Paid Strategy or Creative Intelligence analysis/)
  })
  it('shows a storage problem only to the SUPER_ADMIN, and never as a crash', () => {
    expect(render(data([], { canCapture: true, error: 'Insights storage is unavailable. Confirm the migration is activated.' }))).toContain('Confirm the migration is activated')
    expect(render(data([], { error: 'Insights storage is unavailable.' }))).toBe('')
  })
  it('groups findings, content opportunities and retargeting hypotheses, each with strength and trend', () => {
    const html = render(data([
      insightView({ id: 'a', title: 'Explaining a step drives shares', strength: 'reasonable_inference', trend: 'strengthening' }),
      insightView({ id: 'b', kind: 'content_opportunity', title: 'Revisit the marinade', suggestion: 'Show the surprising step first.', strength: 'weak_signal', trend: 'new' }),
      insightView({ id: 'c', domain: 'paid', kind: 'retargeting_hypothesis', scope_key: 'paid:retargeting_hypothesis:retargeting', title: 'Reel viewers may convert cheaper', strength: 'hypothesis', trend: 'new' }),
    ]))
    const t = text(html)
    expect(t).toMatch(/What we’ve learned.*Content opportunities.*Retargeting hypotheses/)
    expect(t).toContain('Reasonable inference'); expect(t).toContain('Gaining support')
    expect(t).toContain('Weak signal'); expect(t).toContain('Untested hypothesis')
    expect(html.match(/<article data-insight/g)).toHaveLength(3)
  })
  it('keeps a creative suggestion apart from the finding, labelled as an idea and not a result', () => {
    const t = text(render(data([insightView({ kind: 'content_opportunity', suggestion: 'Show the surprising step first.' })])))
    expect(t).toContain('Suggested angle · an idea to try, not a result')
    expect(t).toContain('Show the surprising step first.')
    expect(text(render(data([insightView()])))).not.toContain('Suggested angle')
  })
  it('says plainly that retargeting hypotheses cannot be checked against stored audience data', () => {
    const t = text(render(data([insightView({ domain: 'paid', kind: 'retargeting_hypothesis', strength: 'hypothesis' })])))
    expect(t).toMatch(/Audience and targeting data are not stored, so these cannot be checked against current data/)
    expect(t).toMatch(/untested hypothesis, not an observed result/)
  })
  it('separates evidence from uncertainty and shows inspectable sources, linking only to Instagram', () => {
    const html = render(data([insightView({
      evidence_text: 'P1 reached 90,000 views and 700 shares.', limitations: 'Eight measured videos only.',
      refs: [
        { type: 'instagram_post', ref: 'P1', permalink: 'https://www.instagram.com/p/abc/', published_at: day(2), media_type: 'VIDEO' },
        { type: 'instagram_post', ref: 'U1', permalink: 'https://evil.example/p/x', published_at: day(3), media_type: 'VIDEO' },
        { type: 'creative_signal', signal_id: 'x', sample_size: 8, evidence_level: 'supported' },
      ],
    })]))
    const t = text(html)
    expect(t).toMatch(/Evidence · from our data P1 reached 90,000 views and 700 shares\./)
    expect(t).toMatch(/Uncertainty Eight measured videos only\./)
    expect(html).toContain('href="https://www.instagram.com/p/abc/"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('evil.example')
    expect(t).toContain('Creative signal · 8 posts · supported')
  })
  it('shows how an insight has changed: first seen, how often, last supported, and misses', () => {
    const t = text(render(data([insightView({
      times_observed: 3, runs_since_seen: 1, trend: 'unconfirmed', first_seen_at: day(1), last_supported_at: day(8),
      history: [{ observed_at: day(8), strength: 'weak_signal', change: 'weakened' }, { observed_at: day(1), strength: 'reasonable_inference', change: 'new' }],
    })])))
    expect(t).toMatch(/First seen 1 Oct 2026 · seen in 3 runs · last supported 8 Oct 2026 · not reproduced in the last 1 run/)
    expect(t).toMatch(/Weak signal · weakened/)
    expect(t).toContain('Not seen in the latest run')
  })
  it('keeps stale insights available but out of the way', () => {
    const html = render(data([insightView({ id: 's', status: 'stale', title: 'An old idea' })]))
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Not seen recently \(1\)/)
    expect(text(html)).toContain('An old idea')
  })
  it('links an insight to the recommendation it came from, with that recommendation’s live decision state', () => {
    const run = strategy().latest!
    const links = [{ target_type: 'paid_strategy_recommendation' as const, target_run_id: 'p1', target_index: 1, relation: 'derived_from' as const }]
    const undecided = text(render(data([insightView({ domain: 'paid', links })])))
    expect(undecided).toContain(`Behind recommendation: ${run.recommendations[1].display_title}`)
    expect(undecided).toContain('Not decided yet')
    const view = { id: 'v', strategyRunId: 'p1', recommendationIndex: 1, mode: 'campaign_creation', status: 'rejected', budgetReservedDkk: 0, error: null, approvedAt: null, blockers: [], message: null, review: null, linkedTaskId: null } as never
    expect(text(render(data([insightView({ domain: 'paid', links })]), strategy(), impl([view])))).not.toContain('Not decided yet')
  })
  it('shortens a long statement on the card but keeps the full text in the details', () => {
    const long = `${'A long interpretation sentence. '.repeat(30)}END-MARKER`
    const html = render(data([insightView({ statement: long })]))
    const card = html.slice(html.indexOf('data-statement'), html.indexOf('<details'))
    expect(card).not.toContain('END-MARKER')
    expect(card).toContain('…')
    expect(text(html)).toMatch(/Full statement.*END-MARKER/)
    expect(text(render(data([insightView({ statement: 'Short statement.' })])))).not.toContain('Full statement')
  })
  it('never copies recommendation or action controls into an insight', () => {
    const html = render(data([insightView({ domain: 'paid', links: [{ target_type: 'paid_strategy_recommendation', target_run_id: 'p1', target_index: 0, relation: 'derived_from' }] })]))
    expect(html).not.toMatch(/Approve &amp; implement|>Reject</)
  })
})

describe('Meta Ads checklist findings', () => {
  const checklist = insightView({
    id: 'k', domain: 'paid', origin_kind: 'meta_account_checks', scope_key: 'paid:finding:facebook_ads_check', stable_key: 'facebook-ads:M-CR12',
    title: 'Link click-through rate is below the checklist’s failing level', strength: 'reasonable_inference', trend: 'new',
    refs: [{ type: 'skill_check', skill: 'facebook-ads@1.0.0#13b4d57', check_id: 'M-CR12', result: 'fail', measured: '0.30%', rule: 'M-CR12: pass when overall CTR is at least 1.0%; warning at 0.5-1.0%; fail below 0.5%.', window_start: day(1), window_end: day(8) }],
  })
  it('labels the origin and shows the check, its result, what was measured and the skill’s rule', () => {
    const html = render(data([checklist]))
    const t = text(html)
    expect(t).toContain('Paid · Finding · Meta Ads checklist')
    expect(t).toContain('Meta Ads checklist · M-CR12 · fail · 0.30%')
    expect(html).toContain('title="M-CR12: pass when overall CTR is at least 1.0%')
    expect(render(data([insightView()]))).not.toContain('· Meta Ads checklist</p>')
  })
  it('always shows what the checklist could not assess, and says no health score is given', () => {
    const html = render(data([insightView()]))
    expect(html).toContain('data-checklist-coverage')
    const t = text(html)
    expect(t).toMatch(/Meta Ads checklist: 4 of 46 checks can be assessed/)
    expect(t).toContain('No health score or grade is given')
    expect(t).toContain('M-PX1'); expect(t).toContain('M-AU6'); expect(t).toContain('M-ST17')
    expect(t).toMatch(/facebook-ads@1\.0\.0#13b4d57/)
    expect(t).toMatch(/not model opinions/)
  })
  it('lists every check that is not assessed exactly once', () => {
    const ids = [...text(render(data([insightView()]))).matchAll(/\bM-[A-Z]+\d+\b/g)].map(m => m[0])
    const notAssessed = ids.filter(id => !['M-CR12', 'M-CR2', 'M-ST18', 'M-CR4'].includes(id))
    expect(new Set(notAssessed).size).toBe(notAssessed.length)
    expect(notAssessed).toHaveLength(42)
  })
})

describe('placement', () => {
  it('sits on the CMO page after the Paid Strategy section and before the creative learning', () => {
    const html = renderToStaticMarkup(<BrainView data={{ allowed: true, canRefresh: false, run: null, latestAttempt: null, error: null }}
      paidStrategy={<div id="paid-strategy" />} insights={<div id="cmo-insights" />} />)
    expect(html.indexOf('id="paid-strategy"')).toBeLessThan(html.indexOf('id="cmo-insights"'))
    expect(html.indexOf('id="cmo-insights"')).toBeLessThan(html.indexOf('No Creative Intelligence run yet'))
  })
})

describe('Morning Brief', () => {
  const obs = { signal_id: 's1', category: 'paid', source: 'meta_paid', observation: 'Spend is on pace', evidence: 'Matched the weekly average.', interpretation: 'Nothing unusual.', recommended_action: 'No action needed.', creative_start: null }
  const sections = { observations: [obs], needs_review: { total: 0, items: [] }, paid: { anomalies: [], assessment: 'ok', active_campaign_summaries: [] }, organic: { assessment: 'ok', ig: { metrics: [], notable_posts: [] }, fb: { available: false, metrics: [] } }, gbp: { assessment: 'ok', integration_kind: 'connected', new_reviews_yesterday: null, avg_star_rating_7d: null, pending_reply_count: 0 }, content: {} } as never
  const brief = { id: 'b', brief_date: '2026-10-10', status: 'ready', overall_status: null, overall_reason: null, ai_summary: null, sections_json: sections, generated_at: '2026-10-10T06:00:00Z' } as never
  const cmo = cmoBriefData(strategy(), impl())
  const fresh = [insightView({ id: 'n', title: 'Process stories draw shares', times_observed: 1, first_seen_at: day(9), last_seen_at: day(9) })]
  const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => text(m[1]).trim())
  it('puts worth-knowing insights after the CMO recommendations and before Details, without moving anything else', () => {
    const picked = selectBriefInsights(fresh, cmo, new Date(day(10)))
    const html = renderToStaticMarkup(<MorningBriefContent brief={brief} snapshot={null} cmo={cmo} briefInsights={picked} />)
    expect(headings(html).slice(0, 4)).toEqual(["What's happening?", 'CMO recommendations', 'Worth knowing', 'Details'])
    expect(text(html)).toContain('Process stories draw shares')
    expect(html).toContain('href="/marketing/brain"')
  })
  it('is exactly the previous Brief when nothing is new, important or behind a decision', () => {
    const none = selectBriefInsights([insightView({ id: 'o', times_observed: 5, first_seen_at: day(1), last_seen_at: day(2) })], cmo, new Date(day(10)))
    const withNone = renderToStaticMarkup(<MorningBriefContent brief={brief} snapshot={null} cmo={cmo} briefInsights={none} />)
    const without = renderToStaticMarkup(<MorningBriefContent brief={brief} snapshot={null} cmo={cmo} />)
    expect(withNone).toBe(without)
    expect(headings(withNone)).toEqual(["What's happening?", 'CMO recommendations', 'Details'])
  })
  it('the list itself renders nothing when empty and stays compact (max three rows)', () => {
    expect(renderToStaticMarkup(<BriefInsights items={[]} />)).toBe('')
    const many = selectBriefInsights(Array.from({ length: 6 }, (_, i) => insightView({ id: `i${i}`, title: `Insight ${i}`, times_observed: 1, first_seen_at: day(9), last_seen_at: day(9) })), null, new Date(day(10)))
    expect(renderToStaticMarkup(<BriefInsights items={many} />).match(/<li /g)).toHaveLength(3)
  })
})
