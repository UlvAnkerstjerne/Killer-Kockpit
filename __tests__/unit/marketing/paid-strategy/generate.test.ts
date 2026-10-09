import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT, IDS, NOW, rec, strategyInputs } from '../../../helpers/paid-strategy'
import type { createServiceClient } from '@/lib/supabase/server'
import type { LoadedSkill } from '@/lib/ai/skills/mesper'

const mocks = vi.hoisted(() => ({ ai: vi.fn(), loadSkill: vi.fn() }))
const insights = vi.hoisted(() => ({ prior: vi.fn(), capture: vi.fn(), informed: vi.fn(), checks: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/paid-strategy', () => ({ callPaidStrategyAI: mocks.ai, PAID_STRATEGY_PROMPT_VERSION: 'test-v1' }))
vi.mock('@/lib/ai/skills/mesper', () => ({ loadMesperSkill: mocks.loadSkill }))
vi.mock('@/lib/marketing/insights/prior', async orig => ({ ...(await orig<typeof import('@/lib/marketing/insights/prior')>()), loadPriorInsights: insights.prior }))
vi.mock('@/lib/marketing/insights/service', async orig => ({ ...(await orig<typeof import('@/lib/marketing/insights/service')>()), capturePaidRunById: insights.capture, recordInformedQuietly: insights.informed, captureFacebookAdsChecks: insights.checks }))
import { generatePaidStrategy } from '@/lib/marketing/paid-strategy/generate'

const skill: LoadedSkill = { name: 'mesper-meta-ads', version: '2.1.0', ref: 'mesper-meta-ads@2.1.0#cbfc19c', hash: 'c'.repeat(64), text: 'skill' }
const RUNS = 'marketing_paid_strategy_runs'

// A transport fake for orchestration and error sequencing. SQL semantics and RLS are
// exercised against real PostgreSQL in migration.test.ts.
type Row = Record<string, unknown>
function storage(opts: { locked?: boolean; failedRead?: boolean; failedFinalWrite?: boolean; empty?: boolean; staleRun?: boolean } = {}) {
  const input = strategyInputs()
  const tables: Record<string, Row[]> = {
    meta_ad_accounts: [{ id: 'act_1', currency: 'DKK' }],
    meta_ad_campaigns: opts.empty ? [] : input.campaigns as unknown as Row[],
    meta_ad_sets: input.adSets as unknown as Row[],
    meta_ads: input.ads as unknown as Row[],
    meta_campaign_insights: opts.empty ? [] : input.campaignInsights as unknown as Row[],
    meta_ad_insights: opts.empty ? [] : input.adInsights as unknown as Row[],
    [RUNS]: opts.staleRun ? [{ id: 'stale', status: 'running', lease_expires_at: '2026-10-08T09:00:00.000Z' }] : [],
    paid_recommendations: [],
  }
  const mutations: string[] = []
  const from = vi.fn((table: string) => {
    let operation = 'read'; let payload: Row = {}; let single = false; let range: [number, number] | null = null
    const filters: ((row: Row) => boolean)[] = []
    const q = {
      select: () => q, order: () => q,
      range: (a: number, b: number) => { range = [a, b]; return q },
      eq: (key: string, value: unknown) => { filters.push(r => r[key] === value); return q },
      lt: (key: string, value: string) => { filters.push(r => String(r[key]) < value); return q },
      gte: (key: string, value: string) => { filters.push(r => String(r[key]) >= value); return q },
      lte: (key: string, value: string) => { filters.push(r => String(r[key]) <= value); return q },
      insert: (data: Row) => { operation = 'insert'; payload = data; return q },
      update: (data: Row) => { operation = 'update'; payload = data; return q },
      single: () => { single = true; return q },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (operation !== 'read') mutations.push(table)
        if (opts.locked && operation === 'insert') return Promise.resolve(resolve({ data: null, error: { code: '23505' } }))
        if (opts.failedRead && operation === 'read' && table === 'meta_ads') return Promise.resolve(resolve({ data: null, error: { code: 'XX' } }))
        if (opts.failedFinalWrite && operation === 'update' && payload.status === 'completed') return Promise.resolve(resolve({ data: null, error: { code: 'XX' } }))
        let rows = tables[table].filter(row => filters.every(f => f(row)))
        if (operation === 'insert') { const row = { id: 'test-run', ...payload }; tables[table].push(row); rows = [row] }
        if (operation === 'update') rows.forEach(row => Object.assign(row, payload))
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
  mocks.loadSkill.mockReturnValue(skill)
  insights.prior.mockResolvedValue([]); insights.capture.mockResolvedValue({ skipped: false, created: 0, updated: 0, unconfirmed: 0 }); insights.informed.mockResolvedValue(undefined); insights.checks.mockResolvedValue({ skipped: false, created: 0, updated: 0, unconfirmed: 0 })
  mocks.ai.mockResolvedValue({ ok: true, recommendations: [rec(1), rec(2, { title: 'Second distinct idea' }), rec(3, { title: 'Third distinct idea' })], model: 'synthetic-model', durationMs: 5 })
})
afterEach(() => vi.useRealTimers())

describe('Paid Strategy run orchestration and persistence', () => {
  it('persists a completed run with provenance, evidence and the recommendations', async () => {
    const s = storage()
    const result = await generatePaidStrategy(s.db, 'admin-id')
    expect(result).toMatchObject({ ok: true, runId: 'test-run', recommendationCount: 3 })
    const row = s.tables[RUNS][0]
    expect(row).toMatchObject({
      status: 'completed', requested_by: 'admin-id', lease_expires_at: null, model: 'synthetic-model', error: null,
      window_start: CURRENT.start, window_end: CURRENT.end, prompt_version: 'test-v1', skill_ref: skill.ref, skill_hash: skill.hash,
    })
    expect(row.recommendations).toHaveLength(3)
    expect((row.evidence as { schema_version: string }).schema_version).toBe('paid-strategy-evidence-v1')
  })
  it('writes only to the strategy run table: never to paid_recommendations or execution state', async () => {
    const s = storage()
    await generatePaidStrategy(s.db, 'admin-id')
    expect(new Set(s.mutations)).toEqual(new Set([RUNS]))
    expect(s.tables.paid_recommendations).toHaveLength(0)
    expect(s.from).not.toHaveBeenCalledWith('paid_recommendations')
    expect(s.from).not.toHaveBeenCalledWith('paid_recommendation_execution_events')
  })
  it('sends the model whitelisted evidence with no platform IDs and passes the verified skill', async () => {
    const s = storage()
    await generatePaidStrategy(s.db, 'admin-id')
    const [passedSkill, evidence] = mocks.ai.mock.calls[0]
    expect(passedSkill).toBe(skill)
    const json = JSON.stringify(evidence)
    for (const id of Object.values(IDS)) expect(json).not.toContain(id)
    expect(JSON.stringify(s.tables[RUNS][0].evidence)).toBe(json)
  })
  it('marks the run failed with a safe message when the AI call fails', async () => {
    mocks.ai.mockResolvedValue({ ok: false, error: 'Paid strategy analysis failed. Please try again.', errorDetail: 'secret detail' })
    const s = storage()
    expect(await generatePaidStrategy(s.db, 'admin-id')).toEqual({ ok: false, error: 'Paid strategy analysis failed. Please try again.' })
    expect(s.tables[RUNS][0]).toMatchObject({ status: 'failed', lease_expires_at: null, error: 'Paid strategy analysis failed. Please try again.' })
    expect(JSON.stringify(s.tables[RUNS][0])).not.toContain('secret detail')
  })
  it('rejects a simultaneous run before any read or AI work', async () => {
    const s = storage({ locked: true })
    expect(await generatePaidStrategy(s.db, 'admin-id')).toMatchObject({ ok: false, error: expect.stringContaining('already running') })
    expect(mocks.ai).not.toHaveBeenCalled()
    expect(s.from).not.toHaveBeenCalledWith('meta_ad_campaigns')
  })
  it('expires an interrupted run whose lease has lapsed before claiming a new one', async () => {
    const s = storage({ staleRun: true })
    await generatePaidStrategy(s.db, 'admin-id')
    expect(s.tables[RUNS].find(r => r.id === 'stale')).toMatchObject({ status: 'failed', lease_expires_at: null })
    expect(s.tables[RUNS].find(r => r.id === 'test-run')).toMatchObject({ status: 'completed' })
  })
  it('fails the run, without calling the AI, when stored Meta data cannot be read or is empty', async () => {
    const unreadable = storage({ failedRead: true })
    expect((await generatePaidStrategy(unreadable.db, 'admin-id')).ok).toBe(false)
    expect(unreadable.tables[RUNS][0].status).toBe('failed')
    const empty = storage({ empty: true })
    expect(await generatePaidStrategy(empty.db, 'admin-id')).toMatchObject({ ok: false, error: expect.stringContaining('nothing to analyse') })
    expect(empty.tables[RUNS][0].status).toBe('failed')
    expect(mocks.ai).not.toHaveBeenCalled()
  })
  it('records a failed run if the final write fails, preserving earlier completed runs', async () => {
    const s = storage({ failedFinalWrite: true })
    s.tables[RUNS].push({ id: 'earlier', status: 'completed', recommendations: [rec(1)] })
    expect((await generatePaidStrategy(s.db, 'admin-id')).ok).toBe(false)
    expect(s.tables[RUNS].find(r => r.id === 'test-run')?.status).toBe('failed')
    expect(s.tables[RUNS].find(r => r.id === 'earlier')).toMatchObject({ status: 'completed' })
  })
  it('does not run, claim or read anything when the pinned skill fails verification', async () => {
    mocks.loadSkill.mockImplementation(() => { throw new Error('MESPER skill file does not match its pinned hash: SKILL.md') })
    const s = storage()
    const result = await generatePaidStrategy(s.db, 'admin-id')
    expect(result).toEqual({ ok: false, error: 'The pinned MESPER skill files could not be verified. No analysis was run.' })
    expect(s.from).not.toHaveBeenCalled()
    expect(mocks.ai).not.toHaveBeenCalled()
  })
})

describe('CMO Insights around a Paid Strategy run', () => {
  const prior = { id: 'i1', kind: 'finding', statement: 'Lead tracking is not set up end to end', strength: 'hypothesis', trend: 'steady', times_observed: 2, first_seen_at: '2026-09-20T09:00:00Z', last_supported_at: '2026-10-01T09:00:00Z' }
  it('gives the model prior insights as labelled context and records which insights informed the run', async () => {
    insights.prior.mockResolvedValue([prior])
    const s = storage()
    expect(await generatePaidStrategy(s.db, 'admin-id')).toMatchObject({ ok: true, runId: 'test-run' })
    const evidence = mocks.ai.mock.calls[0][1] as { prior_insights?: { items: { statement: string }[] } }
    expect(evidence.prior_insights?.items).toHaveLength(1)
    expect(evidence.prior_insights?.items[0].statement).toBe('DATA:Lead tracking is not set up end to end')
    expect(insights.prior).toHaveBeenCalledWith(s.db, ['paid'])
    expect(insights.informed).toHaveBeenCalledWith(s.db, ['i1'], { type: 'paid_strategy_run', runId: 'test-run' })
    expect(JSON.stringify(s.tables[RUNS][0].evidence)).toContain('prior_insights') // the exact evidence is stored with the run
  })
  it('a first run, with no insights yet, sends exactly the evidence it always did', async () => {
    await generatePaidStrategy(storage().db, 'admin-id')
    expect(mocks.ai.mock.calls[0][1]).not.toHaveProperty('prior_insights')
  })
  it('captures the insights of a completed run after saving it', async () => {
    const s = storage()
    await generatePaidStrategy(s.db, 'admin-id')
    expect(insights.capture).toHaveBeenCalledWith(s.db, 'test-run')
    expect(s.tables[RUNS][0]).toMatchObject({ status: 'completed' }) // saved before capturing
  })
  it('never fails the run because capture failed (for example the migration is not applied yet)', async () => {
    insights.capture.mockRejectedValue(new Error('insights_storage'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = storage()
    expect(await generatePaidStrategy(s.db, 'admin-id')).toMatchObject({ ok: true, recommendationCount: 3 })
    expect(s.tables[RUNS][0]).toMatchObject({ status: 'completed', error: null })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture skipped'))
    warn.mockRestore()
  })
  it('does not capture or record anything for a run that failed', async () => {
    mocks.ai.mockResolvedValue({ ok: false, error: 'AI model did not return a valid response.' })
    insights.prior.mockResolvedValue([prior])
    await generatePaidStrategy(storage().db, 'admin-id')
    expect(insights.capture).not.toHaveBeenCalled()
    expect(insights.informed).not.toHaveBeenCalled()
  })
  it('evaluates the Meta Ads checklist on the very rows the run read, after saving the run', async () => {
    const s = storage()
    await generatePaidStrategy(s.db, 'admin-id')
    expect(insights.checks).toHaveBeenCalledTimes(1)
    const [db, input] = insights.checks.mock.calls[0]
    expect(db).toBe(s.db)
    expect(input).toMatchObject({ currency: 'DKK', campaigns: s.tables.meta_ad_campaigns, adSets: s.tables.meta_ad_sets, ads: s.tables.meta_ads })
    expect(input.campaignInsights).toEqual(s.tables.meta_campaign_insights)
    expect(s.tables[RUNS][0]).toMatchObject({ status: 'completed' })
  })
  it('never fails the run because the checklist failed, and still captures the run’s own insights', async () => {
    insights.checks.mockRejectedValue(new Error('insights_storage'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = storage()
    expect(await generatePaidStrategy(s.db, 'admin-id')).toMatchObject({ ok: true, recommendationCount: 3 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('facebook-ads checklist'))
    expect(insights.capture).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('does not evaluate the checklist for a run that failed', async () => {
    mocks.ai.mockResolvedValue({ ok: false, error: 'AI model did not return a valid response.' })
    await generatePaidStrategy(storage().db, 'admin-id')
    expect(insights.checks).not.toHaveBeenCalled()
  })
})
