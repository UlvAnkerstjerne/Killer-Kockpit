'use server'

/**
 * lib/actions/marketing/google-ads.ts
 *
 * Server action for Google Ads performance data.
 * Pure aggregation logic lives in google-ads-utils.ts (importable from tests/client).
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing } from '@/lib/permissions'
import { aggregateAdsData } from './google-ads-utils'
import type { GoogleAdsData, RawDailyRow, RawCampaignRow } from './google-ads-utils'

// Re-export types so consumers can import from either file
export type {
  GoogleAdsData,
  AdsKpis,
  AdsCampaignRow,
  AdsDailyRow,
  AdsConversionBreakdownRow,
} from './google-ads-utils'

export async function getGoogleAdsPerformance(
  days: 28 | 90,
): Promise<GoogleAdsData> {
  const EMPTY: GoogleAdsData = {
    kpis: {
      spend: 0, spendPrior: 0, conversions: 0, convPrior: 0,
      costPerResult: null, cprPrior: null,
      clicks: 0, clicksPrior: 0, impressions: 0, imprPrior: 0,
      ctr: 0, ctrPrior: 0, resultLabel: 'Conversions',
    },
    campaigns: [], daily: [], currency: 'DKK', hasData: false,
  }

  const user = await getCurrentUser()
  if (!user) return EMPTY
  if (!canAccessMarketing(user.role, user.marketing_access)) return EMPTY

  const db = createServiceClient()

  // Date windows
  const daysAgo = (n: number) => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return d.toISOString().slice(0, 10)
  }
  const curEnd   = daysAgo(1)
  const curStart = daysAgo(days)
  const priEnd   = daysAgo(days + 1)
  const priStart = daysAgo(days * 2)

  // Fetch account currency
  const { data: accounts } = await db
    .from('google_ads_accounts')
    .select('currency_code')
    .limit(1)
  const currency = (accounts?.[0]?.currency_code as string) ?? 'DKK'

  // Fetch campaigns
  const { data: campaignData } = await db
    .from('google_ads_campaigns')
    .select('campaign_id, name, status, channel_type')
  const campaigns = (campaignData ?? []) as RawCampaignRow[]

  // Fetch daily data covering both periods
  const { data: dailyData } = await db
    .from('google_ads_campaign_daily')
    .select('campaign_id, date, impressions, clicks, cost, conversions, conversion_results')
    .gte('date', priStart)
    .lte('date', curEnd)

  const dailyRows = (dailyData ?? []) as unknown as RawDailyRow[]
  if (dailyRows.length === 0) return EMPTY

  const { kpis, campaigns: campRows, daily } = aggregateAdsData(
    dailyRows, campaigns, curStart, curEnd, priStart, priEnd,
  )

  return { kpis, campaigns: campRows, daily, currency, hasData: true }
}
