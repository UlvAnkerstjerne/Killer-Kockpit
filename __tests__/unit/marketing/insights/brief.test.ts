import { describe, expect, it } from 'vitest'
import { MAX_BRIEF_INSIGHTS, selectBriefInsights } from '@/lib/marketing/insights/brief'
import { cmoBriefData } from '@/lib/marketing/paid-strategy/implementation/surface'
import { day, insightView, paidRunAt } from '../../../helpers/insights'

const NOW = new Date(day(10))
const cmo = () => cmoBriefData({ allowed: true, canGenerate: false, latest: paidRunAt('p1', day(9)), previous: [], latestAttempt: null, error: null }, { canApprove: true, views: [], error: null })
const link = (index: number, run = 'p1') => ({ target_type: 'paid_strategy_recommendation' as const, target_run_id: run, target_index: index, relation: 'derived_from' as const })

describe('Morning Brief insight selection', () => {
  it('shows nothing when there are no insights, or none that qualify', () => {
    expect(selectBriefInsights(null, null, NOW)).toEqual([])
    expect(selectBriefInsights([], cmo(), NOW)).toEqual([])
    const old = insightView({ id: 'o', strength: 'reasonable_inference', trend: 'steady', times_observed: 4, first_seen_at: day(1), last_seen_at: day(3) })
    expect(selectBriefInsights([old], null, NOW)).toEqual([])
  })
  it('shows an insight that is new this week and at least a reasonable inference', () => {
    const fresh = insightView({ id: 'n', times_observed: 1, first_seen_at: day(8), last_seen_at: day(8), trend: 'new' })
    const [pick] = selectBriefInsights([fresh], null, NOW)
    expect(pick).toMatchObject({ reason: 'new', label: 'New this week' })
  })
  it('hides new weak signals and new untested hypotheses on their own', () => {
    const weak = insightView({ id: 'w', strength: 'weak_signal', times_observed: 1, first_seen_at: day(9), last_seen_at: day(9) })
    const hypothesis = insightView({ id: 'h', strength: 'hypothesis', times_observed: 1, first_seen_at: day(9), last_seen_at: day(9) })
    expect(selectBriefInsights([weak, hypothesis], null, NOW)).toEqual([])
  })
  it('shows a strong pattern that is new or gaining support', () => {
    const strong = insightView({ id: 's', strength: 'strong_pattern', trend: 'strengthening', times_observed: 3, first_seen_at: day(1), last_seen_at: day(9) })
    expect(selectBriefInsights([strong], null, NOW)[0]).toMatchObject({ reason: 'important', label: 'Gaining support' })
  })
  it('flags an established insight that is losing support, but not one that was always weak', () => {
    const losing = insightView({ id: 'l', strength: 'weak_signal', peak_strength: 'strong_pattern', trend: 'weakening', times_observed: 4, first_seen_at: day(1), last_seen_at: day(9) })
    const alwaysWeak = insightView({ id: 'a', strength: 'weak_signal', peak_strength: 'weak_signal', trend: 'weakening', times_observed: 4, first_seen_at: day(1), last_seen_at: day(9) })
    expect(selectBriefInsights([losing, alwaysWeak], null, NOW).map(p => [p.insight.id, p.label])).toEqual([['l', 'Losing support']])
  })
  it('shows an insight behind a recommendation that still needs a decision once it has recurred, even if it is only a hypothesis', () => {
    const behind = insightView({ id: 'd', strength: 'hypothesis', times_observed: 3, first_seen_at: day(1), last_seen_at: day(2), links: [link(1)] })
    expect(selectBriefInsights([behind], cmo(), NOW)[0]).toMatchObject({ reason: 'decision', label: 'Behind recommendation 2' })
  })
  it('does not repeat a first-time insight that only restates the recommendation already shown', () => {
    const first = insightView({ id: 'f', strength: 'hypothesis', times_observed: 1, first_seen_at: day(2), last_seen_at: day(2), links: [link(1)] })
    expect(selectBriefInsights([first], cmo(), NOW)).toEqual([])
  })
  it('does not show one whose recommendation is settled, from another run, or not currently shown', () => {
    const data = cmoBriefData({ allowed: true, canGenerate: false, latest: paidRunAt('p1', day(9)), previous: [], latestAttempt: null, error: null },
      { canApprove: true, views: [{ id: 'v', strategyRunId: 'p1', recommendationIndex: 1, mode: 'campaign_creation', status: 'rejected', budgetReservedDkk: 0, error: null, approvedAt: null, blockers: [], message: null, review: null, linkedTaskId: null } as never], error: null })!
    const settled = insightView({ id: 's', strength: 'hypothesis', times_observed: 3, last_seen_at: day(2), links: [link(1)] })
    const otherRun = insightView({ id: 'r', strength: 'hypothesis', times_observed: 3, last_seen_at: day(2), links: [link(0, 'p0')] })
    expect(selectBriefInsights([settled, otherRun], data, NOW)).toEqual([])
  })
  it('never shows stale insights', () => {
    const stale = insightView({ id: 'z', status: 'stale', strength: 'strong_pattern', trend: 'strengthening', last_seen_at: day(9) })
    expect(selectBriefInsights([stale], null, NOW)).toEqual([])
  })
  it('caps the list, decisions first, then important, then new', () => {
    const items = [
      insightView({ id: 'new', times_observed: 1, first_seen_at: day(9), last_seen_at: day(9) }),
      insightView({ id: 'imp', strength: 'strong_pattern', trend: 'new', last_seen_at: day(9), times_observed: 1, first_seen_at: day(9) }),
      insightView({ id: 'dec', strength: 'hypothesis', last_seen_at: day(2), times_observed: 2, links: [link(0)] }),
      insightView({ id: 'new2', times_observed: 1, first_seen_at: day(8), last_seen_at: day(8) }),
    ]
    const picked = selectBriefInsights(items, cmo(), NOW)
    expect(picked).toHaveLength(MAX_BRIEF_INSIGHTS)
    expect(picked.map(p => p.insight.id)).toEqual(['dec', 'imp', 'new'])
  })
})
