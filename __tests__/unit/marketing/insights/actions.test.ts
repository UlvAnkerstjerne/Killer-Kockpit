import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ user: vi.fn(), client: vi.fn(), service: vi.fn(), backfill: vi.fn(), revalidate: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: m.user }))
vi.mock('@/lib/supabase/server', () => ({ createClient: m.client, createServiceClient: m.service }))
vi.mock('@/lib/marketing/insights/service', () => ({ backfillInsights: m.backfill }))
import { captureMarketingInsights, getMarketingInsights } from '@/lib/actions/marketing/insights'
import { day, insightRow } from '../../../helpers/insights'

type Result = { data: unknown; error: unknown }
function readClient(tables: Record<string, Result>) {
  const calls: string[] = []
  const client = { from: (table: string) => {
    calls.push(table)
    const q: Record<string, unknown> = {}
    for (const k of ['select', 'order', 'limit', 'in']) q[k] = () => q
    q.then = (res: (v: Result) => unknown) => Promise.resolve(tables[table] ?? { data: [], error: null }).then(res)
    return q
  } }
  return { client, calls }
}
const admin = { id: 'u1', role: 'SUPER_ADMIN', marketing_access: true }
const member = { id: 'u2', role: 'UM', marketing_access: true }

beforeEach(() => { vi.clearAllMocks() })

describe('getMarketingInsights', () => {
  it('returns nothing and reads nothing for someone without marketing access', async () => {
    m.user.mockResolvedValue({ id: 'u3', role: 'MEMBER', marketing_access: false })
    const r = readClient({}); m.client.mockResolvedValue(r.client)
    expect(await getMarketingInsights()).toEqual({ allowed: false, canCapture: false, insights: [], error: null })
    expect(r.calls).toEqual([])
    m.user.mockResolvedValue(null)
    expect((await getMarketingInsights()).allowed).toBe(false)
  })
  it('reads with the user’s own client (so RLS decides), and only a SUPER_ADMIN can capture', async () => {
    const r = readClient({ marketing_insights: { data: [], error: null } }); m.client.mockResolvedValue(r.client)
    m.user.mockResolvedValue(admin)
    expect(await getMarketingInsights()).toMatchObject({ allowed: true, canCapture: true })
    m.user.mockResolvedValue(member)
    expect(await getMarketingInsights()).toMatchObject({ allowed: true, canCapture: false })
    expect(m.service).not.toHaveBeenCalled()
  })
  it('joins each insight with its history and links', async () => {
    const row = insightRow({ id: 'a' })
    const r = readClient({
      marketing_insights: { data: [row], error: null },
      marketing_insight_observations: { data: [{ insight_id: 'a', observed_at: day(8), strength: 'strong_pattern', change: 'strengthened' }, { insight_id: 'a', observed_at: day(1), strength: 'weak_signal', change: 'new' }], error: null },
      marketing_insight_links: { data: [{ insight_id: 'a', target_type: 'paid_strategy_recommendation', target_run_id: 'p1', target_index: 2, relation: 'derived_from' }], error: null },
    })
    m.client.mockResolvedValue(r.client); m.user.mockResolvedValue(member)
    const out = await getMarketingInsights()
    expect(out.insights).toHaveLength(1)
    expect(out.insights[0].history.map(h => h.change)).toEqual(['strengthened', 'new'])
    expect(out.insights[0].links).toEqual([{ target_type: 'paid_strategy_recommendation', target_run_id: 'p1', target_index: 2, relation: 'derived_from' }])
  })
  it('turns a missing table (migration not applied) into a calm message, not an error', async () => {
    const r = readClient({ marketing_insights: { data: null, error: { code: '42P01' } } }); m.client.mockResolvedValue(r.client)
    m.user.mockResolvedValue(admin)
    expect(await getMarketingInsights()).toMatchObject({ allowed: true, insights: [], error: expect.stringContaining('migration') })
  })
})

describe('captureMarketingInsights', () => {
  it('is SUPER_ADMIN only and checks before any service access', async () => {
    m.user.mockResolvedValue(null)
    expect(await captureMarketingInsights()).toEqual({ ok: false, error: 'Not authenticated' })
    m.user.mockResolvedValue(member)
    expect(await captureMarketingInsights()).toEqual({ ok: false, error: 'Only SUPER_ADMIN can capture insights.' })
    expect(m.service).not.toHaveBeenCalled(); expect(m.backfill).not.toHaveBeenCalled()
  })
  it('replays saved runs and refreshes both surfaces', async () => {
    m.user.mockResolvedValue(admin); m.service.mockReturnValue('svc')
    m.backfill.mockResolvedValue({ creative: 2, paid: 1, checklist: 1, created: 5, updated: 2 })
    expect(await captureMarketingInsights()).toEqual({ ok: true, message: 'Captured from 4 sources (saved runs and today’s Meta Ads checklist): 5 new, 2 updated.' })
    expect(m.backfill).toHaveBeenCalledWith('svc')
    expect(m.revalidate).toHaveBeenCalledWith('/marketing/brain'); expect(m.revalidate).toHaveBeenCalledWith('/marketing')
  })
  it('says so when there is nothing new, and reports a storage problem safely', async () => {
    m.user.mockResolvedValue(admin)
    m.backfill.mockResolvedValue({ creative: 0, paid: 0, checklist: 0, created: 0, updated: 0 })
    expect(await captureMarketingInsights()).toEqual({ ok: true, message: 'Everything saved was already captured.' })
    m.backfill.mockRejectedValue(new Error('insights_storage'))
    expect(await captureMarketingInsights()).toMatchObject({ ok: false, error: expect.stringContaining('migration') })
  })
})
