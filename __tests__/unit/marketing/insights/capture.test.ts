import { describe, expect, it } from 'vitest'
import { captureRun, recordInformed } from '@/lib/marketing/insights/capture'
import { extractFromCreativeRun, extractFromPaidRun } from '@/lib/marketing/insights/extract'
import { creativeRunAt, day, memoryStore, paidRunAt } from '../../../helpers/insights'
import { REAL_RECS } from '../../../helpers/paid-strategy-real-recs'

describe('captureRun', () => {
  it('captures a creative run into insights with an observation each, and no duplicates on a second capture of the same run', async () => {
    const m = memoryStore()
    const ex = extractFromCreativeRun(creativeRunAt('c1', day(2)))
    const first = await captureRun(m.store, ex)
    expect(first).toMatchObject({ skipped: false, created: ex.candidates.length })
    expect(m.all()).toHaveLength(ex.candidates.length)
    expect(m.observations).toHaveLength(ex.candidates.length)
    const again = await captureRun(m.store, ex)
    expect(again.skipped).toBe(true)
    expect(m.all()).toHaveLength(ex.candidates.length)
    expect(m.observations).toHaveLength(ex.candidates.length)
  })
  it('keeps one insight across runs: later runs add observations, bump counts and never duplicate', async () => {
    const m = memoryStore()
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c1', day(2))))
    const count = m.all().length
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c2', day(9))))
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c3', day(16))))
    expect(m.all()).toHaveLength(count)
    for (const row of m.all()) {
      expect(row.times_observed).toBe(3)
      expect(row.first_seen_at).toBe(day(2))
      expect(row.last_seen_at).toBe(day(16))
      expect(m.observations.filter(o => o.insight_id === row.id)).toHaveLength(3)
    }
  })
  it('tracks an insight that stops being reproduced: unconfirmed, then stale, then revived', async () => {
    const m = memoryStore()
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c1', day(2))))
    const organicIds = m.all().filter(r => r.domain === 'organic').map(r => r.id)
    const bare = (id: string, at: string) => extractFromCreativeRun(creativeRunAt(id, at, { main_learnings: [], content_opportunities: [] }))
    await captureRun(m.store, bare('c2', day(9)))
    expect(m.insights.get(organicIds[0])!).toMatchObject({ trend: 'unconfirmed', runs_since_seen: 1, status: 'active' })
    await captureRun(m.store, bare('c3', day(16)))
    expect(m.insights.get(organicIds[0])!).toMatchObject({ runs_since_seen: 2, status: 'stale' })
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c4', day(23))))
    expect(m.insights.get(organicIds[0])!).toMatchObject({ status: 'active', runs_since_seen: 0 })
  })
  it('does not count misses when the specialist step did not complete', async () => {
    const m = memoryStore()
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c1', day(2))))
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c2', day(9), null)))
    for (const row of m.all().filter(r => r.domain === 'organic')) expect(row).toMatchObject({ runs_since_seen: 0, status: 'active' })
  })
  it('links a paid insight to the recommendation it came from, and records the same run only once', async () => {
    const m = memoryStore()
    const ex = extractFromPaidRun(paidRunAt('p1', day(3)))
    await captureRun(m.store, ex)
    expect(m.links).toHaveLength(3)
    expect(m.links[0]).toMatchObject({ target_type: 'paid_strategy_recommendation', target_run_id: 'p1', relation: 'derived_from' })
    expect(m.links.map(l => l.target_index).sort()).toEqual([0, 1, 2])
    await captureRun(m.store, ex)
    expect(m.links).toHaveLength(3)
  })
  it('does not duplicate a paid insight when a later run restates the same idea, and links BOTH runs’ recommendations', async () => {
    const m = memoryStore()
    await captureRun(m.store, extractFromPaidRun(paidRunAt('p1', day(3))))
    await captureRun(m.store, extractFromPaidRun(paidRunAt('p2', day(10))))
    expect(m.all()).toHaveLength(3)
    expect(m.links.filter(l => l.relation === 'derived_from')).toHaveLength(6)
    expect(new Set(m.links.map(l => l.target_run_id))).toEqual(new Set(['p1', 'p2']))
  })
  it('keeps recommendation, action and result state out of the insight', async () => {
    const m = memoryStore()
    await captureRun(m.store, extractFromPaidRun(paidRunAt('p1', day(3))))
    const row = JSON.stringify(m.all())
    expect(row).not.toMatch(/implementation|approved|rejected|budget_reserved|incremental_budget/i)
    expect(row).not.toContain(REAL_RECS[0].exact_test_or_action)
  })
  it('converges after a failure part-way through (no duplicates, no double-counted misses)', async () => {
    const m = memoryStore()
    await captureRun(m.store, extractFromCreativeRun(creativeRunAt('c1', day(2))))
    const bare = extractFromCreativeRun(creativeRunAt('c2', day(9), { main_learnings: [], content_opportunities: [] }))
    m.failOn.add('insertObservations')
    await expect(captureRun(m.store, bare)).rejects.toThrow('boom:insertObservations')
    await captureRun(m.store, bare) // observations are the marker, so it re-runs, but every row already remembers run c2
    for (const row of m.all().filter(r => r.domain === 'organic')) expect(row.runs_since_seen).toBe(1)
    expect(m.all().filter(r => r.domain === 'organic')).toHaveLength(3)
  })
  it('records which earlier insights informed a later run', async () => {
    const m = memoryStore()
    await recordInformed(m.store, ['a', 'b', 'a'], { type: 'paid_strategy_run', runId: 'p9' })
    expect(m.links).toEqual([
      { insight_id: 'a', target_type: 'paid_strategy_run', target_run_id: 'p9', target_index: null, relation: 'informed' },
      { insight_id: 'b', target_type: 'paid_strategy_run', target_run_id: 'p9', target_index: null, relation: 'informed' },
    ])
    await recordInformed(m.store, [], { type: 'creative_run', runId: 'c9' })
    expect(m.links).toHaveLength(2)
  })
})
