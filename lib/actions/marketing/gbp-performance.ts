'use server'

/**
 * lib/actions/marketing/gbp-performance.ts
 *
 * Server actions for Google Business Profile performance data.
 * Reads from gbp_location_metrics and gbp_search_keywords_monthly.
 *
 * Same permission contract as gbp-reviews.ts:
 *   - Actor identity from getCurrentUser() only.
 *   - reviews_manage OR reviews_approve permission required (or SUPER_ADMIN).
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing } from '@/lib/permissions'

// ── Auth helper ────────────────────────────────────────────────────────────────

async function assertMarketingRead() {
  const user = await getCurrentUser()
  if (!user) return { user: null as null, error: 'Not authenticated.' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { user: null as null, error: 'Marketing access required.' }
  }
  const db = createServiceClient()
  const { data: permRows } = await db
    .from('user_marketing_permissions')
    .select('permission')
    .eq('user_id', user.id)
  const permissions = (permRows ?? []).map((r) => r.permission as string)
  const canRead =
    user.role === 'SUPER_ADMIN' ||
    permissions.includes('reviews_manage') ||
    permissions.includes('reviews_approve')
  if (!canRead) return { user: null as null, error: 'reviews_manage or reviews_approve permission required.' }
  return { user, error: undefined as undefined }
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function todayCph(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GbpKpis {
  searchImpressions: number | null
  mapsImpressions:   number | null
  websiteClicks:     number | null
  callClicks:        number | null
  directionRequests: number | null
}

export interface GbpBreakdown {
  desktopSearch: number | null
  mobileSearch:  number | null
  desktopMaps:   number | null
  mobileMaps:    number | null
}

export interface GbpLocationSummaryRow {
  gbpLocationId:    string
  storeName:        string
  storeShortName:   string
  totalImpressions: number | null
  websiteClicks:    number | null
  callClicks:       number | null
  directionRequests: number | null
}

export interface GbpKeywordRow {
  keyword:              string
  impressions:          number | null
  impressionsThreshold: number | null
}

export interface GbpPerformanceData {
  kpis:               GbpKpis
  breakdown:          GbpBreakdown
  locationSummaries:  GbpLocationSummaryRow[]
  topKeywords:        GbpKeywordRow[]
  /** ISO month, e.g. "2026-09". Null if no keyword data. */
  keywordMonth:       string | null
  dateRange:          { start: string; end: string }
  hasData:            boolean
}

// ── Aggregation helpers ────────────────────────────────────────────────────────

interface MetricRow {
  location_id:                 string
  impressions_desktop_search:  number | null
  impressions_mobile_search:   number | null
  impressions_desktop_maps:    number | null
  impressions_mobile_maps:     number | null
  website_clicks:              number | null
  call_clicks:                 number | null
  direction_requests:          number | null
  total_impressions:           number | null
}

function sumCol(rows: MetricRow[], key: keyof MetricRow): number | null {
  let total: number | null = null
  for (const row of rows) {
    const v = row[key]
    if (typeof v === 'number') total = (total ?? 0) + v
  }
  return total
}

