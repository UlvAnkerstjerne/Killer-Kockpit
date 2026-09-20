/**
 * Tests for getGbpPerformance server action.
 *
 * Verifies: auth gate, metric aggregation, location filtering, keyword handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser     = vi.fn()
  const mockCanAccessMarketing = vi.fn()
  const mockFrom               = vi.fn()

  return { mockGetCurrentUser, mockCanAccessMarketing, mockFrom }
})

vi.mock('@/lib/auth',        () => ({ getCurrentUser:     mocks.mockGetCurrentUser }))
vi.mock('@/lib/permissions', () => ({ canAccessMarketing: mocks.mockCanAccessMarketing }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: mocks.mockFrom }),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

const SUPER_ADMIN = { id: 'u1', role: 'SUPER_ADMIN', marketing_access: true }

/** Build a chainable query stub that resolves with data. */
function q(data: unknown) {
  const stub: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'not', 'in', 'gte', 'lte', 'order']) {
    stub[m] = () => stub
  }
  stub.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
    Promise.resolve(resolve({ data, error: null }))
  return stub
}

const LOC_A = { id: 'gbp-a', store_name: 'Nørreport', store_short_name: 'NP', location_id: 'canon-a' }
const LOC_B = { id: 'gbp-b', store_name: 'Aarhus',    store_short_name: 'ARH', location_id: 'canon-b' }

function metricRow(locationId: string, overrides: Record<string, unknown> = {}) {
  return {
    location_id:                 locationId,
    impressions_desktop_search:  100,
    impressions_mobile_search:   200,
    impressions_desktop_maps:    50,
    impressions_mobile_maps:     150,
    website_clicks:              30,
    call_clicks:                 10,
    direction_requests:          5,
    total_impressions:           500,
    ...overrides,
  }
}

/**
 * Configure mockFrom to return preset data per table.
 * permissions → SUPER_ADMIN bypass; locations → given list; metrics → given rows; keywords → given rows.
 */
function setupDb(opts: {
  locations?: unknown[]
  metrics?: unknown[]
  keywords?: unknown[]
} = {}) {
  const locations = opts.locations ?? [LOC_A, LOC_B]
  const metrics   = opts.metrics   ?? []
  const keywords  = opts.keywords  ?? []

  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'user_marketing_permissions') return q([])
    if (table === 'gbp_locations')              return q(locations)
    if (table === 'gbp_location_metrics')       return q(metrics)
    if (table === 'gbp_search_keywords_monthly') return q(keywords)
    return q([])
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getGbpPerformance — auth gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty data when unauthenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.hasData).toBe(false)
    expect(result.kpis.searchImpressions).toBeNull()
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('returns empty data when marketing access is denied', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue({ id: 'u1', role: 'MEMBER', marketing_access: false })
    mocks.mockCanAccessMarketing.mockReturnValue(false)
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.hasData).toBe(false)
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })
})

describe('getGbpPerformance — aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessMarketing.mockReturnValue(true)
  })

  it('returns hasData false and null KPIs when no metrics exist', async () => {
    setupDb({ metrics: [] })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.hasData).toBe(false)
    expect(result.kpis.searchImpressions).toBeNull()
    expect(result.kpis.websiteClicks).toBeNull()
  })

  it('sums search and maps impressions across all rows', async () => {
    setupDb({
      metrics: [
        metricRow('canon-a'),
        metricRow('canon-b'),
      ],
    })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.hasData).toBe(true)
    // search: (100+200)*2 = 600
    expect(result.kpis.searchImpressions).toBe(600)
    // maps: (50+150)*2 = 400
    expect(result.kpis.mapsImpressions).toBe(400)
    expect(result.kpis.websiteClicks).toBe(60)
    expect(result.kpis.callClicks).toBe(20)
    expect(result.kpis.directionRequests).toBe(10)
  })

  it('exposes breakdown by desktop/mobile', async () => {
    setupDb({ metrics: [metricRow('canon-a')] })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.breakdown.desktopSearch).toBe(100)
    expect(result.breakdown.mobileSearch).toBe(200)
    expect(result.breakdown.desktopMaps).toBe(50)
    expect(result.breakdown.mobileMaps).toBe(150)
  })

  it('treats null metric columns as absent (not zero)', async () => {
    setupDb({
      metrics: [
        metricRow('canon-a', { impressions_desktop_search: null, impressions_mobile_search: null }),
      ],
    })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.kpis.searchImpressions).toBeNull()
    // maps still has data
    expect(result.kpis.mapsImpressions).toBe(200)
  })

  it('builds per-location summaries', async () => {
    setupDb({
      metrics: [
        metricRow('canon-a', { website_clicks: 10 }),
        metricRow('canon-b', { website_clicks: 20 }),
      ],
    })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.locationSummaries).toHaveLength(2)
    const np = result.locationSummaries.find((s) => s.storeName === 'Nørreport')!
    expect(np.websiteClicks).toBe(10)
    const arh = result.locationSummaries.find((s) => s.storeName === 'Aarhus')!
    expect(arh.websiteClicks).toBe(20)
  })
})

describe('getGbpPerformance — keywords', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockCanAccessMarketing.mockReturnValue(true)
  })

  it('returns top keywords for the most recent month', async () => {
    setupDb({
      keywords: [
        { location_id: 'canon-a', month: '2026-09-01', keyword: 'kebab',    impressions: 500, impressions_threshold: null },
        { location_id: 'canon-a', month: '2026-09-01', keyword: 'shawarma', impressions: 200, impressions_threshold: null },
        { location_id: 'canon-a', month: '2026-08-01', keyword: 'old',      impressions: 999, impressions_threshold: null },
      ],
    })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.keywordMonth).toBe('2026-09')
    expect(result.topKeywords).toHaveLength(2)
    expect(result.topKeywords[0].keyword).toBe('kebab')
    expect(result.topKeywords[0].impressions).toBe(500)
  })

  it('aggregates keyword counts across locations for the same month', async () => {
    setupDb({
      keywords: [
        { location_id: 'canon-a', month: '2026-09-01', keyword: 'kebab', impressions: 300, impressions_threshold: null },
        { location_id: 'canon-b', month: '2026-09-01', keyword: 'kebab', impressions: 200, impressions_threshold: null },
      ],
    })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.topKeywords[0].keyword).toBe('kebab')
    expect(result.topKeywords[0].impressions).toBe(500)
  })

  it('preserves threshold values when exact count is unavailable', async () => {
    setupDb({
      keywords: [
        { location_id: 'canon-a', month: '2026-09-01', keyword: 'kebab', impressions: null, impressions_threshold: 500 },
      ],
    })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.topKeywords[0].impressions).toBeNull()
    expect(result.topKeywords[0].impressionsThreshold).toBe(500)
  })

  it('returns empty keywords when no keyword data', async () => {
    setupDb({ keywords: [] })
    const { getGbpPerformance } = await import('@/lib/actions/marketing/gbp-performance')
    const result = await getGbpPerformance(null)
    expect(result.topKeywords).toHaveLength(0)
    expect(result.keywordMonth).toBeNull()
  })
})
