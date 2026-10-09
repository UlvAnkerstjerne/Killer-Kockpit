import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { backfillInsights, BACKFILL_RUNS_PER_SOURCE, captureQuietly } from '@/lib/marketing/insights/service'
import { creativeRunAt, day, paidRunAt } from '../../../helpers/insights'

afterEach(() => vi.restoreAllMocks())

describe('captureQuietly', () => {
  it('swallows and logs any failure so the run it describes is never affected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(captureQuietly('x', async () => { throw new Error('relation "marketing_insights" does not exist') })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture skipped'))
  })
})

/** A fake that serves saved runs and an empty insight store, recording what gets written. */
function fakeDb(creative: { id: string; at: string }[], paid: { id: string; at: string }[]) {
  const writes: { table: string; rows: unknown }[] = []
  const created: Record<string, unknown>[] = []
  const runs = new Map<string, unknown>([
    ...creative.map(r => [r.id, creativeRunAt(r.id, r.at)] as const),
    ...paid.map(r => [r.id, paidRunAt(r.id, r.at)] as const),
  ])
  const db = { from: (table: string) => {
    let id: string | null = null; let op = 'read'; let payload: unknown; let limit = 1000
    const q: Record<string, unknown> = {}
    const done = () => {
      if (table === 'marketing_creative_intelligence_runs' || table === 'marketing_paid_strategy_runs') {
        if (id) return { data: runs.get(id) ?? null, error: null }
        const list = (table.includes('creative') ? creative : paid).slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
        return { data: list.map(r => ({ id: r.id })), error: null }
      }
      if (op === 'insert') { const row = { id: `ins-${created.length + 1}`, ...(payload as object) }; created.push(row); writes.push({ table, rows: payload }); return { data: row, error: null } }
      if (op !== 'read') { writes.push({ table, rows: payload }); return { data: null, error: null } }
      return { data: table === 'marketing_insights' ? created : [], error: null }
    }
    q.select = () => q; q.order = () => q; q.in = () => q
    q.eq = (k: string, v: unknown) => { if (k === 'id') id = v as string; return q }
    q.limit = (n: number) => { limit = n; return q }
    q.maybeSingle = async () => done(); q.single = async () => done()
    q.insert = (p: unknown) => { op = 'insert'; payload = p; return q }
    q.update = (p: unknown) => { op = 'update'; payload = p; return q }
    q.upsert = (p: unknown) => { op = 'upsert'; payload = p; return q }
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(done()).then(res)
    return q
  } }
  return { db: db as never, writes, created }
}

describe('backfillInsights', () => {
  it('replays the latest runs of each source, oldest first, so history is in real order', async () => {
    const f = fakeDb([{ id: 'c2', at: day(9) }, { id: 'c1', at: day(2) }], [{ id: 'p1', at: day(3) }])
    const out = await backfillInsights(f.db)
    expect(out.creative).toBe(2); expect(out.paid).toBe(1)
    const observed = f.writes.filter(w => w.table === 'marketing_insight_observations').flatMap(w => (w.rows as { source_run_id: string }[]).map(r => r.source_run_id))
    expect(observed.indexOf('c1')).toBeLessThan(observed.indexOf('c2'))
    expect(BACKFILL_RUNS_PER_SOURCE).toBeGreaterThanOrEqual(2)
  })
})