function sumTwo(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

// ── getGbpPerformance ──────────────────────────────────────────────────────────

export async function getGbpPerformance(
  gbpLocationId: string | null,
  days: 28 | 90 = 28,
): Promise<GbpPerformanceData> {
  const EMPTY: GbpPerformanceData = {
    kpis: { searchImpressions: null, mapsImpressions: null, websiteClicks: null, callClicks: null, directionRequests: null },
    breakdown: { desktopSearch: null, mobileSearch: null, desktopMaps: null, mobileMaps: null },
    locationSummaries: [],
    topKeywords: [],
    keywordMonth: null,
    dateRange: { start: '', end: '' },
    hasData: false,
  }

  const { error } = await assertMarketingRead()
  if (error) return EMPTY

  const db = createServiceClient()

  // 1. Resolve active GBP locations with canonical mapping
  type LocationRow = { id: string; store_name: string; store_short_name: string; location_id: string }
  let locQuery = db
    .from('gbp_locations')
    .select('id, store_name, store_short_name, location_id')
    .eq('active', true)
    .not('location_id', 'is', null)
    .order('store_name')

  if (gbpLocationId) locQuery = (locQuery as typeof locQuery).eq('id', gbpLocationId)

  const { data: locationRows } = await locQuery
  const locations = (locationRows ?? []) as LocationRow[]
  if (locations.length === 0) return EMPTY

  const canonicalIds = locations.map((l) => l.location_id)

  // 2. Date range (last N days ending yesterday, Copenhagen time)
  const today = todayCph()
  const end   = addDays(today, -1)
  const start = addDays(end, -(days - 1))
  const dateRange = { start, end }

  // 3. Fetch metrics
  const { data: metricsRaw } = await db
    .from('gbp_location_metrics')
    .select('location_id, impressions_desktop_search, impressions_mobile_search, impressions_desktop_maps, impressions_mobile_maps, website_clicks, call_clicks, direction_requests, total_impressions')
    .in('location_id', canonicalIds)
    .gte('date', start)
    .lte('date', end)

  const metrics = (metricsRaw ?? []) as MetricRow[]

  // 4. Fetch keywords (all months, most recent selected below)
  type KwRow = { location_id: string; month: string; keyword: string; impressions: number | null; impressions_threshold: number | null }
  const { data: keywordRaw } = await db
    .from('gbp_search_keywords_monthly')
    .select('location_id, month, keyword, impressions, impressions_threshold')
    .in('location_id', canonicalIds)
    .order('month', { ascending: false })

  const allKeywords = (keywordRaw ?? []) as KwRow[]

  // Find most recent month and aggregate across locations
  const mostRecentMonth = allKeywords.length > 0 ? allKeywords[0].month.slice(0, 7) : null
  const recentKeywords  = mostRecentMonth
    ? allKeywords.filter((k) => k.month.slice(0, 7) === mostRecentMonth)
    : []

  // Aggregate keywords across locations.
  // Rule: if ANY location is threshold-only, the aggregate is an upper bound:
  //   upperBound = sum(all exact counts) + sum(all threshold values)
  //   represented as impressionsThreshold with impressions=null.
  // Only when ALL locations have exact counts do we show an exact sum.
  type KwAgg = { exactSum: number; thresholdSum: number; hasThreshold: boolean }
  const kwMap = new Map<string, KwAgg>()
  for (const kw of recentKeywords) {
    const agg = kwMap.get(kw.keyword) ?? { exactSum: 0, thresholdSum: 0, hasThreshold: false }
    if (kw.impressions !== null) {
      agg.exactSum += kw.impressions
    } else if (kw.impressions_threshold !== null) {
      agg.thresholdSum += kw.impressions_threshold
      agg.hasThreshold = true
    }
    kwMap.set(kw.keyword, agg)
  }

  const topKeywords: GbpKeywordRow[] = [...kwMap.entries()]
    .map(([keyword, agg]) => ({
      keyword,
      impressions:          agg.hasThreshold ? null : agg.exactSum,
      impressionsThreshold: agg.hasThreshold ? agg.exactSum + agg.thresholdSum : null,
    }))
    .sort((a, b) => {
      const aVal = a.impressions ?? (a.impressionsThreshold ?? 0)
      const bVal = b.impressions ?? (b.impressionsThreshold ?? 0)
      return bVal - aVal
    })
    .slice(0, 10)

  // 5. KPI aggregates
  const desktopSearch = sumCol(metrics, 'impressions_desktop_search')
  const mobileSearch  = sumCol(metrics, 'impressions_mobile_search')
  const desktopMaps   = sumCol(metrics, 'impressions_desktop_maps')
  const mobileMaps    = sumCol(metrics, 'impressions_mobile_maps')

  const kpis: GbpKpis = {
    searchImpressions: sumTwo(desktopSearch, mobileSearch),
    mapsImpressions:   sumTwo(desktopMaps, mobileMaps),
    websiteClicks:     sumCol(metrics, 'website_clicks'),
    callClicks:        sumCol(metrics, 'call_clicks'),
    directionRequests: sumCol(metrics, 'direction_requests'),
  }

  const breakdown: GbpBreakdown = { desktopSearch, mobileSearch, desktopMaps, mobileMaps }

  // 6. Location summaries
  const locMetricsMap = new Map<string, MetricRow[]>()
  for (const row of metrics) {
    const bucket = locMetricsMap.get(row.location_id) ?? []
    bucket.push(row)
    locMetricsMap.set(row.location_id, bucket)
  }

  const locationSummaries: GbpLocationSummaryRow[] = locations.map((loc) => {
    const locMetrics = locMetricsMap.get(loc.location_id) ?? []
    const locSearch  = sumTwo(sumCol(locMetrics, 'impressions_desktop_search'), sumCol(locMetrics, 'impressions_mobile_search'))
    const locMaps    = sumTwo(sumCol(locMetrics, 'impressions_desktop_maps'),   sumCol(locMetrics, 'impressions_mobile_maps'))
    return {
      gbpLocationId:    loc.id,
      storeName:        loc.store_name,
      storeShortName:   loc.store_short_name,
      totalImpressions: sumTwo(locSearch, locMaps),
      websiteClicks:    sumCol(locMetrics, 'website_clicks'),
      callClicks:       sumCol(locMetrics, 'call_clicks'),
      directionRequests: sumCol(locMetrics, 'direction_requests'),
    }
  })

  return {
    kpis,
    breakdown,
    locationSummaries,
    topKeywords,
    keywordMonth: mostRecentMonth,
    dateRange,
    hasData: metrics.length > 0,
  }
}
