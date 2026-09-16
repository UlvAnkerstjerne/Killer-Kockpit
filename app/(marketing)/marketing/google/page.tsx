import { createServiceClient } from '@/lib/supabase/server'
import GooglePageClient, { type GscBreakdownRow } from './GooglePageClient'

export const dynamic = 'force-dynamic'

const SC_SITE_URL     = 'https://killerkebab.com/'
const GA4_PROPERTY_ID = '333149501'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

// Aggregate daily query/page rows into a top-10 list for a given date window.
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

type RawQueryRow = { date: string; query: string; clicks: number | null; impressions: number | null; position: number | null }
type RawPageRow  = { date: string; page:  string; clicks: number | null; impressions: number | null; position: number | null }

export default async function GooglePage() {
  const db = createServiceClient()

  const since    = daysAgo(185) // overview: 90d current + 90d prior + buffer
  const since90  = daysAgo(90)  // breakdowns: only need 90d max
  const curEnd   = daysAgo(1)
  const cur28Start = daysAgo(28)
  const cur90Start = daysAgo(90)

  const [gscRes, ga4Res, orgRes, queriesRes, pagesRes] = await Promise.all([
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
    db.from('gsc_queries')
      .select('date, query, clicks, impressions, position')
      .eq('site_url', SC_SITE_URL)
      .gte('date', since90)
      .order('date'),
    db.from('gsc_pages')
      .select('date, page, clicks, impressions, position')
      .eq('site_url', SC_SITE_URL)
      .gte('date', since90)
      .order('date'),
  ])

  if (gscRes.error)     console.error('[google/page] gsc_daily query error:',          gscRes.error.message)
  if (ga4Res.error)     console.error('[google/page] ga4_daily query error:',           ga4Res.error.message)
  if (orgRes.error)     console.error('[google/page] ga4_traffic_sources query error:', orgRes.error.message)
  if (queriesRes.error) console.error('[google/page] gsc_queries query error:',         queriesRes.error.message)
  if (pagesRes.error)   console.error('[google/page] gsc_pages query error:',           pagesRes.error.message)

  // Aggregate organic sessions by date (multiple sources per date with medium=organic)
  const orgMap = new Map<string, number>()
  for (const row of orgRes.data ?? []) {
    orgMap.set(row.date, (orgMap.get(row.date) ?? 0) + (row.sessions ?? 0))
  }
  const orgRows = Array.from(orgMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessions]) => ({ date, sessions }))

  // Pre-aggregate top queries + pages for both period windows server-side.
  // Avoids shipping thousands of daily rows to the client.
  const queriesData = (queriesRes.data ?? []) as RawQueryRow[]
  const pagesData   = (pagesRes.data ?? []) as RawPageRow[]

  const queries28 = aggregateGsc(queriesData, (r) => r.query, cur28Start, curEnd)
  const queries90 = aggregateGsc(queriesData, (r) => r.query, cur90Start, curEnd)
  const pages28   = aggregateGsc(pagesData,   (r) => r.page,  cur28Start, curEnd)
  const pages90   = aggregateGsc(pagesData,   (r) => r.page,  cur90Start, curEnd)

  return (
    <GooglePageClient
      gscRows={gscRes.data ?? []}
      ga4Rows={ga4Res.data ?? []}
      orgRows={orgRows}
      queries28={queries28}
      queries90={queries90}
      pages28={pages28}
      pages90={pages90}
    />
  )
}
