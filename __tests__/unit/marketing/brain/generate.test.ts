import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint, NOW, strongSample } from '../../../helpers/creative-brain'
import { storedStrategy } from '../../../helpers/organic-strategy'
import type { Media } from '@/lib/marketing/brain/types'
import type { createServiceClient } from '@/lib/supabase/server'
import { FingerprintSchema } from '@/lib/marketing/brain/taxonomy'
const mocks = vi.hoisted(() => ({ classify: vi.fn(), interpret: vi.fn(), loadCtx: vi.fn(), organic: vi.fn(), followers: vi.fn() }))
const insights = vi.hoisted(() => ({ prior: vi.fn(), capture: vi.fn(), informed: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/creative-classifier', () => ({ callCreativeClassifier: mocks.classify }))
vi.mock('@/lib/ai/creative-interpretation', () => ({ callCreativeInterpretation: mocks.interpret }))
vi.mock('@/lib/marketing/brain/business-context', () => ({ loadMarketingBusinessContext: mocks.loadCtx }))
vi.mock('@/lib/marketing/organic-strategy/generate', () => ({ runOrganicStrategy: mocks.organic, loadLatestFollowers: mocks.followers }))
vi.mock('@/lib/marketing/insights/prior', async orig => ({ ...(await orig<typeof import('@/lib/marketing/insights/prior')>()), loadPriorInsights: insights.prior }))
vi.mock('@/lib/marketing/insights/service', async orig => ({ ...(await orig<typeof import('@/lib/marketing/insights/service')>()), captureCreativeRunById: insights.capture, recordInformedQuietly: insights.informed }))
import { generateCreativeIntelligence } from '@/lib/marketing/brain/generate'

// A transport fake for orchestration/error sequencing. SQL semantics and RLS are
// independently exercised against real PostgreSQL in migration.test.ts.
function storage(posts: Media[], opts: { locked?: boolean; failedRead?: boolean; failedFinalWrite?: boolean; existing?: boolean } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    meta_ig_media: posts as unknown as Record<string, unknown>[],
    marketing_content_fingerprints: opts.existing ? posts.map(p => fingerprint(p)) : [],
    marketing_creative_intelligence_runs: [],
  }
  const mutations: string[] = []
  const from = vi.fn((table: string) => {
    let operation = 'read'; let payload: Record<string, unknown> | Record<string, unknown>[] = {}; let single = false
    let range: [number, number] | null = null
    const filters: ((row: Record<string, unknown>) => boolean)[] = []
    const q = {
      select: () => q, order: () => q,
      range: (a: number, b: number) => { range = [a, b]; return q },
      eq: (key: string, value: unknown) => { filters.push(r => r[key] === value); return q },
      lt: (key: string, value: string) => { filters.push(r => String(r[key]) < value); return q },
      gt: (key: string, value: string) => { filters.push(r => String(r[key]) > value); return q },
      insert: (data: Record<string, unknown>) => { operation = 'insert'; payload = data; return q },
      update: (data: Record<string, unknown>) => { operation = 'update'; payload = data; return q },
      upsert: (data: Record<string, unknown>[]) => { operation = 'upsert'; payload = data; return q },
      single: () => { single = true; return q },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (operation !== 'read') mutations.push(table)
        if (opts.locked && operation === 'insert') return Promise.resolve(resolve({ data: null, error: { code: '23505' } }))
        if (opts.failedRead && operation === 'read') return Promise.resolve(resolve({ data: null, error: { code: 'XX' } }))
        if (opts.failedFinalWrite && operation === 'update' && 'analytics' in payload) return Promise.resolve(resolve({ data: null, error: { code: 'XX' } }))
        let rows = tables[table].filter(row => filters.every(f => f(row)))
        if (operation === 'insert') { const row = { id: 'test-run', ...payload }; tables[table].push(row); rows = [row] }
        if (operation === 'update') rows.forEach(row => Object.assign(row, payload))
        if (operation === 'upsert') { rows = payload as Record<string, unknown>[]; tables[table].push(...rows) }
        if (range) rows = rows.slice(range[0], range[1] + 1)
        return Promise.resolve(resolve({ data: single ? rows[0] ?? null : rows, error: single && !rows.length ? { code: 'missing' } : null }))
      },
    }
    return q
  })
  return { db: { from } as unknown as ReturnType<typeof createServiceClient>, tables, mutations, from }
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  mocks.interpret.mockResolvedValue({ ok: true, brain_take: null, insights: [], model: 'synthetic' })
  mocks.loadCtx.mockResolvedValue([])
  mocks.organic.mockResolvedValue(storedStrategy())
  mocks.followers.mockResolvedValue(5000)
  insights.prior.mockResolvedValue([]); insights.capture.mockResolvedValue({ skipped: false, created: 0, updated: 0, unconfirmed: 0 }); insights.informed.mockResolvedValue(undefined)
  mocks.classify.mockImplementation(async inputs => ({ ok: true, model: 'synthetic', items: inputs.map((i: { media_id: string }) => {
    const f = fingerprint(strongSample().posts.find(p => p.id === i.media_id)!)
    return Object.fromEntries(Object.entries(f).filter(([key]) => key in FingerprintSchema.shape))
  }) }))
})
afterEach(() => vi.useRealTimers())
describe('Creative refresh orchestration', () => {
  it('persists classifications then deterministic analytics and a completed run', async () => {
    const s = storage(strongSample().posts)
    const result = await generateCreativeIntelligence(s.db, 'admin')
    expect(result).toMatchObject({ ok: true, counts: { classified: 8, failed: 0 } })
    expect(s.tables.marketing_content_fingerprints).toHaveLength(8)
    expect(s.tables.marketing_creative_intelligence_runs[0]).toMatchObject({ status: 'completed', requested_by: 'admin', lease_expires_at: null })
    expect(new Set(s.mutations)).toEqual(new Set(['marketing_content_fingerprints', 'marketing_creative_intelligence_runs']))
  })
  it('skips unchanged classifications and passes only code-generated signals to interpretation', async () => {
    const s = storage(strongSample().posts, { existing: true })
    const result = await generateCreativeIntelligence(s.db, 'admin')
    expect(result).toMatchObject({ ok: true, counts: { skipped: 8, classified: 0 } })
    expect(mocks.classify).not.toHaveBeenCalled()
    const args = mocks.interpret.mock.calls[0][0]
    expect(JSON.stringify(args)).not.toContain('caption')
  })
  it('retains successful classifications and deterministic evidence when interpretation fails', async () => {
    mocks.interpret.mockResolvedValue({ ok: false, error: 'Interpretation unavailable.' })
    const s = storage(strongSample().posts)
    expect(await generateCreativeIntelligence(s.db, 'admin')).toMatchObject({ ok: true, partial: true })
    expect(s.tables.marketing_content_fingerprints).toHaveLength(8)
    expect(s.tables.marketing_creative_intelligence_runs[0]).toMatchObject({ status: 'partial', observations: [], error: 'Interpretation unavailable.' })
  })
  it('rejects simultaneous refresh before any AI or media work', async () => {
    const s = storage([], { locked: true })
    expect(await generateCreativeIntelligence(s.db, 'admin')).toMatchObject({ ok: false, error: expect.stringContaining('already running') })
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.interpret).not.toHaveBeenCalled()
    expect(s.from).not.toHaveBeenCalledWith('meta_ig_media')
  })
  it('records a failed run on source read or final persistence failure', async () => {
    for (const opts of [{ failedRead: true }, { failedFinalWrite: true }]) {
      const s = storage(strongSample().posts, opts)
      expect((await generateCreativeIntelligence(s.db, 'admin')).ok).toBe(false)
      expect(s.tables.marketing_creative_intelligence_runs[0].status).toBe('failed')
    }
  })
})

