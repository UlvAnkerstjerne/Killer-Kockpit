/**
 * Tests for lib/actions/marketing/meta-assets.ts
 *
 * Server actions are self-authenticating — identity comes from getCurrentUser(),
 * never from the caller. Tests verify: auth gates, permission checks, DB queries.
 *
 * DB mock uses a per-table response queue with a lazy-thenable chain so that
 * any terminal call pattern (await .eq(), await .order(), await .limit()) works.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()

  // Globally tracked chain methods (for call-site assertions)
  const mockEq    = vi.fn()
  const mockGte   = vi.fn()
  const mockLte   = vi.fn()
  const mockLike  = vi.fn()
  const mockIs    = vi.fn()
  const mockOrder = vi.fn()
  const mockLimit = vi.fn()
  const mockSelect = vi.fn()
  const mockMaybeSingle = vi.fn()
  const mockSingle      = vi.fn()

  // Per-table response queue
  const tableQueues: Record<string, Array<{data: unknown, error: unknown}>> = {}

  function queueResponse(table: string, data: unknown) {
    if (!tableQueues[table]) tableQueues[table] = []
    tableQueues[table].push({ data, error: null })
  }

  function clearQueues() {
    for (const k of Object.keys(tableQueues)) delete tableQueues[k]
  }

  /**
   * Builds a lazy-thenable chain for a given table.
   *
   * Every chain method (eq, gte, lte, like, is, order) returns the chain itself.
   * The chain has a lazy `.then` getter so that `await chain` pops one item
   * from the table queue at the moment of await.
   * Terminal methods (limit, maybeSingle, single) also pop one item.
   * This means exactly one queue pop per from() call regardless of which
   * method terminates the chain.
   */
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    function respond() {
      const q = tableQueues[table] ?? []
      return Promise.resolve(q.shift() ?? { data: null, error: null })
    }

    const chain: any = {}

    mockEq.mockReturnValue(chain)
    mockGte.mockReturnValue(chain)
    mockLte.mockReturnValue(chain)
    mockLike.mockReturnValue(chain)
    mockIs.mockReturnValue(chain)
    mockOrder.mockReturnValue(chain)
    mockLimit.mockImplementation(() => respond())
    mockMaybeSingle.mockImplementation(() => respond())
    mockSingle.mockImplementation(() => respond())

    Object.assign(chain, {
      eq:          mockEq,
      gte:         mockGte,
      lte:         mockLte,
      like:        mockLike,
      is:          mockIs,
      order:       mockOrder,
      limit:       mockLimit,
      maybeSingle: mockMaybeSingle,
      single:      mockSingle,
    })

    // Lazy thenable: called when the chain object itself is awaited (e.g. `await .eq()`)
    Object.defineProperty(chain, 'then', {
      get: () => (...args: [any, any?]) => respond().then(...args),
      configurable: true,
    })
    Object.defineProperty(chain, 'catch', {
      get: () => (...args: [any]) => respond().catch(...args),
      configurable: true,
    })

    mockSelect.mockReturnValue(chain)

    return {
      select: mockSelect,
      upsert: vi.fn().mockResolvedValue({ error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }
  })

  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockEq, mockGte, mockLte, mockLike, mockIs, mockOrder, mockLimit, mockSelect,
    mockFrom, mockServiceClient,
    queueResponse, clearQueues,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  id: 'admin-id',
  role: 'SUPER_ADMIN' as const,
  marketing_access: false,
}

const MARKETING_USER = {
  id: 'mktg-user-id',
  role: 'MEMBER' as const,
  marketing_access: true,
}

const NO_ACCESS_USER = {
  id: 'member-id',
  role: 'MEMBER' as const,
  marketing_access: false,
}

const PAID_MANAGE_PERM = [{ permission: 'paid_manage' }]

// ── getMetaCampaigns ───────────────────────────────────────────────────────────

describe('getMetaCampaigns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearQueues()
  })

  it('returns empty array when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getMetaCampaigns } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getMetaCampaigns()).toEqual([])
    expect(mocks.mockFrom).not.toHaveBeenCalledWith('meta_ad_campaigns')
  })

  it('returns empty array when marketing_access is false for non-SUPER_ADMIN', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(NO_ACCESS_USER)
    const { getMetaCampaigns } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getMetaCampaigns()).toEqual([])
  })

  it('returns empty array when user has marketing_access but lacks paid_manage permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MARKETING_USER)
    // Permission query → no paid_manage rows
    mocks.queueResponse('user_marketing_permissions', [])
    const { getMetaCampaigns } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getMetaCampaigns()).toEqual([])
  })

  it('returns campaigns for SUPER_ADMIN (permission check bypassed)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // assertPaidManage fetches perm rows even for SUPER_ADMIN (hasMarketingPermission bypasses)
    mocks.queueResponse('user_marketing_permissions', [])
    const campaigns = [
      { id: 'c1', name: 'Summer 2026', status: 'ACTIVE', objective: 'OUTCOME_AWARENESS' },
    ]
    mocks.queueResponse('meta_ad_campaigns', campaigns)
    const { getMetaCampaigns } = await import('@/lib/actions/marketing/meta-assets')
    const result = await getMetaCampaigns()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Summer 2026')
  })

  it('returns campaigns for marketing user with paid_manage permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MARKETING_USER)
    mocks.queueResponse('user_marketing_permissions', PAID_MANAGE_PERM)
    const campaigns = [
      { id: 'c2', name: 'Winter 2026', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' },
    ]
    mocks.queueResponse('meta_ad_campaigns', campaigns)
    const { getMetaCampaigns } = await import('@/lib/actions/marketing/meta-assets')
    const result = await getMetaCampaigns()
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('PAUSED')
  })

  it('queries meta_ad_campaigns ordered by name', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.queueResponse('user_marketing_permissions', [])
    mocks.queueResponse('meta_ad_campaigns', [])
    const { getMetaCampaigns } = await import('@/lib/actions/marketing/meta-assets')
    await getMetaCampaigns()
    expect(mocks.mockFrom).toHaveBeenCalledWith('meta_ad_campaigns')
    expect(mocks.mockOrder).toHaveBeenCalledWith('name')
  })
})

