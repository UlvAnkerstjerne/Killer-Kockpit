import { describe, expect, it } from 'vitest'
import { matchScore, reconcileRun, STALE_AFTER_MISSES } from '@/lib/marketing/insights/reconcile'
import { similarity, tokens } from '@/lib/marketing/insights/text'
import { candidate, day, extraction, insightRow } from '../../../helpers/insights'

describe('text matching', () => {
  it('treats a reworded restatement as similar and a different subject as not', () => {
    const a = 'Posts explaining a hidden preparation step were shared more than product-only posts.'
    expect(similarity(a, 'Explaining a hidden preparation step gets shared more often than product-only posts.')).toBeGreaterThan(0.55)
    expect(similarity(a, 'Opening hours announcements reached very few people on weekends.')).toBeLessThan(0.2)
  })
  it('ignores stopwords, numbers and trivial inflection', () => {
    expect([...tokens('The tracking of 12 leads was tracked')]).toEqual(['track', 'lead'])
  })
})

describe('reconcileRun: duplicates', () => {
  it('re-observes the same insight in a later run instead of creating a duplicate, even when the wording drifts', () => {
    const existing = insightRow()
    const plan = reconcileRun([existing], extraction({ runId: 'run-2', observedAt: day(8), candidates: [
      candidate({ title: 'Explaining a hidden step drives shares', statement: 'Explaining a hidden preparation step was shared more than product-only posts.' }),
    ] }))
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].insightId).toBe('ins-1')
    expect(plan.updates[0].patch).toMatchObject({ times_observed: 2, runs_since_seen: 0, last_seen_at: day(8), last_source_run_id: 'run-2', status: 'active' })
  })
  it('creates a new insight for a different subject in the same scope', () => {
    const plan = reconcileRun([insightRow()], extraction({ runId: 'run-2', observedAt: day(8), candidates: [
      candidate({ title: 'Weekend opening hours reach few people', statement: 'Opening hour announcements reached very few people at weekends.' }),
    ] }))
    expect(plan.inserts).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
    expect(plan.inserts[0].insert).toMatchObject({ trend: 'new', times_observed: 1, status: 'active', first_seen_at: day(8) })
  })
  it('never matches across scopes, even for identical text', () => {
    const plan = reconcileRun([insightRow({ scope_key: 'paid:finding:tracking', domain: 'paid' })], extraction({ runId: 'run-2', observedAt: day(8) }))
    expect(plan.inserts).toHaveLength(1)
  })
  it('matches an exact stable key even when the wording is completely different', () => {
    const existing = insightRow({ domain: 'creative', scope_key: 'creative:finding', stable_key: 'creative:a|b', title: 'Two reels carry the account', statement: 'Two reels massively outperformed.' })
    const plan = reconcileRun([existing], extraction({ runId: 'run-2', observedAt: day(8), coverage: { creative: true }, candidates: [
      candidate({ domain: 'creative', scope_key: 'creative:finding', stable_key: 'creative:a|b', title: 'Heavy lifting', statement: 'Nothing similar in the words at all here.' }),
    ] }))
    expect(plan.updates).toHaveLength(1)
    expect(plan.inserts).toHaveLength(0)
  })
  it('lets one existing insight absorb only one candidate per run (one-to-one)', () => {
    const plan = reconcileRun([insightRow()], extraction({ runId: 'run-2', observedAt: day(8), candidates: [candidate(), candidate()] }))
    expect(plan.updates).toHaveLength(1)
    expect(plan.inserts).toHaveLength(1)
  })
  it('lets a shared source post tip a borderline match, but never rescues unrelated text', () => {
    const ref = { type: 'instagram_post' as const, ref: 'P1', permalink: 'https://www.instagram.com/p/abc/', published_at: day(1), media_type: 'VIDEO' }
    const row = insightRow({ title: 'Kitchen footage reaches people', statement: 'Kitchen footage performs well for reach among the measured videos.', refs: [ref] })
    const borderline = { title: 'Behind the scenes clips', statement: 'Behind the scenes kitchen footage reached people on video.' }
    expect(matchScore(candidate(borderline), row)).toBe(0) // below the text threshold on its own
    expect(matchScore(candidate({ ...borderline, refs: [ref] }), row)).toBeGreaterThan(0.55) // the same cited post tips it
    expect(matchScore(candidate({ title: 'Opening hours', statement: 'Weekend announcements reached very few followers.', refs: [ref] }), row)).toBe(0)
  })
})

