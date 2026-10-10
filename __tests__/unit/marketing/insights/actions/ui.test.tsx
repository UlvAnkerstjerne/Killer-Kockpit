import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { InsightsData } from '@/lib/actions/marketing/insights'

const m = vi.hoisted(() => ({ propose: vi.fn(), choose: vi.fn(), people: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/lib/actions/marketing/insights', () => ({ getMarketingInsights: vi.fn(), captureMarketingInsights: vi.fn() }))
vi.mock('@/lib/actions/marketing/insight-actions', () => ({ proposeInsightActions: m.propose, chooseInsightAction: m.choose, listInsightActionAssignees: m.people }))
vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), resumeStrategyImplementation: vi.fn(), activateStrategyImplementation: vi.fn(),
  cancelStrategyImplementation: vi.fn(), rejectStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn(),
}))
// The existing control is reused as-is; here it only needs to be recognisable and to show which props it was given.
vi.mock('@/app/(marketing)/marketing/brain/ImplementationControl', () => ({
  default: (p: { runId: string; index: number; canApprove: boolean; superseded: boolean; view?: { status: string } }) =>
    <div data-impl-control data-run={p.runId} data-index={p.index} data-can-approve={String(p.canApprove)} data-superseded={String(p.superseded)} data-status={p.view?.status ?? 'none'} />,
}))
import InsightsSection from '@/app/(marketing)/marketing/brain/InsightsSection'
import type { ActionView } from '@/lib/marketing/insights/actions/types'
import { actionRow, stamp } from '../../../../helpers/insight-actions'
import { day, insightView, paidRunAt } from '../../../../helpers/insights'

const strategy = (): PaidStrategyData => ({ allowed: true, canGenerate: false, latest: paidRunAt('p1', day(9)), previous: [paidRunAt('p0', day(2))], latestAttempt: null, error: null })
const impl = (views: StrategyImplementationData['views'] = [], canApprove = true): StrategyImplementationData => ({ canApprove, views, error: null })
const view = (index: number, status: string, run = 'p1') => ({ id: `v${index}`, strategyRunId: run, recommendationIndex: index, mode: 'campaign_creation', status, budgetReservedDkk: 0, error: null, approvedAt: null, blockers: [], message: null, review: null, linkedTaskId: null }) as never
const av = (over: Partial<ActionView> = {}): ActionView => ({ ...actionRow(), live: null, ...over })
const render = (actions: ActionView[], over = {}, s = strategy(), i = impl()) =>
  renderToStaticMarkup(<InsightsSection data={{ allowed: true, canCapture: false, insights: [insightView({ id: 'ins-1', actions, ...over })], error: null } as InsightsData} strategy={s} implementations={i} />)
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('"Do something about it"', () => {
  it('is a button on the card, and drafting happens only when it is clicked: nothing is requested while rendering', () => {
    const html = render([])
    expect(html).toContain('data-insight-actions'); expect(text(html)).toContain('Do something about it')
    expect(html).not.toContain('data-insight-options'); expect(html).not.toContain('type="radio"')
    expect(m.propose).not.toHaveBeenCalled(); expect(m.choose).not.toHaveBeenCalled()
  })
  it('shows drafted options as a choice, each labelled by what happens, with steps and what to look at afterwards; nothing happens until one is chosen', () => {
    const html = render([
      av({ id: 'a', kind: 'manual_task', title: 'Add two more ads', steps: ['Open the ad set', 'Add two ads'], success_signal: 'The next analysis.' }),
      av({ id: 'b', kind: 'content_brief', title: 'Brief a reel', brief: { concept: 'One hidden step', hook: 'Most skip it', key_points: ['a point', 'b point'], evidence_basis: 'The evidence.' } }),
      av({ id: 'c', kind: 'implement_recommendation', title: 'Try a second catering ad', target_run_id: 'p1', target_index: 1, model: null }),
    ])
    const t = text(html)
    expect(html.match(/type="radio"/g)).toHaveLength(3)
    expect(t).toContain('Choose one. Nothing happens until you do.')
    expect(t).toContain('Task for a person'); expect(t).toContain('Content brief for a person'); expect(t).toContain('Kockpit runs it — you approve')
    expect(t).toContain('Open the ad set'); expect(t).toContain('Afterwards, look at: The next analysis.')
    expect(t).toContain('For a person to produce. Kockpit does not film, publish or schedule content.')
    expect(t).toContain('Draft different options')
    expect(html).not.toContain('Create this task') // nothing is selected yet
    expect(html).not.toContain('data-insight-implementation') // and the existing controls are not shown for a mere proposal
  })
  it('escapes everything the model drafted', () => {
    const html = render([av({ title: '<script>alert(1)</script> bold', why: '<img src=x onerror=alert(1)>' })])
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x'); expect(html).toContain('&lt;script&gt;')
  })
})

