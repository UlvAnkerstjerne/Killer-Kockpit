/**
 * Tests for lib/meta/sync.ts
 *
 * Focused on observable behaviour of runMetaSync() and discoverMetaAssets().
 * All Graph API calls, DB calls, and auth checks are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Meta client functions
  const mockFetchAdAccounts        = vi.fn().mockResolvedValue([])
  const mockFetchCampaigns         = vi.fn().mockResolvedValue([])
  const mockFetchAdSets            = vi.fn().mockResolvedValue([])
  const mockFetchAds               = vi.fn().mockResolvedValue([])
  const mockFetchAdInsights        = vi.fn().mockResolvedValue([])
  const mockFetchCampaignInsights  = vi.fn().mockResolvedValue([])

  // IG / FB client functions
  const mockFetchIgMedia                = vi.fn().mockResolvedValue([])
  const mockFetchIgMediaInsights        = vi.fn().mockResolvedValue(null)
  const mockFetchIgAccountDailyInsights = vi.fn().mockResolvedValue({})
  const mockFetchPageDailyInsights      = vi.fn().mockResolvedValue({})
  const mockFetchFbPosts                = vi.fn().mockResolvedValue([])
  const mockFetchFbPostInsights         = vi.fn().mockResolvedValue(null)
  const mockFetchLinkedIgAccountId      = vi.fn().mockResolvedValue('ig_123')
  const mockFetchPageToken              = vi.fn().mockResolvedValue('mock-page-token')

  // Auth
  const mockHasMetaCredentials = vi.fn().mockReturnValue(true)

  // DB: per-table response queue
  const tableQueues: Record<string, Array<{data: unknown, error: unknown}>> = {}

  function queueResponse(table: string, data: unknown) {
    if (!tableQueues[table]) tableQueues[table] = []
    tableQueues[table].push({ data, error: null })
  }

  function clearQueues() {
    for (const k of Object.keys(tableQueues)) delete tableQueues[k]
  }

  const mockUpsert = vi.fn().mockResolvedValue({ error: null })
  const mockInsert = vi.fn().mockResolvedValue({ error: null })
  const mockUpdate = vi.fn()
  const mockEq     = vi.fn()
  const mockIs     = vi.fn()
  const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null })

  // Default chain: all sync state queries return null (no existing row → insert path)
  mockEq.mockReturnValue({ eq: mockEq, is: mockIs, maybeSingle: mockMaybeSingle, single: vi.fn().mockResolvedValue({ data: null }) })
  mockIs.mockReturnValue({ maybeSingle: mockMaybeSingle })
  mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

  const mockSelect = vi.fn().mockReturnValue({
    eq:          mockEq,
    is:          mockIs,
    maybeSingle: mockMaybeSingle,
    order:       vi.fn().mockReturnValue({ data: [], error: null }),
    like:        vi.fn().mockResolvedValue({ data: [], error: null }),
  })

  const mockFrom = vi.fn().mockReturnValue({
    select: mockSelect,
    upsert: mockUpsert,
    insert: mockInsert,
    update: mockUpdate,
  })

  const mockServiceClient = { from: mockFrom }
  const mockCreateServiceClient = vi.fn().mockReturnValue(mockServiceClient)

  return {
    mockFetchAdAccounts,
    mockFetchCampaigns,
    mockFetchAdSets,
    mockFetchAds,
    mockFetchAdInsights,
    mockFetchCampaignInsights,
    mockFetchIgMedia,
    mockFetchIgMediaInsights,
    mockFetchIgAccountDailyInsights,
    mockFetchPageDailyInsights,
    mockFetchFbPosts,
    mockFetchFbPostInsights,
    mockFetchLinkedIgAccountId,
    mockFetchPageToken,
    mockHasMetaCredentials,
    mockFrom,
    mockUpsert,
    mockInsert,
    mockServiceClient,
    mockCreateServiceClient,
    queueResponse,
    clearQueues,
  }
})

vi.mock('@/lib/meta/auth', () => ({
  hasMetaCredentials: mocks.mockHasMetaCredentials,
}))
vi.mock('@/lib/meta/client', () => ({
  fetchAdAccounts:       mocks.mockFetchAdAccounts,
  fetchCampaigns:        mocks.mockFetchCampaigns,
  fetchAdSets:           mocks.mockFetchAdSets,
  fetchAds:              mocks.mockFetchAds,
  fetchAdInsights:       mocks.mockFetchAdInsights,
  fetchCampaignInsights: mocks.mockFetchCampaignInsights,
  MetaRateLimitError:    class MetaRateLimitError extends Error {},
}))
vi.mock('@/lib/meta/ig-client', () => ({
  fetchIgMedia:                mocks.mockFetchIgMedia,
  fetchIgMediaInsights:        mocks.mockFetchIgMediaInsights,
  fetchIgAccountDailyInsights: mocks.mockFetchIgAccountDailyInsights,
}))
vi.mock('@/lib/meta/fb-client', () => ({
  fetchPageDailyInsights:  mocks.mockFetchPageDailyInsights,
  fetchFbPosts:            mocks.mockFetchFbPosts,
  fetchFbPostInsights:     mocks.mockFetchFbPostInsights,
  fetchLinkedIgAccountId:  mocks.mockFetchLinkedIgAccountId,
  fetchPageToken:          mocks.mockFetchPageToken,
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.mockCreateServiceClient,
}))

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('runMetaSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockHasMetaCredentials.mockReturnValue(true)
    mocks.mockFetchAdAccounts.mockResolvedValue([])
    mocks.mockFetchCampaigns.mockResolvedValue([])
    mocks.mockFetchAdInsights.mockResolvedValue([])
    mocks.mockFetchCampaignInsights.mockResolvedValue([])
    mocks.mockFetchIgAccountDailyInsights.mockResolvedValue({})
    mocks.mockFetchPageDailyInsights.mockResolvedValue({})
    mocks.mockFetchIgMedia.mockResolvedValue([])
    mocks.mockFetchFbPosts.mockResolvedValue([])
    mocks.mockFetchPageToken.mockResolvedValue('mock-page-token')
    mocks.mockUpsert.mockResolvedValue({ error: null })
    mocks.mockInsert.mockResolvedValue({ error: null })
    delete process.env.META_AD_ACCOUNT_ID
    delete process.env.META_FACEBOOK_PAGE_ID
    delete process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID
  })

  it('returns error immediately when credentials missing', async () => {
    mocks.mockHasMetaCredentials.mockReturnValue(false)
    const { runMetaSync } = await import('@/lib/meta/sync')
    const result = await runMetaSync()
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/META_SYSTEM_USER_TOKEN/)
    expect(mocks.mockFetchAdAccounts).not.toHaveBeenCalled()
  })

  it('returns error when META_AD_ACCOUNT_ID not set', async () => {
    const { runMetaSync } = await import('@/lib/meta/sync')
    const result = await runMetaSync()
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/META_AD_ACCOUNT_ID/)
    expect(mocks.mockFetchAdAccounts).not.toHaveBeenCalled()
  })

  it('returns ok:true when ad structure and insights succeed', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    const { runMetaSync } = await import('@/lib/meta/sync')
    const result = await runMetaSync()
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('continues to remaining sections when one section throws', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    process.env.META_FACEBOOK_PAGE_ID = 'page_456'
    mocks.mockFetchAdAccounts.mockRejectedValueOnce(new Error('Network error'))
    const { runMetaSync } = await import('@/lib/meta/sync')
    const result = await runMetaSync()
    expect(result.errors.some((e) => e.includes('Ad structure'))).toBe(true)
    // Paid daily should still have been attempted
    expect(mocks.mockFetchAdInsights).toHaveBeenCalled()
  })

  it('does not throw even when all sections fail', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    const err = new Error('API down')
    mocks.mockFetchAdAccounts.mockRejectedValueOnce(err)
    mocks.mockFetchAdInsights.mockRejectedValueOnce(err)
    mocks.mockFetchCampaignInsights.mockRejectedValueOnce(err)
    const { runMetaSync } = await import('@/lib/meta/sync')
    await expect(runMetaSync()).resolves.toBeDefined()
  })

  it('skips IG sections when META_INSTAGRAM_BUSINESS_ACCOUNT_ID not set', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    const { runMetaSync } = await import('@/lib/meta/sync')
    await runMetaSync()
    expect(mocks.mockFetchIgAccountDailyInsights).not.toHaveBeenCalled()
    expect(mocks.mockFetchIgMedia).not.toHaveBeenCalled()
  })

  it('skips FB sections when META_FACEBOOK_PAGE_ID not set', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    const { runMetaSync } = await import('@/lib/meta/sync')
    await runMetaSync()
    expect(mocks.mockFetchPageDailyInsights).not.toHaveBeenCalled()
    expect(mocks.mockFetchFbPosts).not.toHaveBeenCalled()
  })

  it('runs IG + FB sections when env vars are set', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID = 'ig_789'
    process.env.META_FACEBOOK_PAGE_ID = 'page_456'
    mocks.mockFetchIgAccountDailyInsights.mockResolvedValue({
      reach: 500, accounts_engaged: 100, profile_views: 50, followers_count: 2000, other_metrics_json: null,
    })
    mocks.mockFetchPageDailyInsights.mockResolvedValue({
      views: 300, reach: 200, engaged_users: 80, fan_count: 1500, other_metrics_json: null,
    })
    const { runMetaSync } = await import('@/lib/meta/sync')
    const result = await runMetaSync()
    expect(result.ok).toBe(true)
    expect(mocks.mockFetchIgAccountDailyInsights).toHaveBeenCalledWith('ig_789', expect.any(String))
    expect(mocks.mockFetchPageDailyInsights).toHaveBeenCalledWith('page_456', expect.any(String))
  })

  it('fetches both ad-level and campaign-level insights (non-additive reach)', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    const { runMetaSync } = await import('@/lib/meta/sync')
    await runMetaSync()
    expect(mocks.mockFetchAdInsights).toHaveBeenCalledWith('act_123', expect.any(String), expect.any(String))
    expect(mocks.mockFetchCampaignInsights).toHaveBeenCalledWith('act_123', expect.any(String), expect.any(String))
  })

  it('summary string reflects error count', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_123'
    mocks.mockFetchAdAccounts.mockRejectedValueOnce(new Error('fail'))
    const { runMetaSync } = await import('@/lib/meta/sync')
    const result = await runMetaSync()
    expect(result.summary).toMatch(/error/)
  })
})

describe('discoverMetaAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockHasMetaCredentials.mockReturnValue(true)
    mocks.mockFetchAdAccounts.mockResolvedValue([])
    mocks.mockFetchLinkedIgAccountId.mockResolvedValue('ig_123')
    delete process.env.META_FACEBOOK_PAGE_ID
  })

  it('returns error when credentials missing', async () => {
    mocks.mockHasMetaCredentials.mockReturnValue(false)
    const { discoverMetaAssets } = await import('@/lib/meta/sync')
    const result = await discoverMetaAssets()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/META_SYSTEM_USER_TOKEN/)
  })

  it('returns ad accounts list', async () => {
    mocks.mockFetchAdAccounts.mockResolvedValue([
      { id: 'act_123', name: 'Killer Kebab Ads', currency: 'DKK', account_status: 1 },
    ])
    const { discoverMetaAssets } = await import('@/lib/meta/sync')
    const result = await discoverMetaAssets()
    expect(result.ok).toBe(true)
    expect(result.data?.adAccounts).toHaveLength(1)
  })

  it('discovers linked IG account when META_FACEBOOK_PAGE_ID set', async () => {
    process.env.META_FACEBOOK_PAGE_ID = 'page_456'
    mocks.mockFetchLinkedIgAccountId.mockResolvedValue('ig_789')
    const { discoverMetaAssets } = await import('@/lib/meta/sync')
    const result = await discoverMetaAssets()
    expect(result.ok).toBe(true)
    expect(result.data?.linkedIgAccountId).toBe('ig_789')
  })

  it('linkedIgAccountId is null when META_FACEBOOK_PAGE_ID not set', async () => {
    const { discoverMetaAssets } = await import('@/lib/meta/sync')
    const result = await discoverMetaAssets()
    expect(result.ok).toBe(true)
    expect(result.data?.linkedIgAccountId).toBeNull()
    expect(mocks.mockFetchLinkedIgAccountId).not.toHaveBeenCalled()
  })

  it('returns ok:false with error message when API throws', async () => {
    mocks.mockFetchAdAccounts.mockRejectedValueOnce(new Error('Graph API down'))
    const { discoverMetaAssets } = await import('@/lib/meta/sync')
    const result = await discoverMetaAssets()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Graph API down/)
  })

  it('does not write to the database', async () => {
    const { discoverMetaAssets } = await import('@/lib/meta/sync')
    await discoverMetaAssets()
    expect(mocks.mockUpsert).not.toHaveBeenCalled()
    expect(mocks.mockInsert).not.toHaveBeenCalled()
  })
})