describe('reconcileRun: support over time', () => {
  const later = (strength: Parameters<typeof candidate>[0] extends infer P ? NonNullable<P extends { strength?: infer S } ? S : never> : never) =>
    reconcileRun([insightRow({ strength: 'reasonable_inference', peak_strength: 'reasonable_inference' })], extraction({ runId: 'run-2', observedAt: day(8), candidates: [candidate({ strength })] }))
  it('marks gained support', () => {
    const plan = later('strong_pattern')
    expect(plan.updates[0].observation.change).toBe('strengthened')
    expect(plan.updates[0].patch).toMatchObject({ trend: 'strengthening', strength: 'strong_pattern', peak_strength: 'strong_pattern' })
  })
  it('marks lost support, and remembers the peak', () => {
    const plan = later('weak_signal')
    expect(plan.updates[0].observation.change).toBe('weakened')
    expect(plan.updates[0].patch).toMatchObject({ trend: 'weakening', strength: 'weak_signal', peak_strength: 'reasonable_inference' })
  })
  it('marks an unchanged re-observation as holding', () => {
    const plan = later('reasonable_inference')
    expect(plan.updates[0].observation.change).toBe('reconfirmed')
    expect(plan.updates[0].patch).toMatchObject({ trend: 'steady' })
  })
  it('records what the evidence said in THAT run, and takes the newest wording as current', () => {
    const plan = reconcileRun([insightRow()], extraction({ runId: 'run-2', observedAt: day(8), candidates: [candidate({ statement: 'Explaining a hidden preparation step was shared more than product-only posts, again.', evidence_text: 'New evidence text.' })] }))
    expect(plan.updates[0].observation).toMatchObject({ source_run_id: 'run-2', evidence_text: 'New evidence text.' })
    expect(plan.updates[0].patch).toMatchObject({ statement: expect.stringContaining('again'), evidence_text: 'New evidence text.' })
  })
})

describe('reconcileRun: misses', () => {
  const none = (coverage: Record<string, boolean>, row = insightRow()) =>
    reconcileRun([row], extraction({ runId: 'run-2', observedAt: day(8), candidates: [], coverage }))
  it('counts a miss only when the run covers the insight’s domain', () => {
    expect(none({ organic: true }).misses).toHaveLength(1)
    expect(none({ organic: false }).misses).toHaveLength(0)
    expect(none({ paid: true }).misses).toHaveLength(0)
  })
  it('flags an unreproduced insight as unconfirmed, and stale only after repeated misses', () => {
    const first = none({ organic: true }).misses[0].patch
    expect(first).toMatchObject({ trend: 'unconfirmed', runs_since_seen: 1, status: 'active' })
    const second = none({ organic: true }, insightRow({ runs_since_seen: STALE_AFTER_MISSES - 1, trend: 'unconfirmed' })).misses[0].patch
    expect(second).toMatchObject({ runs_since_seen: STALE_AFTER_MISSES, status: 'stale' })
  })
  it('revives a stale insight when a later run reproduces it', () => {
    const plan = reconcileRun([insightRow({ status: 'stale', runs_since_seen: 3, trend: 'unconfirmed' })], extraction({ runId: 'run-9', observedAt: day(20) }))
    expect(plan.updates[0].patch).toMatchObject({ status: 'active', runs_since_seen: 0, trend: 'steady' })
  })
})

