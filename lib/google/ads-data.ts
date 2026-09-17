/** Reporting types and pure transformations. IDs and micros retain exact integers. */
export interface AdsCustomer {
  id: string; descriptiveName?: string; currencyCode: string; timeZone: string; manager?: boolean
  conversionTrackingSetting?: { googleAdsConversionCustomer?: string }
}
export interface AdsCampaign {
  id: string; name: string; status: string; advertisingChannelType: string
  advertisingChannelSubType?: string; biddingStrategyType?: string
}
export interface AdsConversionAction {
  resourceName: string; id: string; name: string; status: string; type: string; category: string
  origin?: string; primaryForGoal?: boolean
}
export interface AdsMetrics {
  impressions?: string; clicks?: string; costMicros?: string
  conversions?: number | string; conversionsValue?: number | string
  allConversions?: number | string; allConversionsValue?: number | string
}
export interface AdsMetricRow {
  campaign: { id: string }
  segments: { date: string; conversionAction?: string; conversionActionName?: string; conversionActionCategory?: string }
  metrics?: AdsMetrics
}
export interface AdsConversionResult {
  action_resource_name: string; action_name: string | null; category: string | null
  conversions: string; conversion_value: string; all_conversions: string; all_conversion_value: string
}
export interface AdsDailyRow {
  customer_id: string; campaign_id: string; date: string; impressions: string; clicks: string; cost_micros: string
  conversions: string; conversion_value: string; all_conversions: string; all_conversion_value: string
  conversion_results: AdsConversionResult[]; synced_at: string
}

export function adsDateRange(now: Date, timeZone: string, isBackfill: boolean) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(now)
  const shift = (days: number) => {
    const date = new Date(`${today}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
  }
  // Inclusive range: exactly 90 or 14 completed account-local calendar days.
  return { start: shift(isBackfill ? -90 : -14), end: shift(-1) }
}

function decimal(value: number | string | undefined): string {
  if (value === undefined) return '0' // Google omits protobuf scalar defaults.
  if (!Number.isFinite(Number(value))) throw new Error('Invalid Google Ads metric.')
  return String(value)
}
function integer(value: string | undefined): string {
  if (value === undefined) return '0'
  if (!/^-?\d+$/.test(value)) throw new Error('Invalid Google Ads integer metric.')
  return value
}

/** Spend is stored once per campaign/day. Conversion segmentation never repeats it.
 * Previously stored days missing from a complete refreshed report are cleared to
 * zero: Google omits all-zero rows, including after attribution corrections. */
export function buildAdsDailyRows(customerId: string, totals: AdsMetricRow[], results: AdsMetricRow[],
  previous: Array<{ campaign_id: string; date: string }>, range: { start: string; end: string }, syncedAt: string): AdsDailyRow[] {
  const rows = new Map<string, AdsDailyRow>()
  const get = (campaignId: string, date: string) => {
    if (!/^\d+$/.test(campaignId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < range.start || date > range.end) {
      throw new Error('Google Ads returned an invalid campaign/date.')
    }
    const key = `${campaignId}/${date}`
    if (!rows.has(key)) rows.set(key, { customer_id: customerId, campaign_id: campaignId, date,
      impressions: '0', clicks: '0', cost_micros: '0', conversions: '0', conversion_value: '0',
      all_conversions: '0', all_conversion_value: '0', conversion_results: [], synced_at: syncedAt })
    return rows.get(key)!
  }
  for (const row of previous) get(row.campaign_id, row.date)
  const seen = new Set<string>()
  for (const row of totals) {
    const target = get(row.campaign.id, row.segments.date)
    const key = `${target.campaign_id}/${target.date}`
    if (seen.has(key)) throw new Error('Duplicate Google Ads campaign/day total.')
    seen.add(key)
    const m = row.metrics ?? {}
    Object.assign(target, { impressions: integer(m.impressions), clicks: integer(m.clicks), cost_micros: integer(m.costMicros),
      conversions: decimal(m.conversions), conversion_value: decimal(m.conversionsValue),
      all_conversions: decimal(m.allConversions), all_conversion_value: decimal(m.allConversionsValue) })
  }
  for (const row of results) {
    const action = row.segments.conversionAction
    if (!action || !/^customers\/\d{10}\/conversionActions\/\d+$/.test(action)) throw new Error('Missing Google Ads conversion action.')
    if (!seen.has(`${row.campaign.id}/${row.segments.date}`)) throw new Error('Google Ads conversion results have no matching daily total.')
    const target = get(row.campaign.id, row.segments.date)
    if (target.conversion_results.some(r => r.action_resource_name === action)) throw new Error('Duplicate Google Ads conversion result.')
    const m = row.metrics ?? {}
    target.conversion_results.push({ action_resource_name: action, action_name: row.segments.conversionActionName ?? null,
      category: row.segments.conversionActionCategory ?? null, conversions: decimal(m.conversions),
      conversion_value: decimal(m.conversionsValue), all_conversions: decimal(m.allConversions), all_conversion_value: decimal(m.allConversionsValue) })
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.campaign_id.localeCompare(b.campaign_id))
}
