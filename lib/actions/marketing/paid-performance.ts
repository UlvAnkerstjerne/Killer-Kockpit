import 'server-only'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import type { MarketingPermission } from '@/lib/marketing/types'
import type { MetaCampaignInsightRow, MetaCampaignRow } from '@/lib/marketing/types/meta'
import { buildGooglePaidCampaigns, buildMetaPaidCampaigns, paidPeriod, paidRange,
  type GooglePaidAccount, type GooglePaidAction, type GooglePaidCampaign, type GooglePaidDaily,
  type PaidCampaign, type PaidPlatform, type PaidRange } from '@/lib/marketing/paid-performance'

type Db = ReturnType<typeof createServiceClient>
type PageResponse = { data: unknown[] | null; error: unknown }

/** Stable ordering plus the actual returned offset also handles a lower server row cap. */
async function readPages<T>(query: (offset: number) => PromiseLike<PageResponse>): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const { data, error } = await query(rows.length)
    if (error) throw new Error('Paid reporting query failed')
    if (!data?.length) return rows
    rows.push(...data as T[])
  }
}

async function readGoogle(db: Db, range: PaidRange): Promise<PaidCampaign[]> {
  const [accounts, campaigns, actions, daily] = await Promise.all([
    readPages<GooglePaidAccount>(offset => db.from('google_ads_accounts').select('customer_id,name,currency_code,time_zone')
      .order('customer_id').range(offset, offset + 499)),
    readPages<GooglePaidCampaign>(offset => db.from('google_ads_campaigns')
      .select('customer_id,campaign_id,name,status,channel_type,goal_config_level,conversion_goals,custom_conversion_goal')
      .order('customer_id').order('campaign_id').range(offset, offset + 499)),
    readPages<GooglePaidAction>(offset => db.from('google_ads_conversion_actions')
      .select('customer_id,resource_name,name,category,origin,primary_for_goal,status,type')
      .order('customer_id').order('resource_name').range(offset, offset + 499)),
    readPages<GooglePaidDaily>(offset => db.from('google_ads_campaign_daily')
      .select('customer_id,campaign_id,date,cost_micros,impressions,clicks,conversions,all_conversions,conversion_results')
      .gte('date', range.start).lte('date', range.end)
      .order('date').order('customer_id').order('campaign_id').range(offset, offset + 499)),
  ])
  return buildGooglePaidCampaigns(campaigns, accounts, actions, daily, range)
}

async function readMeta(db: Db, range: PaidRange): Promise<PaidCampaign[]> {
  const [accounts, campaigns, daily] = await Promise.all([
    readPages<{ id: string; name: string; currency: string }>(offset => db.from('meta_ad_accounts')
      .select('id,name,currency').order('id').range(offset, offset + 499)),
    readPages<MetaCampaignRow>(offset => db.from('meta_ad_campaigns').select('id,ad_account_id,name,status,objective')
      .order('id').range(offset, offset + 499)),
    readPages<MetaCampaignInsightRow>(offset => db.from('meta_campaign_insights')
      .select('campaign_id,date_start,impressions,reach,clicks,spend,actions_json')
      .gte('date_start', range.start).lte('date_start', range.end)
      .order('date_start').order('campaign_id').range(offset, offset + 499)),
  ])
  return buildMetaPaidCampaigns(campaigns, accounts, daily, range)
}

/** Server-only read model. Same identity, workspace and paid_manage gates as Meta. */
export async function getPaidPerformance(requestedPeriod: unknown, now = new Date()) {
  const period = paidPeriod(requestedPeriod)
  const range = paidRange(period, now)
  const campaigns: PaidCampaign[] = []
  const errors: { platform: PaidPlatform; message: string }[] = []
  const base = { period, range, campaigns, errors }
  const user = await getCurrentUser()
  if (!user || !canAccessMarketing(user.role, user.marketing_access)) return { ...base, allowed: false }
  const db = createServiceClient()
  if (user.role !== 'SUPER_ADMIN') {
    const { data, error } = await db.from('user_marketing_permissions').select('permission').eq('user_id', user.id)
    if (error || !hasMarketingPermission(user.role, (data ?? []).map(r => r.permission as MarketingPermission), 'paid_manage')) {
      return { ...base, allowed: false }
    }
  }
  const providers = ['meta', 'google'] as const
  const results = await Promise.allSettled([readMeta(db, range), readGoogle(db, range)])
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') campaigns.push(...result.value)
    else errors.push({ platform: providers[index], message: `${index === 0 ? 'Meta' : 'Google Ads'} performance could not be loaded. Reload to try again.` })
  })
  return { ...base, allowed: true }
}
