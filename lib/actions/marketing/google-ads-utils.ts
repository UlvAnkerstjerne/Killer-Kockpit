/**
 * lib/actions/marketing/google-ads-utils.ts
 *
 * Pure aggregation functions for Google Ads data.
 * Separated from the server action file so they can be imported in tests
 * without the 'use server' constraint.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdsConversionBreakdownRow {
  actionName: string
  category:   string
  conversions: number
}

export interface AdsCampaignRow {
  campaignId:    string
  name:          string
  status:        string
  channelType:   string
  spend:         number
  impressions:   number
  clicks:        number
  conversions:   number
  costPerResult: number | null
  resultLabel:   string
  breakdown:     AdsConversionBreakdownRow[]
}

export interface AdsKpis {
  spend:         number
  spendPrior:    number
  conversions:   number
  convPrior:     number
  costPerResult: number | null
  cprPrior:      number | null
  clicks:        number
  clicksPrior:   number
  impressions:   number
  imprPrior:     number
  ctr:           number
  ctrPrior:      number
  resultLabel:   string
}

export interface AdsDailyRow {
  date:        string
  spend:       number
  conversions: number
}

export interface GoogleAdsData {
  kpis:       AdsKpis
  campaigns:  AdsCampaignRow[]
  daily:      AdsDailyRow[]
  currency:   string
  hasData:    boolean
}

// ── Raw DB row types ──────────────────────────────────────────────────────────

export interface RawDailyRow {
  campaign_id:        string
  date:               string
  impressions:        number | null
  clicks:             number | null
  cost:               number | null
  conversions:        number | null
  conversion_results: ConversionResultEntry[] | null
}

export interface ConversionResultEntry {
  action_name:    string
  category:       string
  conversions:    string
  all_conversions: string
}

export interface RawCampaignRow {
  campaign_id:  string
  name:         string
  status:       string
  channel_type: string
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export function aggregateAdsData(
  dailyRows: RawDailyRow[],
  campaigns: RawCampaignRow[],
  curStart: string,
  curEnd: string,
  priStart: string,
  priEnd: string,
): { kpis: AdsKpis; campaigns: AdsCampaignRow[]; daily: AdsDailyRow[] } {
  const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]))

  const curRows = dailyRows.filter(r => r.date >= curStart && r.date <= curEnd)
  const priRows = dailyRows.filter(r => r.date >= priStart && r.date <= priEnd)

  const totals = (rows: RawDailyRow[]) => {
    let spend = 0, conversions = 0, clicks = 0, impressions = 0
    for (const r of rows) {
      spend       += Number(r.cost ?? 0)
      conversions += Number(r.conversions ?? 0)
      clicks      += Number(r.clicks ?? 0)
      impressions += Number(r.impressions ?? 0)
    }
    return { spend, conversions, clicks, impressions }
  }

  const cur = totals(curRows)
  const pri = totals(priRows)

  const overallBreakdown = aggregateBreakdown(curRows)
  const resultLabel = deriveResultLabel(overallBreakdown)

  const cpr     = cur.conversions > 0 ? cur.spend / cur.conversions : null
  const cprPri  = pri.conversions > 0 ? pri.spend / pri.conversions : null
  const ctr     = cur.impressions > 0 ? (cur.clicks / cur.impressions) * 100 : 0
  const ctrPri  = pri.impressions > 0 ? (pri.clicks / pri.impressions) * 100 : 0

  const kpis: AdsKpis = {
    spend: cur.spend, spendPrior: pri.spend,
    conversions: cur.conversions, convPrior: pri.conversions,
    costPerResult: cpr, cprPrior: cprPri,
    clicks: cur.clicks, clicksPrior: pri.clicks,
    impressions: cur.impressions, imprPrior: pri.impressions,
    ctr, ctrPrior: ctrPri,
    resultLabel,
  }

  // Per-campaign
  const campAgg = new Map<string, {
    spend: number; impressions: number; clicks: number; conversions: number
    breakdownRows: RawDailyRow[]
  }>()

  for (const r of curRows) {
    const agg = campAgg.get(r.campaign_id) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, breakdownRows: [] }
    agg.spend       += Number(r.cost ?? 0)
    agg.impressions += Number(r.impressions ?? 0)
    agg.clicks      += Number(r.clicks ?? 0)
    agg.conversions += Number(r.conversions ?? 0)
    agg.breakdownRows.push(r)
    campAgg.set(r.campaign_id, agg)
  }

  const campaignRows: AdsCampaignRow[] = []
  for (const [campId, agg] of campAgg) {
    const meta = campaignMap.get(campId)
    if (!meta) continue
    const breakdown = aggregateBreakdown(agg.breakdownRows)
    const campResultLabel = deriveResultLabel(breakdown)

    campaignRows.push({
      campaignId:    campId,
      name:          meta.name,
      status:        meta.status,
      channelType:   meta.channel_type,
      spend:         agg.spend,
      impressions:   agg.impressions,
      clicks:        agg.clicks,
      conversions:   agg.conversions,
      costPerResult: agg.conversions > 0 ? agg.spend / agg.conversions : null,
      resultLabel:   campResultLabel,
      breakdown,
    })
  }
  campaignRows.sort((a, b) => b.spend - a.spend)

  // Daily trend
  const dayMap = new Map<string, { spend: number; conversions: number }>()
  for (const r of curRows) {
    const d = dayMap.get(r.date) ?? { spend: 0, conversions: 0 }
    d.spend       += Number(r.cost ?? 0)
    d.conversions += Number(r.conversions ?? 0)
    dayMap.set(r.date, d)
  }
  const daily = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, spend: d.spend, conversions: d.conversions }))

  return { kpis, campaigns: campaignRows, daily }
}

// ── Conversion breakdown helpers ──────────────────────────────────────────────

function aggregateBreakdown(rows: RawDailyRow[]): AdsConversionBreakdownRow[] {
  const map = new Map<string, { actionName: string; category: string; conversions: number }>()
  for (const r of rows) {
    if (!r.conversion_results || !Array.isArray(r.conversion_results)) continue
    for (const cr of r.conversion_results) {
      const key = cr.action_name
      const agg = map.get(key) ?? { actionName: cr.action_name, category: cr.category, conversions: 0 }
      agg.conversions += Number(cr.conversions ?? 0)
      map.set(key, agg)
    }
  }
  return Array.from(map.values())
    .filter(r => r.conversions > 0)
    .sort((a, b) => b.conversions - a.conversions)
}

function deriveResultLabel(breakdown: AdsConversionBreakdownRow[]): string {
  if (breakdown.length === 0) return 'Conversions'
  if (breakdown.length === 1) return categoryLabel(breakdown[0].category)
  const total = breakdown.reduce((a, b) => a + b.conversions, 0)
  const top = breakdown[0]
  if (top.conversions / total > 0.8) return categoryLabel(top.category)
  return 'Conversions'
}

const CATEGORY_LABELS: Record<string, string> = {
  GET_DIRECTIONS:    'Directions',
  PHONE_CALL_LEAD:   'Calls',
  CONTACT:           'Contacts',
  PURCHASE:          'Purchases',
  ADD_TO_CART:       'Add to cart',
  BEGIN_CHECKOUT:    'Checkouts',
  OUTBOUND_CLICK:   'Outbound clicks',
  PAGE_VIEW:        'Page views',
  SUBMIT_LEAD_FORM: 'Leads',
  ENGAGEMENT:       'Engagements',
  STORE_VISIT:      'Store visits',
  DOWNLOAD:         'Downloads',
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}
