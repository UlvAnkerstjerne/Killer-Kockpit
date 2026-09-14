import { getMetaCampaigns, getAllCampaignInsights } from '@/lib/actions/marketing/meta-assets'
import type { MetaInsightActionItem } from '@/lib/marketing/types/meta'
import PaidPageClient, { type CampaignCardData, type CampaignTotals } from './PaidPageClient'

export const dynamic = 'force-dynamic'

// ─── Aggregation (server-only) ─────────────────────────────────────────────────

function getAction(actions: MetaInsightActionItem[] | null, type: string): number {
  return Number(actions?.find(a => a.action_type === type)?.value ?? 0)
}

function aggregate(
  rows: { date_start: string; impressions: number | null; reach: number | null; clicks: number | null; spend: string | null; actions_json: MetaInsightActionItem[] | null }[]
): CampaignTotals | null {
  if (!rows.length) return null
  let spend = 0, impressions = 0, reach = 0, clicks = 0
  let linkClicks = 0, landingPageViews = 0, videoViews = 0, postEngagement = 0
  const dates = rows.map(r => r.date_start).sort()

  for (const r of rows) {
    spend        += Number(r.spend ?? 0)
    impressions  += Number(r.impressions ?? 0)
    reach        += Number(r.reach ?? 0)
    clicks       += Number(r.clicks ?? 0)
    linkClicks   += getAction(r.actions_json, 'link_click')
    const lpv    = getAction(r.actions_json, 'landing_page_view')
    landingPageViews += lpv > 0 ? lpv : getAction(r.actions_json, 'omni_landing_page_view')
    videoViews       += getAction(r.actions_json, 'video_view')
    postEngagement   += getAction(r.actions_json, 'post_engagement')
  }

  return {
    spend, impressions, reach, clicks,
    linkClicks, landingPageViews, videoViews, postEngagement,
    days: rows.length,
    firstDate: dates[0],
    lastDate:  dates[dates.length - 1],
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PaidPage() {
  const [campaigns, allInsights] = await Promise.all([
    getMetaCampaigns(),
    getAllCampaignInsights(),
  ])

  // Group insights by campaign_id
  const byId = new Map<string, typeof allInsights>()
  for (const row of allInsights) {
    const arr = byId.get(row.campaign_id) ?? []
    arr.push(row)
    byId.set(row.campaign_id, arr)
  }

  // Build serialisable card data — exclude ZZ-prefixed internal campaigns
  // Sort: ACTIVE first, then by spend desc within each status group
  const cards: CampaignCardData[] = campaigns
    .filter(c => !c.name.toUpperCase().startsWith('ZZ '))
    .map(c => ({
      id:        c.id,
      name:      c.name,
      status:    c.status,
      objective: c.objective,
      totals:    aggregate(byId.get(c.id) ?? []),
    }))
    .sort((a, b) => {
      const statusOrder: Record<string, number> = { ACTIVE: 0, PAUSED: 1, ARCHIVED: 2, DELETED: 3 }
      const ao = statusOrder[a.status] ?? 9
      const bo = statusOrder[b.status] ?? 9
      if (ao !== bo) return ao - bo
      return (b.totals?.spend ?? 0) - (a.totals?.spend ?? 0)
    })

  const dataCount = cards.filter(c => c.totals !== null && c.status === 'ACTIVE').length

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Paid</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Marketing · Paid · Meta Ads · {dataCount} active campaigns with data
        </p>
      </div>
      <PaidPageClient campaigns={cards} />
    </div>
  )
}
