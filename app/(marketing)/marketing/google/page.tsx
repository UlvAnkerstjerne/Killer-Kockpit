import { createServiceClient } from '@/lib/supabase/server'
import GooglePageClient from './GooglePageClient'

export const dynamic = 'force-dynamic'

const SC_SITE_URL    = 'https://killerkebab.com/'
const GA4_PROPERTY_ID = '333149501'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

export default async function GooglePage() {
  const db    = createServiceClient()
  const since = daysAgo(185) // 90-day period + 90-day prior + buffer

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

  if (gscRes.error) console.error('[google/page] gsc_daily query error:', gscRes.error.message)
  if (ga4Res.error) console.error('[google/page] ga4_daily query error:', ga4Res.error.message)
  if (orgRes.error) console.error('[google/page] ga4_traffic_sources query error:', orgRes.error.message)

  // Aggregate organic sessions by date (multiple sources per date with medium=organic)
  const orgMap = new Map<string, number>()
  for (const row of orgRes.data ?? []) {
    orgMap.set(row.date, (orgMap.get(row.date) ?? 0) + (row.sessions ?? 0))
  }
  const orgRows = Array.from(orgMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessions]) => ({ date, sessions }))

  return (
    <GooglePageClient
      gscRows={gscRes.data ?? []}
      ga4Rows={ga4Res.data ?? []}
      orgRows={orgRows}
    />
  )
}
