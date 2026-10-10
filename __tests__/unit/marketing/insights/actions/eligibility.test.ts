import { describe, expect, it } from 'vitest'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import { implementRouteFor } from '@/lib/marketing/insights/actions/eligibility'
import { day, paidRunAt } from '../../../../helpers/insights'

const strategy = (over: Partial<PaidStrategyData> = {}): PaidStrategyData => ({ allowed: true, canGenerate: false, latest: paidRunAt('p1', day(9)), previous: [paidRunAt('p0', day(2))], latestAttempt: null, error: null, ...over })
const impl = (views: StrategyImplementationData['views'] = [], over: Partial<StrategyImplementationData> = {}): StrategyImplementationData => ({ canApprove: true, views, error: null, ...over })
const view = (index: number, status: string, run = 'p1') => ({ id: `v${index}`, strategyRunId: run, recommendationIndex: index, mode: 'campaign_creation', status, budgetReservedDkk: 0, error: null, approvedAt: null, blockers: [], message: null, review: null, linkedTaskId: null }) as never
const link = (index: number, run = 'p1') => ({ target_type: 'paid_strategy_recommendation' as const, target_run_id: run, target_index: index, relation: 'derived_from' as const })

describe('the one direct route: an unsettled recommendation of the LATEST Paid Strategy', () => {
  it('is offered for an insight derived from one, with that recommendation’s own title and success metric', () => {
    const route = implementRouteFor({ links: [link(1)] }, strategy(), impl())!
    expect(route).toMatchObject({ runId: 'p1', index: 1 })
    expect(route.title).toBe(strategy().latest!.recommendations[1].display_title)
    expect(route.successMetric).toBe(strategy().latest!.recommendations[1].success_metric)
  })
  it('stays offered while the recommendation is prepared, waiting or in flight', () => {
    for (const status of ['prepared', 'needs_input', 'waiting_for_input', 'ready_to_activate', 'executing']) expect(implementRouteFor({ links: [link(0)] }, strategy(), impl([view(0, status)]))).not.toBeNull()
  })
  it('is not offered once the recommendation is settled: rejected, cancelled, live or finished', () => {
    for (const status of ['rejected', 'cancelled', 'in_motion', 'completed', 'started']) expect(implementRouteFor({ links: [link(0)] }, strategy(), impl([view(0, status)]))).toBeNull()
  })
  it('is never offered for an earlier analysis: the implementation flow accepts only the latest run', () => {
    expect(implementRouteFor({ links: [link(0, 'p0')] }, strategy(), impl())).toBeNull()
  })
  it('is never offered without a derived-from link to a recommendation, or for other relations or targets', () => {
    expect(implementRouteFor({ links: [] }, strategy(), impl())).toBeNull()
    expect(implementRouteFor({ links: [{ target_type: 'paid_strategy_run', target_run_id: 'p1', target_index: null, relation: 'informed' }] }, strategy(), impl())).toBeNull()
    expect(implementRouteFor({ links: [{ ...link(0), relation: 'informed' }] }, strategy(), impl())).toBeNull()
    expect(implementRouteFor({ links: [link(9)] }, strategy(), impl())).toBeNull() // no such recommendation
  })
  it('is not offered when the strategy or the implementation state is unavailable (it cannot be judged)', () => {
    expect(implementRouteFor({ links: [link(0)] }, null, impl())).toBeNull()
    expect(implementRouteFor({ links: [link(0)] }, strategy({ allowed: false }), impl())).toBeNull()
    expect(implementRouteFor({ links: [link(0)] }, strategy({ latest: null }), impl())).toBeNull()
    expect(implementRouteFor({ links: [link(0)] }, strategy(), impl([], { error: 'x' }))).toBeNull()
    expect(implementRouteFor({ links: [link(0)] }, strategy(), null)).toBeNull()
  })
})
