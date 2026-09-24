import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { getGoogleConnectionStatus } from '@/lib/google/auth'
import { getGoogleAdsPerformance } from '@/lib/actions/marketing/google-ads'
import GoogleAdsConnection from '@/components/google/GoogleAdsConnection'
import GooglePageClient, {
  type GscBreakdownRow,
  type Ga4BreakdownRow,
} from './GooglePageClient'
import { SC_SITE_URL } from '@/lib/gsc/config'

export const dynamic = 'force-dynamic'
const GA4_PROPERTY_ID = '333149501'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

// ── GSC aggregation ────────────────────────────────────────────────────────────
// CTR = total clicks / total impressions (not averaged).
// Position = impression-weighted average (rows missing position are excluded).

function aggregateGsc<T extends {
  date: string
  clicks: number | null
  impressions: number | null
  position: number | null
}>(
  rows: T[],
  getKey: (r: T) => string,
  dateStart: string,
  dateEnd: string
): GscBreakdownRow[] {
  const map = new Map<string, { clicks: number; impressions: number; posW: number; posI: number }>()

  for (const row of rows) {
    if (row.date < dateStart || row.date > dateEnd) continue
    const k   = getKey(row)
    const acc = map.get(k) ?? { clicks: 0, impressions: 0, posW: 0, posI: 0 }
    acc.clicks      += row.clicks ?? 0
    acc.impressions += row.impressions ?? 0
    if (row.position != null && (row.impressions ?? 0) > 0) {
      acc.posW += Number(row.position) * (row.impressions ?? 0)
      acc.posI += row.impressions ?? 0
    }
    map.set(k, acc)
  }

  return Array.from(map.entries())
    .map(([key, acc]) => ({
      key,
      clicks:      acc.clicks,
      impressions: acc.impressions,
      ctr:         acc.impressions > 0 ? acc.clicks / acc.impressions : 0,
      position:    acc.posI > 0 ? acc.posW / acc.posI : null,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10)
}

// ── GA4 breakdown aggregation ──────────────────────────────────────────────────
// ga4DailyTotal: authoritative session count from ga4_daily for the same window.
// Using ga4_daily as the denominator ensures Share matches the Analytics overview
// total, regardless of whether the breakdown tables cover every session.
// Users column is omitted: summing daily total_users across 28d/90d double-counts
// returning users and is not a meaningful period-unique user figure.

type RawSourceRow = {
  date: string
  session_source: string
  session_medium: string
  sessions:  number | null
  new_users: number | null
}

type RawLandingPageRow = {
  date: string
  landing_page: string
  sessions:  number | null
  new_users: number | null
}

function aggregateGa4Breakdown<T extends {
  date: string
  sessions:  number | null
  new_users: number | null
}>(
  rows: T[],
  getKey: (r: T) => string,
  dateStart: string,
  dateEnd: string,
  ga4DailyTotal: number   // from ga4_daily — the authoritative denominator
): Ga4BreakdownRow[] {
  const map = new Map<string, { sessions: number; newUsers: number }>()

  for (const row of rows) {
    if (row.date < dateStart || row.date > dateEnd) continue
    const k   = getKey(row)
    const acc = map.get(k) ?? { sessions: 0, newUsers: 0 }
    acc.sessions += row.sessions  ?? 0
    acc.newUsers += row.new_users ?? 0
    map.set(k, acc)
  }

  return Array.from(map.entries())
    .map(([key, acc]) => ({
      key,
      sessions:        acc.sessions,
      newUsers:        acc.newUsers,
      shareOfSessions: ga4DailyTotal > 0 ? acc.sessions / ga4DailyTotal : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10)
}

type RawQueryRow = { date: string; query: string; clicks: number | null; impressions: number | null; position: number | null }
type RawPageRow  = { date: string; page:  string; clicks: number | null; impressions: number | null; position: number | null }

// ── Pagination helper ──────────────────────────────────────────────────────────
// PostgREST enforces a server-side max-rows cap that client .limit() cannot
// override.  Fetching in 1000-row pages with .range() bypasses this cap safely.

const PAGE_SIZE = 1000

type SupabaseResult<T> = { data: T[] | null; error: { message: string } | null }

async function fetchAllPages<T>(
  fetcher: (from: number, to: number) => PromiseLike<SupabaseResult<T>>,
  label: string,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await fetcher(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`[google/page] ${label} (page ${from / PAGE_SIZE}):`, error.message)
      break
    }
    const page = data ?? []
    all.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

export default async function GooglePage() {
  const user = await getCurrentUser()
  const googleStatus = user?.role === 'SUPER_ADMIN' ? await getGoogleConnectionStatus(user.id) : null
  const db = createServiceClient()

  const since      = daysAgo(185) // overview: 90d current + 90d prior + buffer
  const since90    = daysAgo(90)  // breakdowns: only need 90d max
  const curEnd     = daysAgo(1)
  const cur28Start = daysAgo(28)
  const cur90Start = daysAgo(90)

  // Overview tables have small, bounded row counts — single fetch is fine.
  const [gscRes, ga4Res, orgRes] = await Promise.all([
    db.from('gsc_daily')
      .select('date, clicks, impressions, ctr, position')
      .eq('site_url', SC_SITE_URL)
      .gte('date', since)
      .order('date'),
    db.from('ga4_daily')
      // Column is `page_views` (stores screenPageViews metric) — NOT screen_page_views
      .select('date, sessions, total_users, new_users, page_views')
      .eq('property_id', GA4_PROPERTY_ID)
      .gte('date', since)
      .order('date'),
    db.from('ga4_traffic_sources')
      .select('date, sessions')
      .eq('property_id', GA4_PROPERTY_ID)
      .eq('session_medium', 'organic')
      .gte('date', since)
      .order('date'),
  ])

  if (gscRes.error) console.error('[google/page] gsc_daily:', gscRes.error.message)
  if (ga4Res.error) console.error('[google/page] ga4_daily:', ga4Res.error.message)
  if (orgRes.error) console.error('[google/page] ga4_traffic_sources (organic):', orgRes.error.message)

  // Breakdown tables can exceed the PostgREST server-side max-rows cap (1000).
  // Paginate with .range() to guarantee all rows are fetched regardless of cap.
  const [queriesData, pagesData, sourcesData, landingData] = await Promise.all([
    fetchAllPages<RawQueryRow>(
      (from, to) => db.from('gsc_queries')
        .select('date, query, clicks, impressions, position')
        .eq('site_url', SC_SITE_URL)
        .gte('date', since90)
        .order('date')
        .range(from, to),
      'gsc_queries',
    ),
    fetchAllPages<RawPageRow>(
      (from, to) => db.from('gsc_pages')
        .select('date, page, clicks, impressions, position')
        .eq('site_url', SC_SITE_URL)
        .gte('date', since90)
        .order('date')
        .range(from, to),
      'gsc_pages',
    ),
    // total_users intentionally omitted — daily summing overcounts returning users.
    fetchAllPages<RawSourceRow>(
      (from, to) => db.from('ga4_traffic_sources')
        .select('date, session_source, session_medium, sessions, new_users')
        .eq('property_id', GA4_PROPERTY_ID)
        .gte('date', since90)
        .order('date')
        .range(from, to),
      'ga4_traffic_sources',
    ),
    fetchAllPages<RawLandingPageRow>(
      (from, to) => db.from('ga4_landing_pages')
        .select('date, landing_page, sessions, new_users')
        .eq('property_id', GA4_PROPERTY_ID)
        .gte('date', since90)
        .order('date')
        .range(from, to),
      'ga4_landing_pages',
    ),
  ])

  // ── Google Ads ──────────────────────────────────────────────────────────────
  const [ads28, ads90] = await Promise.all([
    getGoogleAdsPerformance(28),
    getGoogleAdsPerformance(90),
  ])

  // Aggregate organic sessions by date (multiple sources per date with medium=organic)
  const orgMap = new Map<string, number>()
  for (const row of orgRes.data ?? []) {
    orgMap.set(row.date, (orgMap.get(row.date) ?? 0) + (row.sessions ?? 0))
  }
  const orgRows = Array.from(orgMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessions]) => ({ date, sessions }))

  // GSC breakdowns — pre-aggregated server-side for both periods
  const queries28 = aggregateGsc(queriesData, (r) => r.query, cur28Start, curEnd)
  const queries90 = aggregateGsc(queriesData, (r) => r.query, cur90Start, curEnd)
  const pages28   = aggregateGsc(pagesData,   (r) => r.page,  cur28Start, curEnd)
  const pages90   = aggregateGsc(pagesData,   (r) => r.page,  cur90Start, curEnd)

  // GA4 breakdowns — pre-aggregated server-side for both periods.
  // Denominators come from ga4_daily so Share matches the Analytics overview total.
  const ga4Daily = ga4Res.data ?? []
  const g4Total28 = ga4Daily
    .filter((r) => r.date >= cur28Start && r.date <= curEnd)
    .reduce((a, r) => a + ((r.sessions as number | null) ?? 0), 0)
  const g4Total90 = ga4Daily
    .filter((r) => r.date >= cur90Start && r.date <= curEnd)
    .reduce((a, r) => a + ((r.sessions as number | null) ?? 0), 0)

  const sources28      = aggregateGa4Breakdown(sourcesData, (r) => `${r.session_source} / ${r.session_medium}`, cur28Start, curEnd, g4Total28)
  const sources90      = aggregateGa4Breakdown(sourcesData, (r) => `${r.session_source} / ${r.session_medium}`, cur90Start, curEnd, g4Total90)
  const landingPages28 = aggregateGa4Breakdown(landingData, (r) => r.landing_page, cur28Start, curEnd, g4Total28)
  const landingPages90 = aggregateGa4Breakdown(landingData, (r) => r.landing_page, cur90Start, curEnd, g4Total90)

  return (
    <>
    {googleStatus && (
      <div className="mb-5">
        <GoogleAdsConnection enabled={googleStatus.connected && googleStatus.googleAdsEnabled} />
      </div>
    )}
    <GooglePageClient
      gscRows={gscRes.data ?? []}
      ga4Rows={ga4Res.data ?? []}
      orgRows={orgRows}
      queries28={queries28}
      queries90={queries90}
      pages28={pages28}
      pages90={pages90}
      sources28={sources28}
      sources90={sources90}
      landingPages28={landingPages28}
      landingPages90={landingPages90}
      ads28={ads28}
      ads90={ads90}
    />
    </>
  )
}
