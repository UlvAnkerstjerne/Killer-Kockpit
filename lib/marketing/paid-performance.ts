import type { MetaCampaignInsightRow, MetaCampaignRow } from './types/meta'

export type PaidPlatform = 'meta' | 'google'
export type PaidPeriod = 28 | 90
export interface PaidRange { start: string; end: string }
export interface PaidResult {
  id: string; label: string; name: string; count: number; costPerResult: number | null
}
export interface GoogleResultDetail extends PaidResult {
  category: string; allCount: number; value: number; allValue: number; primary: boolean
}
export interface PaidMetric { label: string; value: number | null; format: 'number' | 'money' | 'percent' | 'decimal' }
export interface PaidCampaign {
  id: string; platform: PaidPlatform; name: string; status: string; type: string; goal: string
  currency: string; accountName: string; spend: number; impressions: number; clicks: number
  hasActivity: boolean; firstDate: string | null; lastDate: string | null
  results: PaidResult[]; metrics: PaidMetric[]; googleResults?: GoogleResultDetail[]
  goalNote?: string
}
export interface GooglePaidAccount { customer_id: string; name: string | null; currency_code: string; time_zone: string }
export interface GooglePaidCampaign {
  customer_id: string; campaign_id: string; name: string; status: string; channel_type: string
  goal_config_level: string | null
  conversion_goals: { category: string; origin: string; biddable: boolean }[]
  custom_conversion_goal: { resourceName: string; conversionActions?: string[] } | null
}
export interface GooglePaidAction {
  customer_id: string; resource_name: string; name: string; category: string
  origin: string | null; primary_for_goal: boolean; status: string; type: string
}
export interface GooglePaidDaily {
  customer_id: string; campaign_id: string; date: string; cost_micros: string | number
  impressions: number | string; clicks: number | string; conversions: number | string; all_conversions: number | string
  conversion_results: {
    action_resource_name: string; action_name: string; category: string
    conversions: string | number; all_conversions: string | number
    conversion_value: string | number; all_conversion_value: string | number
  }[]
}

export function paidPeriod(value: unknown): PaidPeriod { return value === '90' || value === 90 ? 90 : 28 }