describe('Organic Strategy inside the Creative Intelligence refresh', () => {
  it('stores the strategy in the same run\'s analytics with its model, prompt version and skill metadata', async () => {
    const s = storage(strongSample().posts)
    const result = await generateCreativeIntelligence(s.db, 'admin')
    expect(result).toMatchObject({ ok: true, partial: false, organic: 'completed' })
    const row = s.tables.marketing_creative_intelligence_runs[0] as { status: string; analytics: Record<string, unknown> & { organic_strategy: ReturnType<typeof storedStrategy> } }
    expect(row.status).toBe('completed')
    expect(row.analytics.organic_strategy).toMatchObject({
      status: 'completed', model: 'synthetic-model', prompt_version: '2026-10-08-v1',
      skill: { name: 'claude-ig', version: '2.0.0', ref: 'claude-ig@2.0.0#5e9b2d9', hash: 'a'.repeat(64) },
      evidence_window: { first_published: '2026-07-10', as_of: '2026-10-08' },
    })
    expect(row.analytics.organic_strategy.output).not.toBeNull()
    // The deterministic evidence is stored alongside it, unchanged in shape.
    expect(Object.keys(row.analytics)).toEqual(expect.arrayContaining(['window', 'posts', 'patterns', 'formats', 'exceptional', 'coverage', 'business_context', 'organic_strategy']))
  })

  it('runs after the interpretation, on the stored media and current fingerprints, with business context and followers', async () => {
    const order: string[] = []
    mocks.interpret.mockImplementation(async () => { order.push('interpretation'); return { ok: true, brain_take: null, insights: [], model: 'synthetic' } })
    mocks.organic.mockImplementation(async () => { order.push('organic'); return storedStrategy() })
    mocks.loadCtx.mockResolvedValue([{ update_id: 'u1' }])
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin')
    expect(order).toEqual(['interpretation', 'organic'])
    const arg = mocks.organic.mock.calls[0][0]
    expect(arg.media).toHaveLength(8)
    expect(arg.fingerprints).toHaveLength(8)
    expect(arg.businessContext).toEqual([{ update_id: 'u1' }])
    expect(arg.followersLatest).toBe(5000)
    expect(arg.now).toEqual(NOW)
  })

  it('keeps the interpretation blind to captions even though the strategist reads them', async () => {
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin')
    expect(JSON.stringify(mocks.interpret.mock.calls[0])).not.toContain('falafel')
    expect(mocks.organic.mock.calls[0][0].media[0].caption).toContain('falafel')
  })

  it('ISOLATES a failed Organic Strategy: classifications, analytics, signals and observations are all kept', async () => {
    const unavailable = storedStrategy({ status: 'unavailable', output: null, model: null, message: 'Organic Strategy analysis failed. Please try again.' })
    mocks.organic.mockResolvedValue(unavailable)
    mocks.interpret.mockResolvedValue({ ok: true, brain_take: 'Brain take that must survive.', insights: [{ signal_ids: ['x'], title: 't', insight: 'i', try_next: 'n' }], model: 'synthetic' })
    const s = storage(strongSample().posts)
    const result = await generateCreativeIntelligence(s.db, 'admin')
    expect(result).toMatchObject({ ok: true, partial: true, organic: 'unavailable' })
    expect(s.tables.marketing_content_fingerprints).toHaveLength(8)
    const row = s.tables.marketing_creative_intelligence_runs[0] as Record<string, unknown> & { analytics: Record<string, unknown> }
    expect(row).toMatchObject({ status: 'partial', model: 'synthetic', lease_expires_at: null, error: 'Organic Strategy is unavailable. The rest of this run is complete. Refresh again to retry.' })
    expect(row.observations).toHaveLength(1)
    expect(row.analytics.brain_take).toBe('Brain take that must survive.')
    expect(row.analytics.posts).toBeDefined()
    expect(row.analytics.organic_strategy).toMatchObject({ status: 'unavailable', output: null })
  })

  it('does not blame an unrelated failure on Organic Strategy, and keeps the interpretation error first', async () => {
    mocks.organic.mockResolvedValue(storedStrategy({ status: 'unavailable', output: null, message: 'x' }))
    mocks.interpret.mockResolvedValue({ ok: false, error: 'Interpretation unavailable.' })
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin')
    expect(s.tables.marketing_creative_intelligence_runs[0]).toMatchObject({ status: 'partial', error: 'Interpretation unavailable.' })
  })

  it('treats "not enough measured posts" as a normal state, not a partial run', async () => {
    mocks.organic.mockResolvedValue(storedStrategy({ status: 'skipped', output: null, message: 'Needs at least 3 posts.' }))
    const s = storage(strongSample().posts)
    expect(await generateCreativeIntelligence(s.db, 'admin')).toMatchObject({ ok: true, partial: false, organic: 'skipped' })
    expect(s.tables.marketing_creative_intelligence_runs[0]).toMatchObject({ status: 'completed', error: null })
  })

  it('does not run the strategist when a refresh is rejected as already running', async () => {
    const s = storage([], { locked: true })
    await generateCreativeIntelligence(s.db, 'admin')
    expect(mocks.organic).not.toHaveBeenCalled()
  })

  it('still fails the whole run on a genuine storage failure, and keeps earlier results', async () => {
    const s = storage(strongSample().posts, { failedFinalWrite: true })
    expect((await generateCreativeIntelligence(s.db, 'admin')).ok).toBe(false)
    expect(s.tables.marketing_creative_intelligence_runs[0].status).toBe('failed')
  })
})

