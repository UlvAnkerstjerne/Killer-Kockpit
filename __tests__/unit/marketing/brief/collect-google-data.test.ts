/**
 * Tests for the Google/GSC/GA4/GBP performance aggregation helpers in
 * lib/marketing/brief/collect-data.ts.
 *
 * Uses only pure exported functions — no DB, no mocking required.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  aggregateGscRows,
  aggregateGa4Rows,
  aggregateGbpPerformanceRows,
  collectGbpPerformanceData,
  SC_SITE_URL,
  GA4_PROPERTY_ID,
} from '@/lib/marketing/brief/collect-data'

// ── Constants ─────────────────────────────────────────────────────────────────

describe('integration constants', () => {
  it('SC_SITE_URL is the canonical killerkebab URL', () => {
    expect(SC_SITE_URL).toBe('https://killerkebab.com/')
  })

  it('GA4_PROPERTY_ID is a non-empty string', () => {
    expect(typeof GA4_PROPERTY_ID).toBe('string')
    expect(GA4_PROPERTY_ID.length).toBeGreaterThan(0)
  })
})

// ── aggregateGscRows ──────────────────────────────────────────────────────────

describe('aggregateGscRows — null conditions', () => {
  it('returns null when no daily rows', () => {
    expect(aggregateGscRows([], [], [])).toBeNull()
  })
})

describe('aggregateGscRows — totals', () => {
  const daily = [
    { clicks: 10, impressions: 200, position: 5.0 },
    { clicks: 20, impressions: 400, position: 3.0 },
  ]

  it('sums clicks across daily rows', () => {
    const result = aggregateGscRows(daily, [], [])!
    expect(result.clicks_7d).toBe(30)
  })

  it('sums impressions across daily rows', () => {
    const result = aggregateGscRows(daily, [], [])!
    expect(result.impressions_7d).toBe(600)
  })

  it('computes CTR as total clicks / total impressions', () => {
    const result = aggregateGscRows(daily, [], [])!
    // 30 / 600 = 0.05
    expect(result.ctr_7d).toBeCloseTo(0.05)
  })

  it('computes avg_position as impression-weighted average', () => {
    const result = aggregateGscRows(daily, [], [])!
    // (5.0 * 200 + 3.0 * 400) / 600 = (1000 + 1200) / 600 = 3.667
    expect(result.avg_position_7d).toBeCloseTo(3.667, 2)
  })

  it('returns null avg_position when no impressions', () => {
    const result = aggregateGscRows([{ clicks: 0, impressions: 0, position: null }], [], [])!
    expect(result.avg_position_7d).toBeNull()
  })
})

describe('aggregateGscRows — top queries', () => {
  const daily = [{ clicks: 100, impressions: 1000, position: 2.0 }]

  it('returns empty arrays when no query/page rows', () => {
    const result = aggregateGscRows(daily, [], [])!
    expect(result.top_queries).toHaveLength(0)
    expect(result.top_pages).toHaveLength(0)
  })

  it('aggregates query impressions across days', () => {
    const queries = [
      { query: 'kebab', clicks: 5, impressions: 100, position: 2.0 },
      { query: 'kebab', clicks: 3, impressions: 80,  position: 2.5 },
      { query: 'pizza', clicks: 1, impressions: 50,  position: 5.0 },
    ]
    const result = aggregateGscRows(daily, queries, [])!
    const kebab = result.top_queries.find((q) => q.query === 'kebab')!
    expect(kebab.clicks).toBe(8)
    expect(kebab.impressions).toBe(180)
  })

  it('sorts queries by impressions descending', () => {
    const queries = [
      { query: 'pizza', clicks: 1, impressions: 50,  position: 5.0 },
      { query: 'kebab', clicks: 8, impressions: 180, position: 2.2 },
    ]
    const result = aggregateGscRows(daily, queries, [])!
    expect(result.top_queries[0].query).toBe('kebab')
  })

  it('limits to 5 queries', () => {
    const queries = Array.from({ length: 10 }, (_, i) => ({
      query: `kw${i}`, clicks: i, impressions: 100 - i * 5, position: 3.0,
    }))
    const result = aggregateGscRows(daily, queries, [])!
    expect(result.top_queries.length).toBeLessThanOrEqual(5)
  })

  it('computes per-query CTR correctly', () => {
    const queries = [{ query: 'kebab', clicks: 10, impressions: 200, position: 2.0 }]
    const result  = aggregateGscRows(daily, queries, [])!
    expect(result.top_queries[0].ctr).toBeCloseTo(0.05)
  })
})

// ── aggregateGa4Rows ──────────────────────────────────────────────────────────

describe('aggregateGa4Rows — null conditions', () => {
  it('returns null when no daily rows', () => {
    expect(aggregateGa4Rows([], [], [])).toBeNull()
  })
})

describe('aggregateGa4Rows — totals', () => {
  const daily = [
    { sessions: 300, new_users: 120, page_views: 900 },
    { sessions: 200, new_users: 80,  page_views: 600 },
  ]

  it('sums sessions', () => {
    expect(aggregateGa4Rows(daily, [], [])!.sessions_7d).toBe(500)
  })

  it('sums new_users', () => {
    expect(aggregateGa4Rows(daily, [], [])!.new_users_7d).toBe(200)
  })

  it('sums page_views', () => {
    expect(aggregateGa4Rows(daily, [], [])!.page_views_7d).toBe(1500)
  })
})

describe('aggregateGa4Rows — top sources', () => {
  const daily = [{ sessions: 500, new_users: 200, page_views: 1500 }]

  it('aggregates sessions per source/medium pair', () => {
    const sources = [
      { session_source: 'google', session_medium: 'organic', sessions: 300 },
      { session_source: 'google', session_medium: 'organic', sessions: 100 },
      { session_source: 'facebook', session_medium: 'social', sessions: 50 },
    ]
    const result = aggregateGa4Rows(daily, sources, [])!
    const google = result.top_sources.find((s) => s.source === 'google')!
    expect(google.sessions).toBe(400)
    expect(google.medium).toBe('organic')
  })

  it('computes share as sessions / sessions_7d', () => {
    const sources = [{ session_source: 'google', session_medium: 'organic', sessions: 250 }]
    const result  = aggregateGa4Rows(daily, sources, [])!
    // 250 / 500 = 0.5
    expect(result.top_sources[0].share).toBeCloseTo(0.5)
  })

  it('sorts sources by sessions descending', () => {
    const sources = [
      { session_source: 'direct', session_medium: '(none)', sessions: 50 },
      { session_source: 'google', session_medium: 'organic', sessions: 300 },
    ]
    const result = aggregateGa4Rows(daily, sources, [])!
    expect(result.top_sources[0].source).toBe('google')
  })

  it('limits to 5 sources', () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({
      session_source: `src${i}`, session_medium: 'cpc', sessions: 100 - i * 5,
    }))
    const result = aggregateGa4Rows(daily, sources, [])!
    expect(result.top_sources.length).toBeLessThanOrEqual(5)
  })
})

describe('aggregateGa4Rows — top landing pages', () => {
  const daily = [{ sessions: 500, new_users: 200, page_views: 1500 }]

  it('aggregates sessions per landing page', () => {
    const landings = [
      { landing_page: '/', sessions: 200 },
      { landing_page: '/', sessions: 100 },
      { landing_page: '/menu', sessions: 80 },
    ]
    const result = aggregateGa4Rows(daily, [], landings)!
    const home = result.top_landing_pages.find((p) => p.page === '/')!
    expect(home.sessions).toBe(300)
  })

  it('limits to 5 landing pages', () => {
    const landings = Array.from({ length: 10 }, (_, i) => ({
      landing_page: `/page-${i}`, sessions: 100 - i * 5,
    }))
    const result = aggregateGa4Rows(daily, [], landings)!
    expect(result.top_landing_pages.length).toBeLessThanOrEqual(5)
  })
})

// ── aggregateGbpPerformanceRows ───────────────────────────────────────────────

describe('aggregateGbpPerformanceRows — metric totals', () => {
  it('sums search impressions from desktop + mobile', () => {
    const metrics = [
      { location_id: 'a', impressions_desktop_search: 100, impressions_mobile_search: 200, impressions_desktop_maps: 50, impressions_mobile_maps: 150, website_clicks: 30, call_clicks: 10, direction_requests: 5 },
      { location_id: 'b', impressions_desktop_search: 50,  impressions_mobile_search: 100, impressions_desktop_maps: 25, impressions_mobile_maps: 75,  website_clicks: 15, call_clicks: 5,  direction_requests: 2 },
    ]
    const result = aggregateGbpPerformanceRows(metrics, [])
    // desktop: 150, mobile: 300 → 450
    expect(result.search_impressions_28d).toBe(450)
    // maps: 75 + 225 = 300
    expect(result.maps_impressions_28d).toBe(300)
    expect(result.website_clicks_28d).toBe(45)
    expect(result.call_clicks_28d).toBe(15)
    expect(result.direction_requests_28d).toBe(7)
  })

  it('returns null for a metric column when all rows have null for that column', () => {
    const metrics = [
      { location_id: 'a', impressions_desktop_search: null, impressions_mobile_search: null, impressions_desktop_maps: 100, impressions_mobile_maps: 200, website_clicks: null, call_clicks: null, direction_requests: null },
    ]
    const result = aggregateGbpPerformanceRows(metrics, [])
    expect(result.search_impressions_28d).toBeNull()
    expect(result.maps_impressions_28d).toBe(300)
    expect(result.website_clicks_28d).toBeNull()
  })

  it('returns zeroed metrics and null keyword_month for empty metric rows', () => {
    const result = aggregateGbpPerformanceRows([], [])
    expect(result.search_impressions_28d).toBeNull()
    expect(result.keyword_month).toBeNull()
    expect(result.top_keywords).toHaveLength(0)
  })
})

describe('aggregateGbpPerformanceRows — keyword aggregation', () => {
  it('picks the most recent month', () => {
    const keywords = [
      { location_id: 'a', month: '2026-09-01', keyword: 'kebab', impressions: 500, impressions_threshold: null },
      { location_id: 'a', month: '2026-08-01', keyword: 'old',   impressions: 999, impressions_threshold: null },
    ]
    const result = aggregateGbpPerformanceRows([], keywords)
    expect(result.keyword_month).toBe('2026-09')
    expect(result.top_keywords[0].keyword).toBe('kebab')
  })

  it('all exact → exact sum, no threshold', () => {
    const keywords = [
      { location_id: 'a', month: '2026-09-01', keyword: 'kebab', impressions: 300, impressions_threshold: null },
      { location_id: 'b', month: '2026-09-01', keyword: 'kebab', impressions: 200, impressions_threshold: null },
    ]
    const result = aggregateGbpPerformanceRows([], keywords)
    expect(result.top_keywords[0].impressions).toBe(500)
    expect(result.top_keywords[0].impressionsThreshold).toBeNull()
  })

  it('threshold-only → impressions null, impressionsThreshold set', () => {
    const keywords = [
      { location_id: 'a', month: '2026-09-01', keyword: 'kebab', impressions: null, impressions_threshold: 15 },
    ]
    const result = aggregateGbpPerformanceRows([], keywords)
    expect(result.top_keywords[0].impressions).toBeNull()
    expect(result.top_keywords[0].impressionsThreshold).toBe(15)
  })

  it('mixed exact + threshold → upper bound (40 + 15 + 15 = 70)', () => {
    const keywords = [
      { location_id: 'a', month: '2026-09-01', keyword: 'kebab', impressions: 40, impressions_threshold: null },
      { location_id: 'b', month: '2026-09-01', keyword: 'kebab', impressions: null, impressions_threshold: 15 },
      { location_id: 'c', month: '2026-09-01', keyword: 'kebab', impressions: null, impressions_threshold: 15 },
    ]
    const result = aggregateGbpPerformanceRows([], keywords)
    expect(result.top_keywords[0].impressions).toBeNull()
    expect(result.top_keywords[0].impressionsThreshold).toBe(70)
  })

  it('limits to 5 keywords', () => {
    const keywords = Array.from({ length: 10 }, (_, i) => ({
      location_id: 'a', month: '2026-09-01', keyword: `kw${i}`, impressions: 100 - i * 5, impressions_threshold: null,
    }))
    const result = aggregateGbpPerformanceRows([], keywords)
    expect(result.top_keywords.length).toBeLessThanOrEqual(5)
  })
})

// ── collectGbpPerformanceData — GBP location ID regression ────────────────────
//
// gbp_location_metrics.location_id and gbp_search_keywords_monthly.location_id
// both reference gbp_locations.id (the PK UUID), NOT gbp_locations.location_id
// (the canonical Google API ID). This test guards against that regression.

describe('collectGbpPerformanceData — uses gbp_locations.id not location_id', () => {
  it('queries performance tables with gbp_locations.id, not location_id', async () => {
    // A location row with distinct id vs location_id values
    const locationRow = { id: 'gbp-pk-uuid-1', location_id: 'canonical-google-id-xyz' }

    // Track which values were passed to .in() on performance tables
    const inCalls: Array<{ col: string; vals: unknown[] }> = []

    function makeChain(returnData: unknown[]) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'gte', 'lte', 'order', 'limit', 'range']) {
        chain[m] = () => chain
      }
      chain['in'] = (col: string, vals: unknown[]) => {
        inCalls.push({ col, vals: vals as unknown[] })
        return chain
      }
      chain['then'] = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: returnData, error: null }))
      return chain
    }

    let callIndex = 0
    const db = {
      from: vi.fn((_table: string) => {
        // First call: gbp_locations
        // Subsequent calls: performance tables
        if (callIndex++ === 0) return makeChain([locationRow])
        return makeChain([])
      }),
    }

    await collectGbpPerformanceData(db as never, '2026-09-19')

    // The performance table queries must use the PK id, not the canonical location_id
    for (const call of inCalls) {
      expect(call.vals).toContain('gbp-pk-uuid-1')
      expect(call.vals).not.toContain('canonical-google-id-xyz')
    }
  })
})

// ── collectGbpPerformanceData — keyword pagination / latest-month ──────────────
//
// The collector must fetch ALL keyword rows for the most recent month via
// pagination instead of a fixed .limit(). A truncated fetch would silently
// miss the highest-impression keywords if they appear after row 200.

describe('collectGbpPerformanceData — keyword pagination fetches beyond old truncation limit', () => {
  it('finds the top keyword even when it appears beyond the old 200-row limit', async () => {
    // Build 250 keywords. Most have impressions=10, but kw210 has impressions=1000.
    // With the old .limit(200), kw210 would never be fetched, and the top keyword
    // returned to the brief would incorrectly show impressions=10.
    const makeKw = (i: number) => ({
      location_id: 'loc1',
      month: '2026-09-01',
      keyword: `kw${i}`,
      impressions: i === 210 ? 1000 : 10,
      impressions_threshold: null,
    })
    const allKeywords = Array.from({ length: 250 }, (_, i) => makeKw(i))

    let gbpKwCallCount = 0
    let callIndex = 0

    function makeQueryChain(returnData: unknown[]) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'eq', 'not', 'gte', 'lte', 'order', 'limit', 'range']) {
        chain[m] = () => chain
      }
      chain['then'] = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: returnData, error: null }))
      return chain
    }

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'gbp_locations') return makeQueryChain([{ id: 'loc1' }])
        if (table === 'gbp_location_metrics') return makeQueryChain([])
        if (table === 'gbp_search_keywords_monthly') {
          gbpKwCallCount++
          if (gbpKwCallCount === 1) {
            // Probe: return the latest month row
            return makeQueryChain([{ month: '2026-09-01' }])
          }
          // Paginated fetch: return all 250 keywords (< 1000, so pagination stops after 1 page)
          return makeQueryChain(allKeywords)
        }
        // Track call order for parallel Promise.all
        callIndex++
        return makeQueryChain([])
      }),
    }

    const result = await collectGbpPerformanceData(db as never, '2026-09-19')

    // kw210 must appear as the top keyword — it would be missed with .limit(200)
    expect(result).not.toBeNull()
    expect(result!.top_keywords[0].keyword).toBe('kw210')
    expect(result!.top_keywords[0].impressions).toBe(1000)
  })
})
