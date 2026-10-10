/**
 * Tests for lib/meta/ig-insights-refresh.ts (core of the recent-post refresh
 * and the historical backfill) and the refresh step of syncIgOrganicDeep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildInsightsPatch,
  hasStoredMetrics,
  refreshIgInsights,
  type IgInsightsResult,
} from '@/lib/meta/ig-insights-refresh'

class RateLimit extends Error { constructor() { super('limit'); this.name = 'MetaRateLimitError' } }
const noSleep = async () => {}

describe('buildInsightsPatch', () => {
  it('omits missing metrics and never writes zero for them', () => {
    const p = buildInsightsPatch({ reach: 10, likes: 0, plays: undefined, comments: 3 })
    expect(p).toEqual({ reach: 10, likes: 0, comments_count: 3 })
    expect('plays' in p).toBe(false)
    expect('saved' in p).toBe(false)
  })
  it('returns an empty patch for empty insights', () => {
    expect(buildInsightsPatch({})).toEqual({})
    expect(buildInsightsPatch({ other_metrics_json: {} })).toEqual({})
  })
})

describe('hasStoredMetrics', () => {
  it('is false when all null, true when any present (including 0)', () => {
    expect(hasStoredMetrics({ reach: null, likes: null })).toBe(false)
    expect(hasStoredMetrics({ reach: null, likes: 0 })).toBe(true)
  })
})

describe('refreshIgInsights', () => {
  const targets = [
    { id: 'a', media_type: 'VIDEO' },
    { id: 'b', media_type: 'IMAGE' },
    { id: 'c', media_type: 'CAROUSEL_ALBUM' },
  ]
  const write = vi.fn()
  beforeEach(() => write.mockReset())

  it('writes only returned metrics for each target', async () => {
    const res = await refreshIgInsights({
      targets, maxCalls: 10, sleep: noSleep,
      fetchInsights: async (t) => ({ kind: 'ok', insights: { reach: t.id === 'a' ? 5 : 7 } }),
      writePatch: write,
    })
    expect(res).toMatchObject({ attempted: 3, updated: 3, rateLimited: false, remaining: 0 })
    expect(write).toHaveBeenCalledWith('a', { reach: 5 })
  })

  it('does not write when unavailable, empty or errored (no zeros)', async () => {
    const results: Record<string, IgInsightsResult> = {
      a: { kind: 'unavailable' }, b: { kind: 'ok', insights: {} }, c: { kind: 'error', message: 'x' },
    }
    const res = await refreshIgInsights({
      targets, maxCalls: 10, sleep: noSleep,
      fetchInsights: async (t) => results[t.id], writePatch: write,
    })
    expect(write).not.toHaveBeenCalled()
    expect(res.unavailable).toEqual(['a', 'b'])
    expect(res.errored).toEqual(['c'])
  })

  it('stops cleanly on rate limit and reports progress', async () => {
    const fetchInsights = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', insights: { reach: 1 } })
      .mockRejectedValueOnce(new RateLimit())
    const res = await refreshIgInsights({ targets, maxCalls: 10, sleep: noSleep, fetchInsights, writePatch: write })
    expect(res).toMatchObject({ attempted: 1, updated: 1, rateLimited: true, remaining: 2 })
    expect(fetchInsights).toHaveBeenCalledTimes(2)
  })

  it('respects the call budget', async () => {
    const fetchInsights = vi.fn().mockResolvedValue({ kind: 'ok', insights: { reach: 1 } })
    const res = await refreshIgInsights({ targets, maxCalls: 2, sleep: noSleep, fetchInsights, writePatch: write })
    expect(fetchInsights).toHaveBeenCalledTimes(2)
    expect(res.remaining).toBe(1)
  })

  it('is idempotent: re-running with the same data issues identical patches', async () => {
    const run = () => refreshIgInsights({
      targets, maxCalls: 10, sleep: noSleep,
      fetchInsights: async () => ({ kind: 'ok', insights: { reach: 9, likes: 2 } }),
      writePatch: write,
    })
    await run(); const first = write.mock.calls.slice()
    write.mockReset(); await run()
    expect(write.mock.calls).toEqual(first)
  })
})

// ── Sync integration: recent stored posts are refreshed ───────────────────────

const h = vi.hoisted(() => {
  const updates: Array<{ patch: Record<string, unknown>; id: string }> = []
  return {
    updates,
    fetchIgMedia: vi.fn(),
    fetchIgMediaInsights: vi.fn(),
    recentRows: [] as Array<{ id: string; media_type: string; published_at: string }>,
  }
})

vi.mock('@/lib/meta/auth', () => ({ hasMetaCredentials: () => true }))
vi.mock('@/lib/meta/client', () => ({
  fetchAdAccounts: vi.fn().mockResolvedValue([]), fetchCampaigns: vi.fn().mockResolvedValue([]),
  fetchAdSets: vi.fn().mockResolvedValue([]), fetchAds: vi.fn().mockResolvedValue([]),
  fetchAdInsights: vi.fn().mockResolvedValue([]), fetchCampaignInsights: vi.fn().mockResolvedValue([]),
  MetaRateLimitError: class MetaRateLimitError extends Error {},
}))
vi.mock('@/lib/meta/ig-client', () => ({
  fetchIgMedia: h.fetchIgMedia,
  fetchIgMediaInsights: h.fetchIgMediaInsights,
  fetchIgAccountDailyInsights: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/lib/meta/fb-client', () => ({
  fetchPageDailyInsights: vi.fn().mockResolvedValue({}), fetchFbPosts: vi.fn().mockResolvedValue([]),
  fetchFbPostInsights: vi.fn().mockResolvedValue(null), fetchLinkedIgAccountId: vi.fn().mockResolvedValue('ig_1'),
  fetchPageToken: vi.fn().mockResolvedValue('t'),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, is: self, gte: self, order: self, like: self,
        limit: () => Promise.resolve({ data: table === 'meta_ig_media' ? h.recentRows : [] }),
        maybeSingle: () => Promise.resolve({ data: null }),
        upsert: () => Promise.resolve({ error: null }),
        insert: () => Promise.resolve({ error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => { if (table === 'meta_ig_media') h.updates.push({ patch, id }); return Promise.resolve({ error: null }) },
        }),
      })
      return chain
    },
  }),
}))

describe('syncIgOrganicDeep refresh step', () => {
  beforeEach(() => {
    h.updates.length = 0
    h.fetchIgMedia.mockReset().mockResolvedValue([])
    h.fetchIgMediaInsights.mockReset()
    process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID = 'ig_1'
    process.env.META_AD_ACCOUNT_ID = 'act_1'
    delete process.env.META_FACEBOOK_PAGE_ID
  })

  it('refreshes insights for stored recent posts, not only new ones', async () => {
    h.recentRows = [
      { id: 'old1', media_type: 'VIDEO', published_at: new Date().toISOString() },
      { id: 'old2', media_type: 'IMAGE', published_at: new Date().toISOString() },
    ]
    h.fetchIgMediaInsights.mockResolvedValue({ reach: 42, likes: 3 })
    const { runMetaSync } = await import('@/lib/meta/sync')
    await runMetaSync()
    const ids = h.updates.map((u) => u.id).sort()
    expect(ids).toEqual(['old1', 'old2'])
    expect(h.updates[0].patch).toMatchObject({ reach: 42, likes: 3 })
    expect('plays' in h.updates[0].patch).toBe(false)
  })

  it('does not write when insights are unavailable (nulls preserved)', async () => {
    h.recentRows = [{ id: 'x', media_type: 'IMAGE', published_at: new Date().toISOString() }]
    h.fetchIgMediaInsights.mockResolvedValue(null)
    const { runMetaSync } = await import('@/lib/meta/sync')
    await runMetaSync()
    expect(h.updates).toHaveLength(0)
  })

  it('stops the refresh cleanly on a rate limit without failing the sync', async () => {
    h.recentRows = [
      { id: 'r1', media_type: 'IMAGE', published_at: new Date().toISOString() },
      { id: 'r2', media_type: 'IMAGE', published_at: new Date().toISOString() },
    ]
    const err = new Error('limit'); err.name = 'MetaRateLimitError'
    h.fetchIgMediaInsights.mockResolvedValueOnce({ reach: 1 }).mockRejectedValueOnce(err)
    const { runMetaSync } = await import('@/lib/meta/sync')
    const res = await runMetaSync()
    expect(res.errors ?? []).toEqual([])
    expect(h.updates.map((u) => u.id)).toEqual(['r1'])
  })
})