describe('Marketing Brain v2 + Organic Strategy: two independently failure-isolated AI layers', () => {
  const insights = [{ signal_ids: ['x'], title: 'A grouped insight', insight: 'Two related Reels travelled further.', try_next: 'Try the same angle again.' }]
  const interpretationOk = { ok: true, brain_take: 'Brain take: the debate-style Reels travelled furthest.', insights, model: 'synthetic' }
  const interpretationFail = { ok: false, error: 'Interpretation unavailable. Deterministic evidence is still available.' }
  const organicOk = () => storedStrategy()
  const organicFail = () => storedStrategy({ status: 'unavailable', output: null, model: null, message: 'Organic Strategy analysis failed. Please try again.' })
  type Row = Record<string, unknown> & { status: string; error: string | null; observations: unknown[]; analytics: Record<string, unknown> }

  const cases: [string, unknown, () => ReturnType<typeof storedStrategy>, { status: string; briefTake: boolean; insights: number; organic: string; error: string | null }][] = [
    ['both layers succeed', interpretationOk, organicOk, { status: 'completed', briefTake: true, insights: 1, organic: 'completed', error: null }],
    ['only the interpretation fails', interpretationFail, organicOk, { status: 'partial', briefTake: false, insights: 0, organic: 'completed', error: interpretationFail.error }],
    ['only Organic Strategy fails', interpretationOk, organicFail, { status: 'partial', briefTake: true, insights: 1, organic: 'unavailable', error: 'Organic Strategy is unavailable. The rest of this run is complete. Refresh again to retry.' }],
    ['both layers fail', interpretationFail, organicFail, { status: 'partial', briefTake: false, insights: 0, organic: 'unavailable', error: interpretationFail.error }],
  ]
  it.each(cases)('%s: deterministic evidence is always kept, and each layer keeps its own result', async (_name, interp, organic, expected) => {
    mocks.interpret.mockResolvedValue(interp); mocks.organic.mockResolvedValue(organic())
    const s = storage(strongSample().posts)
    const result = await generateCreativeIntelligence(s.db, 'admin')
    expect(result.ok).toBe(true)
    const row = s.tables.marketing_creative_intelligence_runs[0] as Row
    expect(row.status).toBe(expected.status)
    expect(row.error).toBe(expected.error)
    expect(row.observations).toHaveLength(expected.insights)
    expect(Boolean(row.analytics.brain_take)).toBe(expected.briefTake)
    expect((row.analytics.organic_strategy as { status: string }).status).toBe(expected.organic)
    // Deterministic evidence is never lost, whatever the AI layers do.
    expect(s.tables.marketing_content_fingerprints).toHaveLength(8)
    for (const key of ['window', 'posts', 'patterns', 'formats', 'exceptional', 'coverage']) expect(row.analytics[key], key).toBeDefined()
    expect(row.lease_expires_at).toBeNull()
  })

  it('runs the strategist even when the interpretation failed: neither layer depends on the other', async () => {
    mocks.interpret.mockResolvedValue(interpretationFail)
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin')
    expect(mocks.organic).toHaveBeenCalledTimes(1)
  })

  it('keeps the v2 interpretation call exactly as before: only deterministic signals, business context and coverage facts', async () => {
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin')
    const [signals, , facts] = mocks.interpret.mock.calls[0]
    expect(Array.isArray(signals)).toBe(true)
    expect(facts).toEqual({ posts_in_analysis: 8, measured_posts: 8 })
    expect(JSON.stringify(mocks.interpret.mock.calls[0])).not.toMatch(/organic|claude-ig|caption/i)
  })

  it('does not start Organic Strategy before the interpretation has finished', async () => {
    const events: string[] = []
    mocks.interpret.mockImplementation(async () => { events.push('interpretation:start'); await Promise.resolve(); events.push('interpretation:end'); return interpretationOk })
    mocks.organic.mockImplementation(async () => { events.push('organic'); return organicOk() })
    await generateCreativeIntelligence(storage(strongSample().posts).db, 'admin')
    expect(events).toEqual(['interpretation:start', 'interpretation:end', 'organic'])
  })
})