// ── getMetaCampaignInsights ────────────────────────────────────────────────────

describe('getMetaCampaignInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearQueues()
  })

  it('returns empty array when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getMetaCampaignInsights } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getMetaCampaignInsights('c1', '2026-08-01', '2026-08-31')).toEqual([])
  })

  it('queries by campaign_id and date range', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.queueResponse('user_marketing_permissions', [])
    const rows = [{ campaign_id: 'c1', date_start: '2026-08-15', spend: '50.00', frequency: '2.5' }]
    mocks.queueResponse('meta_campaign_insights', rows)
    const { getMetaCampaignInsights } = await import('@/lib/actions/marketing/meta-assets')
    const result = await getMetaCampaignInsights('c1', '2026-08-01', '2026-08-31')
    expect(result).toHaveLength(1)
    expect(result[0].frequency).toBe('2.5')
    expect(mocks.mockFrom).toHaveBeenCalledWith('meta_campaign_insights')
    expect(mocks.mockEq).toHaveBeenCalledWith('campaign_id', 'c1')
    expect(mocks.mockGte).toHaveBeenCalledWith('date_start', '2026-08-01')
    expect(mocks.mockLte).toHaveBeenCalledWith('date_start', '2026-08-31')
  })
})

// ── getMetaSyncStatus ──────────────────────────────────────────────────────────

describe('getMetaSyncStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearQueues()
  })

  it('returns empty array when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getMetaSyncStatus } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getMetaSyncStatus()).toEqual([])
  })

  it('queries integration_sync_state with meta_% filter and user_id IS NULL', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.queueResponse('user_marketing_permissions', [])
    const rows = [
      { integration: 'meta_ads_daily', status: 'synced', cursor: '2026-08-30' },
      { integration: 'meta_ads_backfill', status: 'syncing', cursor: '2024-01-15' },
    ]
    mocks.queueResponse('integration_sync_state', rows)
    const { getMetaSyncStatus } = await import('@/lib/actions/marketing/meta-assets')
    const result = await getMetaSyncStatus()
    expect(mocks.mockFrom).toHaveBeenCalledWith('integration_sync_state')
    expect(mocks.mockLike).toHaveBeenCalledWith('integration', 'meta_%')
    expect(mocks.mockIs).toHaveBeenCalledWith('user_id', null)
    expect(result).toHaveLength(2)
    expect(result[0].integration).toBe('meta_ads_daily')
  })
})

// ── getIgMediaFeed ─────────────────────────────────────────────────────────────

describe('getIgMediaFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearQueues()
  })

  it('returns empty array when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getIgMediaFeed } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getIgMediaFeed()).toEqual([])
  })

  it('queries meta_ig_media with limit', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.queueResponse('user_marketing_permissions', [])
    mocks.queueResponse('meta_ig_media', [])
    const { getIgMediaFeed } = await import('@/lib/actions/marketing/meta-assets')
    await getIgMediaFeed(25)
    expect(mocks.mockFrom).toHaveBeenCalledWith('meta_ig_media')
    expect(mocks.mockLimit).toHaveBeenCalledWith(25)
  })
})

// ── getFbPageInsights ──────────────────────────────────────────────────────────

describe('getFbPageInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearQueues()
  })

  it('returns empty array when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getFbPageInsights } = await import('@/lib/actions/marketing/meta-assets')
    expect(await getFbPageInsights('2026-08-01', '2026-08-31')).toEqual([])
  })

  it('queries by date range', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.queueResponse('user_marketing_permissions', [])
    const rows = [{ page_id: 'p1', date: '2026-08-15', views: 1200, reach: 800 }]
    mocks.queueResponse('meta_fb_page_insights', rows)
    const { getFbPageInsights } = await import('@/lib/actions/marketing/meta-assets')
    const result = await getFbPageInsights('2026-08-01', '2026-08-31')
    expect(result).toHaveLength(1)
    expect(result[0].views).toBe(1200)
    expect(mocks.mockGte).toHaveBeenCalledWith('date', '2026-08-01')
    expect(mocks.mockLte).toHaveBeenCalledWith('date', '2026-08-31')
  })
})
