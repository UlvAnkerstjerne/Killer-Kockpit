import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint, NOW, strongSample } from '../../../helpers/creative-brain'
import type { Media } from '@/lib/marketing/brain/types'
import type { createServiceClient } from '@/lib/supabase/server'
import { FingerprintSchema } from '@/lib/marketing/brain/taxonomy'
const mocks = vi.hoisted(() => ({ classify: vi.fn(), interpret: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/creative-classifier', () => ({ callCreativeClassifier: mocks.classify }))
vi.mock('@/lib/ai/creative-interpretation', () => ({ callCreativeInterpretation: mocks.interpret }))
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
  mocks.interpret.mockResolvedValue({ ok: true, observations: [], model: 'synthetic' })
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