/** Shared completed calendar days; Kockpit and the connected Ads account use Copenhagen time. */
export function paidRange(period: PaidPeriod, now = new Date()): PaidRange {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(now)
  const shift = (days: number) => {
    const date = new Date(`${today}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() - days)
    return date.toISOString().slice(0, 10)
  }
  return { start: shift(period), end: shift(1) }
}

export function costPerResult(spend: number, count: number): number | null { return count > 0 ? spend / count : null }
const inRange = (date: string, range: PaidRange) => date >= range.start && date <= range.end
const key = (customer: string, campaign: string) => `${customer}:${campaign}`

export function googleResultLabel(category: string, name: string): string {
  return ({ GET_DIRECTIONS: 'Directions requests', ADD_TO_CART: 'Add to cart', BEGIN_CHECKOUT: 'Begin checkout',
    PURCHASE: 'Purchases', PHONE_CALL_LEAD: 'Phone call leads',
    SUBMIT_LEAD_FORM: 'Lead form submissions', STORE_VISIT: 'Store visits', DOWNLOAD: 'Downloads',
  } as Record<string, string>)[category] ?? name
}

export function googleActionIsPrimary(campaign: GooglePaidCampaign, action: GooglePaidAction): boolean {
  if (campaign.customer_id !== action.customer_id) return false
  // Custom actions are additive to biddable standard goals, even when secondary.
  if (isCustomAction(campaign, action.resource_name)) return true
  return action.primary_for_goal && campaign.conversion_goals.some(goal =>
    goal.biddable && goal.category === action.category && goal.origin === action.origin)
}

function isCustomAction(campaign: GooglePaidCampaign, resource: string): boolean {
  return campaign.goal_config_level === 'CAMPAIGN' && (campaign.custom_conversion_goal?.conversionActions?.includes(resource) ?? false)
}

export function buildGooglePaidCampaigns(
  campaigns: GooglePaidCampaign[], accounts: GooglePaidAccount[], actions: GooglePaidAction[], daily: GooglePaidDaily[], range: PaidRange,
): PaidCampaign[] {
  const accountById = new Map(accounts.map(a => [a.customer_id, a]))
  const byCampaign = new Map<string, GooglePaidDaily[]>()
  for (const row of daily) {
    if (!inRange(row.date, range)) continue
    const id = key(row.customer_id, row.campaign_id)
    const rows = byCampaign.get(id) ?? []
    rows.push(row); byCampaign.set(id, rows)
  }
  return campaigns.map(campaign => {
    const account = accountById.get(campaign.customer_id)
    if (!account) throw new Error('Google account metadata unavailable')
    const rows = byCampaign.get(key(campaign.customer_id, campaign.campaign_id)) ?? []
    const definitions = actions.filter(a => a.customer_id === campaign.customer_id)
    const definitionById = new Map(definitions.map(a => [a.resource_name, a]))
    const eligible = definitions.filter(a => googleActionIsPrimary(campaign, a))
    let micros = BigInt(0), impressions = 0, clicks = 0
    const details = new Map<string, GoogleResultDetail>()
    for (const row of rows) {
      micros += BigInt(row.cost_micros); impressions += Number(row.impressions); clicks += Number(row.clicks)
      for (const result of row.conversion_results) {
        const action = definitionById.get(result.action_resource_name)
        const detail = details.get(result.action_resource_name) ?? {
          id: result.action_resource_name, name: result.action_name, category: result.category,
          label: googleResultLabel(result.category, result.action_name), count: 0, allCount: 0, value: 0, allValue: 0,
          primary: isCustomAction(campaign, result.action_resource_name) || (!!action && googleActionIsPrimary(campaign, action)), costPerResult: null,
        }
        detail.count += Number(result.conversions); detail.allCount += Number(result.all_conversions)
        detail.value += Number(result.conversion_value); detail.allValue += Number(result.all_conversion_value)
        details.set(detail.id, detail)
      }
    }
    const spend = Number(micros) / 1_000_000
    const googleResults = [...details.values()].map(d => ({ ...d, costPerResult: costPerResult(spend, d.count) }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label) || a.name.localeCompare(b.name))
    // Each action is a separate result. Never add different actions or categories together.
    let results: PaidResult[] = googleResults.filter(d => d.primary && d.count > 0)
    if (!results.length) {
      const labels = [...new Set(eligible.filter(a => a.status === 'ENABLED').map(a => googleResultLabel(a.category, a.name)))]
      results = labels.map(label => ({ id: label, label, name: label, count: 0, costPerResult: null }))
    }
    const uniqueLabels = [...new Set(results.map(r => r.label))]
    const dates = rows.filter(r => Number(r.cost_micros) !== 0 || Number(r.impressions) !== 0 || Number(r.clicks) !== 0 || Number(r.all_conversions) !== 0 || Number(r.conversions) !== 0).map(r => r.date).sort()
    return {
      id: `google:${key(campaign.customer_id, campaign.campaign_id)}`, platform: 'google', name: campaign.name,
      status: campaign.status, type: ({ PERFORMANCE_MAX: 'Performance Max', SEARCH: 'Search', SMART: 'Smart', DISPLAY: 'Display', VIDEO: 'Video', SHOPPING: 'Shopping', DEMAND_GEN: 'Demand Gen' } as Record<string, string>)[campaign.channel_type] ?? campaign.channel_type,
      goal: uniqueLabels.length === 1 ? uniqueLabels[0] : uniqueLabels.length > 1 ? 'Multiple goals' : 'Primary goal unavailable',
      currency: account.currency_code, accountName: account.name ?? campaign.customer_id, spend, impressions, clicks,
      hasActivity: dates.length > 0, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null, results, googleResults,
      metrics: [{ label: 'Impressions', value: impressions, format: 'number' }, { label: 'Clicks', value: clicks, format: 'number' },
        { label: 'CTR', value: impressions > 0 ? clicks / impressions * 100 : null, format: 'percent' }],
      goalNote: campaign.goal_config_level === 'CAMPAIGN' && campaign.custom_conversion_goal && !campaign.custom_conversion_goal.conversionActions
        ? 'Custom goal action details are unavailable. Only verified standard goals can be identified as primary; other reported actions remain separate.'
        : eligible.length || results.length ? 'Primary results use the latest synced goal settings. Historical settings may have differed. Each cost/result uses the full campaign spend for that result alone.'
        : 'The stored goal settings do not identify a primary result. Reported actions are shown below without selecting an assumed goal.',
    }
  })
}

export function buildMetaPaidCampaigns(
  campaigns: MetaCampaignRow[], accounts: { id: string; name: string; currency: string }[], daily: MetaCampaignInsightRow[], range: PaidRange,
): PaidCampaign[] {
  const accountById = new Map(accounts.map(a => [a.id, a]))
  const byCampaign = new Map<string, MetaCampaignInsightRow[]>()
  for (const row of daily) {
    if (!inRange(row.date_start, range)) continue
    const rows = byCampaign.get(row.campaign_id) ?? []
    rows.push(row); byCampaign.set(row.campaign_id, rows)
  }
  return campaigns.filter(c => !c.name.toUpperCase().startsWith('ZZ ')).map(c => {
    const account = accountById.get(c.ad_account_id)
    if (!account) throw new Error('Meta account metadata unavailable')
    const rows = byCampaign.get(c.id) ?? []
    let spend = 0, impressions = 0, reach = 0, clicks = 0, linkClicks = 0, landingPageViews = 0, videoViews = 0, postEngagement = 0
    const action = (r: MetaCampaignInsightRow, type: string) => Number(r.actions_json?.find(a => a.action_type === type)?.value ?? 0)
    for (const r of rows) {
      spend += Number(r.spend ?? 0); impressions += Number(r.impressions ?? 0); reach += Number(r.reach ?? 0); clicks += Number(r.clicks ?? 0)
      linkClicks += action(r, 'link_click')
      const lpv = action(r, 'landing_page_view')
      landingPageViews += lpv > 0 ? lpv : action(r, 'omni_landing_page_view')
      videoViews += action(r, 'video_view'); postEngagement += action(r, 'post_engagement')
    }
    const cpm = impressions > 0 ? spend / impressions * 1000 : null
    const ctr = impressions > 0 ? clicks / impressions * 100 : null
    const frequency = reach > 0 ? impressions / reach : null
    const metric = (label: string, value: number | null, format: PaidMetric['format'] = 'number'): PaidMetric => ({ label, value, format })
    let label = 'Impressions', count = impressions, cost = cpm, efficiency = 'CPM'
    let metrics = [metric('CTR', ctr, 'percent'), metric('Clicks', clicks), metric('Daily avg freq.', frequency, 'decimal')]
    // Preserve the existing Meta objective-specific primary and efficiency rules.
    if (c.objective === 'OUTCOME_AWARENESS') {
      metrics = [metric('Video views', videoViews), metric('Post engagement', postEngagement), metric('Daily avg freq.', frequency, 'decimal')]
    } else if (c.objective === 'OUTCOME_TRAFFIC') {
      const useLPV = linkClicks > 0 && landingPageViews / linkClicks > 0.1 && landingPageViews > 0
      label = useLPV ? 'Landing page views' : 'Link clicks'; count = useLPV ? landingPageViews : linkClicks
      cost = costPerResult(spend, count); efficiency = 'Cost / result'
      metrics = [metric('CPM', cpm, 'money'), metric('CTR', ctr, 'percent'), metric('Impressions', impressions)]
    } else if (c.objective === 'OUTCOME_ENGAGEMENT') {
      label = 'Post engagement'; count = postEngagement; cost = costPerResult(spend, count); efficiency = 'Cost / result'
      metrics = [metric('CPM', cpm, 'money'), metric('Impressions', impressions), metric('Daily avg freq.', frequency, 'decimal')]
    }
    const dates = rows.filter(r => Number(r.spend) !== 0 || Number(r.impressions) !== 0 || Number(r.clicks) !== 0 || r.actions_json?.some(a => Number(a.value) !== 0)).map(r => r.date_start).sort()
    return {
      id: `meta:${c.id}`, platform: 'meta', name: c.name, status: c.status, type: 'Meta Ads',
      goal: ({ OUTCOME_AWARENESS: 'Awareness', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_APP_PROMOTION: 'App promotion', OUTCOME_LEADS: 'Leads', OUTCOME_SALES: 'Sales' } as Record<string, string>)[c.objective ?? ''] ?? c.objective ?? 'Unspecified goal',
      currency: account.currency, accountName: account.name, spend, impressions, clicks, hasActivity: dates.length > 0,
      firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
      results: [{ id: efficiency, label, name: label, count, costPerResult: cost }], metrics,
    }
  })
}

export function visiblePaidCampaigns(campaigns: PaidCampaign[], platform: string, statuses: string[], showInactive: boolean) {
  return campaigns.filter(c => (platform === 'all' || c.platform === platform) && (showInactive || c.hasActivity)
    && (!statuses.length || statuses.includes(c.status === 'ENABLED' ? 'ACTIVE' : c.status)))
    .sort((a, b) => Number(b.hasActivity) - Number(a.hasActivity)
      || Number(['ACTIVE', 'ENABLED'].includes(b.status)) - Number(['ACTIVE', 'ENABLED'].includes(a.status))
      || a.name.localeCompare(b.name))
}

export function formatPaidNumber(value: number, compact = true): string {
  // Fractional conversions retain two decimals; exact values are also available in titles.
  const fractional = Math.abs(value - Math.round(value)) > 0.000001
  return new Intl.NumberFormat('en-GB', { notation: compact && !fractional && Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: fractional ? 2 : compact && Math.abs(value) >= 1000 ? 1 : 0 }).format(value).replace(/[kmb]$/, suffix => suffix.toUpperCase())
}
export function formatPaidMoney(value: number | null, currency: string): string {
  return value === null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}
