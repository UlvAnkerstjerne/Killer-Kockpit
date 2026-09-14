import { getMetaCampaigns, getAllCampaignInsights } from '@/lib/actions/marketing/meta-assets'
import type { MetaInsightActionItem } from '@/lib/marketing/types/meta'

export const dynamic = 'force-dynamic'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAction(actions: MetaInsightActionItem[] | null, type: string): number {
  return Number(actions?.find(a => a.action_type === type)?.value ?? 0)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1_000) + 'K'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString('en-GB')
}

function fmtDKK(n: number, decimals = 0): string {
  return n.toLocaleString('da-DK', {
    style: 'currency',
    currency: 'DKK',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function objectiveLabel(obj: string | null): string {
  if (!obj) return '—'
  return (
    { OUTCOME_AWARENESS: 'Awareness', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_APP_PROMOTION: 'App' }[obj] ?? obj
  )
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

interface Totals {
  spend: number
  impressions: number
  reach: number
  clicks: number
  linkClicks: number
  landingPageViews: number
  videoViews: number
  postEngagement: number
  days: number
  firstDate: string
  lastDate: string
}

function aggregate(rows: { campaign_id: string; date_start: string; impressions: number | null; reach: number | null; clicks: number | null; spend: string | null; actions_json: MetaInsightActionItem[] | null }[]): Totals | null {
  if (!rows.length) return null
  let spend = 0, impressions = 0, reach = 0, clicks = 0
  let linkClicks = 0, landingPageViews = 0, videoViews = 0, postEngagement = 0
  const dates = rows.map(r => r.date_start).sort()

  for (const r of rows) {
    spend     += Number(r.spend ?? 0)
    impressions += Number(r.impressions ?? 0)
    reach     += Number(r.reach ?? 0)
    clicks    += Number(r.clicks ?? 0)
    linkClicks += getAction(r.actions_json, 'link_click')
    const lpv = getAction(r.actions_json, 'landing_page_view')
    landingPageViews += lpv > 0 ? lpv : getAction(r.actions_json, 'omni_landing_page_view')
    videoViews    += getAction(r.actions_json, 'video_view')
    postEngagement += getAction(r.actions_json, 'post_engagement')
  }

  return {
    spend, impressions, reach, clicks,
    linkClicks, landingPageViews, videoViews, postEngagement,
    days: rows.length,
    firstDate: dates[0],
    lastDate:  dates[dates.length - 1],
  }
}

// ─── Primary metric per objective ─────────────────────────────────────────────

interface PrimaryMetric {
  label: string
  formatted: string
  costLabel: string
  costFormatted: string | null
  note: string | null
}

function getPrimary(objective: string | null, t: Totals): PrimaryMetric {
  const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null

  if (objective === 'OUTCOME_AWARENESS') {
    return {
      label: 'Reach',
      formatted: fmt(t.reach),
      costLabel: 'CPM',
      costFormatted: cpm !== null ? fmtDKK(cpm, 2) : null,
      note: 'Cumulative sum of daily reach',
    }
  }

  if (objective === 'OUTCOME_TRAFFIC') {
    const lpvShare = t.linkClicks > 0 ? t.landingPageViews / t.linkClicks : 0
    if (lpvShare > 0.1 && t.landingPageViews > 0) {
      return {
        label: 'Landing Page Views',
        formatted: fmt(t.landingPageViews),
        costLabel: 'Cost / LPV',
        costFormatted: fmtDKK(t.spend / t.landingPageViews, 2),
        note: null,
      }
    }
    return {
      label: 'Link Clicks',
      formatted: fmt(t.linkClicks),
      costLabel: 'Cost / Click',
      costFormatted: t.linkClicks > 0 ? fmtDKK(t.spend / t.linkClicks, 2) : null,
      note: `LPV not meaningfully tracked (${fmt(t.landingPageViews)} recorded)`,
    }
  }

  if (objective === 'OUTCOME_ENGAGEMENT') {
    return {
      label: 'Post Engagements',
      formatted: fmt(t.postEngagement),
      costLabel: 'Cost / Engagement',
      costFormatted: t.postEngagement > 0 ? fmtDKK(t.spend / t.postEngagement, 2) : null,
      note: null,
    }
  }

  return {
    label: 'Impressions',
    formatted: fmt(t.impressions),
    costLabel: 'CPM',
    costFormatted: cpm !== null ? fmtDKK(cpm, 2) : null,
    note: null,
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PaidPage() {
  const [campaigns, allInsights] = await Promise.all([
    getMetaCampaigns(),
    getAllCampaignInsights(),
  ])

  const filtered = campaigns.filter(c => !c.name.toUpperCase().startsWith('ZZ '))

  // Group insights by campaign_id
  const byId = new Map<string, typeof allInsights>()
  for (const row of allInsights) {
    const arr = byId.get(row.campaign_id) ?? []
    arr.push(row)
    byId.set(row.campaign_id, arr)
  }

  // Enrich and sort: ACTIVE first, then by spend desc
  const enriched = filtered
    .map(c => ({ campaign: c, totals: aggregate(byId.get(c.id) ?? []) }))
    .sort((a, b) => {
      const aActive = a.campaign.status === 'ACTIVE' ? 0 : 1
      const bActive = b.campaign.status === 'ACTIVE' ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      return (b.totals?.spend ?? 0) - (a.totals?.spend ?? 0)
    })

  const withData = enriched.filter(e => e.totals !== null)
  const noData   = enriched.filter(e => e.totals === null)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Paid</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Marketing · Paid · Meta Ads · {withData.length} campaigns with data
        </p>
      </div>

      <div className="space-y-3">
        {withData.map(({ campaign, totals }) => {
          const t = totals!
          const primary = getPrimary(campaign.objective, t)
          const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null
          const ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null
          const avgFreq = t.reach > 0 ? t.impressions / t.reach : null
          const isActive = campaign.status === 'ACTIVE'
          const isAwareness = campaign.objective === 'OUTCOME_AWARENESS'
          const isTraffic = campaign.objective === 'OUTCOME_TRAFFIC'

          return (
            <div key={campaign.id} className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
              {/* Campaign header */}
              <div className="px-5 py-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={[
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold shrink-0',
                      isActive ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                    ].join(' ')}>
                      {isActive ? 'Active' : 'Paused'}
                    </span>
                    <span className="text-sm font-semibold text-kk-ink truncate">{campaign.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-kk-muted flex-wrap">
                    <span>{objectiveLabel(campaign.objective)}</span>
                    <span>·</span>
                    <span>{t.days} days</span>
                    <span>·</span>
                    <span>{fmtDate(t.firstDate)} – {fmtDate(t.lastDate)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-kk-ink">{fmtDKK(t.spend)}</div>
                  <div className="text-xs text-kk-muted mt-0.5">spend</div>
                </div>
              </div>

              {/* Primary metric */}
              <div className="px-5 pb-4 flex items-end gap-6 flex-wrap">
                <div>
                  <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                    {primary.label}
                  </div>
                  <div className="text-3xl font-black text-kk-ink leading-none">
                    {primary.formatted}
                  </div>
                  {primary.note && (
                    <div className="text-xs text-kk-muted mt-1 italic">{primary.note}</div>
                  )}
                </div>
                {primary.costFormatted && (
                  <div className="pb-0.5">
                    <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                      {primary.costLabel}
                    </div>
                    <div className="text-lg font-bold text-kk-ink">{primary.costFormatted}</div>
                  </div>
                )}
              </div>

              {/* Secondary metrics bar */}
              <div className="border-t border-kk-line px-5 py-3 flex items-center gap-5 flex-wrap">
                <Stat label="Impressions" value={fmt(t.impressions)} />
                <Stat label="Reach"       value={fmt(t.reach)} />
                {avgFreq !== null && <Stat label="Avg Frequency" value={avgFreq.toFixed(2)} />}
                {cpm !== null     && <Stat label="CPM"           value={fmtDKK(cpm, 2)} />}
                {isAwareness && t.videoViews > 0    && <Stat label="Video Views"     value={fmt(t.videoViews)} />}
                {isAwareness && t.postEngagement > 0 && <Stat label="Post Engagement" value={fmt(t.postEngagement)} />}
                {isTraffic && (
                  <>
                    <Stat label="Link Clicks" value={fmt(t.linkClicks)} />
                    {ctr !== null && <Stat label="CTR" value={ctr.toFixed(2) + '%'} />}
                    {t.landingPageViews > 0 && <Stat label="LPV" value={fmt(t.landingPageViews)} />}
                  </>
                )}
              </div>
            </div>
          )
        })}

        {/* Campaigns without data */}
        {noData.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                No data synced{' '}
                <span className="font-normal text-kk-muted">· {noData.length}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {noData.map(({ campaign }) => (
                <div key={campaign.id} className="flex items-center gap-3 px-5 py-3">
                  <span className={[
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold shrink-0',
                    campaign.status === 'ACTIVE' ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                  ].join(' ')}>
                    {campaign.status === 'ACTIVE' ? 'Active' : 'Paused'}
                  </span>
                  <span className="text-sm text-kk-muted flex-1 truncate">{campaign.name}</span>
                  <span className="text-xs text-kk-muted shrink-0">{objectiveLabel(campaign.objective)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Small stat chip ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-kk-muted">{label}</div>
      <div className="text-sm font-semibold text-kk-ink">{value}</div>
    </div>
  )
}