describe('reconcileRun: idempotence and ordering', () => {
  it('replaying the same run changes nothing about the state, only re-offers the (deduplicated) observation', () => {
    const touched = insightRow({ last_source_run_id: 'run-2', last_seen_at: day(8), times_observed: 2 })
    const plan = reconcileRun([touched], extraction({ runId: 'run-2', observedAt: day(8) }))
    expect(plan.updates[0].patch).toBeNull()
    expect(plan.inserts).toHaveLength(0)
    const missed = reconcileRun([insightRow({ last_source_run_id: 'run-2', runs_since_seen: 1 })], extraction({ runId: 'run-2', observedAt: day(8), candidates: [], coverage: { organic: true } }))
    expect(missed.misses).toHaveLength(0)
  })
  it('an older run replayed after a newer one adds history without rewinding the current state', () => {
    const current = insightRow({ strength: 'strong_pattern', last_seen_at: day(15), first_seen_at: day(8), times_observed: 2, last_source_run_id: 'run-3', trend: 'strengthening' })
    const plan = reconcileRun([current], extraction({ runId: 'run-1', observedAt: day(1), candidates: [candidate({ strength: 'weak_signal' })] }))
    expect(plan.updates[0].patch).toEqual({ times_observed: 3, first_seen_at: day(1) })
    expect(plan.updates[0].observation.change).toBe('reconfirmed')
    expect(plan.misses).toHaveLength(0)
  })
  it('is deterministic regardless of candidate order', () => {
    const a = candidate({ title: 'Alpha subject about marinade', statement: 'Marinade stories were shared more than average.' })
    const b = candidate({ title: 'Beta subject about opening hours', statement: 'Opening hours announcements reached few people.' })
    const rows = [insightRow({ id: 'x', title: a.title, statement: a.statement }), insightRow({ id: 'y', title: b.title, statement: b.statement })]
    const one = reconcileRun(rows, extraction({ runId: 'r2', observedAt: day(8), candidates: [a, b] }))
    const two = reconcileRun(rows, extraction({ runId: 'r2', observedAt: day(8), candidates: [b, a] }))
    expect(one.updates.map(u => u.insightId).sort()).toEqual(two.updates.map(u => u.insightId).sort())
    expect(one.updates.map(u => u.insightId).sort()).toEqual(['x', 'y'])
  })
})

describe('reconcileRun: origin and assessed keys', () => {
  const check = (over = {}) => insightRow({ id: 'chk', domain: 'paid', origin_kind: 'meta_account_checks', scope_key: 'paid:finding:facebook_ads_check', stable_key: 'facebook-ads:M-CR12', ...over })
  const run = (over = {}) => extraction({ sourceKind: 'meta_account_checks', runId: 'chk-run-2', observedAt: day(8), candidates: [], coverage: { paid: true }, ...over })
  it('counts a miss only for keys the run actually assessed', () => {
    expect(reconcileRun([check()], run({ assessedKeys: ['facebook-ads:M-CR12'] })).misses).toHaveLength(1)
    expect(reconcileRun([check()], run({ assessedKeys: ['facebook-ads:M-ST18'] })).misses).toHaveLength(0)
    expect(reconcileRun([check()], run({ assessedKeys: [] })).misses).toHaveLength(0)
  })
  it('never counts a miss for an insight another source created, even in the same domain', () => {
    const paidRunInsight = insightRow({ id: 'p', domain: 'paid', origin_kind: 'paid_strategy_run', scope_key: 'paid:finding:tracking' })
    expect(reconcileRun([paidRunInsight], run({ assessedKeys: ['facebook-ads:M-CR12'] })).misses).toHaveLength(0)
    expect(reconcileRun([check()], extraction({ sourceKind: 'paid_strategy_run', candidates: [], coverage: { paid: true }, observedAt: day(8) })).misses).toHaveLength(0)
  })
  it('never merges across origins, and stamps the origin on a new insight', () => {
    const plan = reconcileRun([check({ title: 'Process stories draw shares', statement: 'Posts that explain a hidden preparation step were shared more than product-only posts.', scope_key: 'organic:finding' })], extraction({ runId: 'r2', observedAt: day(8) }))
    expect(plan.updates).toHaveLength(0)
    expect(plan.inserts[0].insert.origin_kind).toBe('creative_run')
  })
})