describe('CMO Insights around a Creative Intelligence refresh', () => {
  const prior = { id: 'o1', kind: 'finding', statement: 'Process stories draw shares', strength: 'reasonable_inference', trend: 'steady', times_observed: 3, first_seen_at: '2026-09-01T09:00:00Z', last_supported_at: '2026-10-01T09:00:00Z' }
  it('hands prior organic and creative insights to the Organic Strategy step as context only', async () => {
    insights.prior.mockResolvedValue([prior])
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin-id', { now: NOW })
    expect(insights.prior).toHaveBeenCalledWith(s.db, ['organic', 'creative'])
    expect(mocks.organic.mock.calls[0][0]).toMatchObject({ priorInsights: [prior] })
    // the interpretation call is untouched: it still sees only deterministic signals
    expect(JSON.stringify(mocks.interpret.mock.calls[0])).not.toContain('Process stories draw shares')
  })
  it('records which insights informed a run whose strategist step completed, and captures the finished run', async () => {
    insights.prior.mockResolvedValue([prior])
    const s = storage(strongSample().posts)
    await generateCreativeIntelligence(s.db, 'admin-id', { now: NOW })
    expect(insights.informed).toHaveBeenCalledWith(s.db, ['o1'], { type: 'creative_run', runId: 'test-run' })
    expect(insights.capture).toHaveBeenCalledWith(s.db, 'test-run')
    expect(s.tables.marketing_creative_intelligence_runs[0]).toMatchObject({ status: expect.stringMatching(/completed|partial/) })
  })
  it('does not claim insights informed a run whose Organic Strategy step was unavailable', async () => {
    insights.prior.mockResolvedValue([prior])
    mocks.organic.mockResolvedValue(storedStrategy({ status: 'unavailable', output: null }))
    await generateCreativeIntelligence(storage(strongSample().posts).db, 'admin-id', { now: NOW })
    expect(insights.informed).not.toHaveBeenCalled()
  })
  it('never fails or delays the refresh because capture failed', async () => {
    insights.capture.mockRejectedValue(new Error('insights_storage'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = storage(strongSample().posts)
    expect(await generateCreativeIntelligence(s.db, 'admin-id', { now: NOW })).toMatchObject({ ok: true })
    expect(s.tables.marketing_creative_intelligence_runs[0]).toMatchObject({ error: expect.not.stringContaining('insight') })
    warn.mockRestore()
  })
  it('does not capture a refresh that failed', async () => {
    const s = storage(strongSample().posts, { failedFinalWrite: true })
    expect(await generateCreativeIntelligence(s.db, 'admin-id', { now: NOW })).toMatchObject({ ok: false })
    expect(insights.capture).not.toHaveBeenCalled()
  })
})