describe('a chosen action', () => {
  const task = (over: Partial<ActionView> = {}) => av({ id: 't', status: 'chosen', chosen_at: stamp(5), linked_task_id: 'task-1', owner_user_id: 'u1', due_on: '2026-10-17', live: { source: 'task', status: 'open', dueAt: '2026-10-17T12:00:00Z', completedAt: null }, ...over })
  it('shows the task’s live status and due date with a link to it, and no more options', () => {
    const html = render([task()]); const t = text(html)
    expect(t).toContain('Task for a person · In progress'); expect(t).toContain('Task: Open · due 17 Oct 2026'); expect(html).toContain('href="/tasks/task-1"')
    expect(html).not.toContain('data-insight-implementation')
  })
  it('reflects the task as work moves on: in review, done, cancelled', () => {
    expect(text(render([task({ live: { source: 'task', status: 'pending_review', dueAt: null, completedAt: null } })]))).toContain('Task: Waiting for review')
    expect(text(render([task({ status: 'completed', completed_at: stamp(8), live: { source: 'task', status: 'done', dueAt: '2026-10-17T12:00:00Z', completedAt: stamp(8) } })]))).toMatch(/Task for a person · Done.*Task: Done · finished 8 Oct 2026/)
    expect(text(render([task({ status: 'abandoned', completed_at: stamp(8), live: { source: 'task', status: 'cancelled', dueAt: null, completedAt: null } })]))).toMatch(/Stopped.*Task: Cancelled.*stopped 8 Oct 2026/)
  })
  const outcome = { source: 'task' as const, final_status: 'done', finished_at: stamp(8), insight: { strength: 'reasonable_inference', trend: 'steady', times_observed: 2, last_supported_at: stamp(4) } }
  const finished = (over = {}) => task({ status: 'completed', completed_at: stamp(8), outcome, live: { source: 'task', status: 'done', dueAt: null, completedAt: stamp(8) } , ...over })
  it('shows what later analyses say about the insight after a finished action, as observation and never as proof of cause', () => {
    const t = text(render([finished()], { strength: 'strong_pattern', times_observed: 4 }))
    expect(t).toContain('Since it was done: the insight looks stronger in later analyses.')
    expect(t).toContain('That is what later analyses show, not proof that the action caused it.')
    expect(text(render([finished()], { strength: 'weak_signal', times_observed: 4 }))).toContain('looks weaker in later analyses')
    expect(text(render([finished()], { strength: 'reasonable_inference', times_observed: 2 }))).toContain('no later analysis has looked at it yet')
  })
  it('shows no result for work that is not finished', () => {
    expect(text(render([task()], { strength: 'strong_pattern', times_observed: 9 }))).not.toContain('Since it was done')
  })
  const direct = (over: Partial<ActionView> = {}) => av({ id: 'r', kind: 'implement_recommendation', status: 'chosen', chosen_at: stamp(5), title: 'Try a second catering ad', target_run_id: 'p1', target_index: 1, model: null, ...over })
  it('for the direct route, shows the EXISTING Approve & implement control for that recommendation, with the existing approval state, and says nothing runs until confirmed there', () => {
    const html = render([direct()], {}, strategy(), impl([view(1, 'ready_to_activate')], true))
    expect(html).toContain('data-insight-implementation')
    const control = html.match(/<div data-impl-control[^>]*>/)?.[0] ?? ''
    for (const attr of ['data-run="p1"', 'data-index="1"', 'data-can-approve="true"', 'data-superseded="false"', 'data-status="ready_to_activate"']) expect(control).toContain(attr)
    expect(text(html)).toContain('Kockpit runs it — you approve · In progress'); expect(text(html)).toMatch(/Status: .*[Rr]eady/)
  })
  it('passes the real permission through: someone who cannot approve gets the control without approval', () => {
    expect(render([direct()], {}, strategy(), impl([], false))).toContain('data-can-approve="false"')
  })
  it('marks a recommendation from an earlier analysis as superseded, and shows no control once the work has finished', () => {
    expect(render([direct({ target_run_id: 'p0' })])).toContain('data-superseded="true"')
    expect(render([direct({ status: 'completed', completed_at: stamp(8), outcome: { source: 'implementation', final_status: 'completed', finished_at: stamp(8), insight: { strength: 'weak_signal', trend: 'new', times_observed: 1, last_supported_at: stamp(1) } } })])).not.toContain('data-insight-implementation')
  })
  it('shows the live state of the implementation, read from the existing flow rather than copied into the action', () => {
    const t = text(render([direct()], {}, strategy(), impl([view(1, 'waiting_for_access')])))
    expect(t).toMatch(/Status: .*(access|Waiting)/i)
    expect(text(render([direct()], {}, strategy(), impl([])))).toContain('Status: Not started')
  })
})
