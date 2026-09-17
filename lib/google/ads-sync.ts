import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, hasGoogleAdsScope } from './auth'
import { probeGoogleAds } from './ads'
import { GoogleAdsReportingError, searchGoogleAds } from './ads-client'
import { adsDateRange, buildAdsDailyRows, type AdsCustomer, type AdsCampaign, type AdsConversionAction, type AdsMetricRow } from './ads-data'

// Verified through the existing OAuth probe. Scope this institutional sync to
// Kockpit's connected account, rather than ingesting every account an admin can see.
export const GOOGLE_ADS_CUSTOMER_ID = '8582465933'
const SYNC_KEY = `google_ads_campaign_daily:${GOOGLE_ADS_CUSTOMER_ID}`
const BATCH_SIZE = 500
const LEASE_MS = 15 * 60 * 1000
type Db = ReturnType<typeof createServiceClient>
type State = { id: string; status: string; cursor: string | null; last_success_at: string | null; last_attempt_at: string | null }
type Goal = { campaign: string; category: string; origin: string; biddable?: boolean }
type GoalConfig = { campaign: string; goalConfigLevel?: string; customConversionGoal?: string }
type CustomGoal = { resourceName: string; name?: string; status?: string; conversionActions?: string[] }
class SyncError extends Error {}

export interface GoogleAdsSyncResult {
  ok: boolean; customerId: string; isBackfill: boolean; skipped: boolean
  dateRange: { start: string; end: string }; dailyRows: number; conversionResultRows: number
  campaigns: Array<{ id: string; name: string; status: string; type: string }>
  conversionActions: Array<{ name: string; category: string; type: string; primaryForGoal: boolean }>
  errors: string[]
}

async function readState(db: Db): Promise<State | null> {
  const { data, error } = await db.from('integration_sync_state').select('id,status,cursor,last_success_at,last_attempt_at')
    .eq('integration', SYNC_KEY).is('user_id', null).maybeSingle()
  if (error) throw new SyncError('Could not read Google Ads sync state.')
  return data as State | null
}

async function claimState(db: Db, state: State | null, startedAt: string): Promise<string | null> {
  const patch = { status: 'syncing', last_attempt_at: startedAt, last_error: null }
  if (!state) {
    const { data, error } = await db.from('integration_sync_state')
      .insert({ integration: SYNC_KEY, user_id: null, ...patch }).select('id').single()
    if (error?.code === '23505') return null
    if (error || !data) throw new SyncError('Could not create Google Ads sync state.')
    return data.id
  }
  let query = db.from('integration_sync_state').update(patch).eq('id', state.id).eq('status', state.status)
  query = state.last_attempt_at ? query.eq('last_attempt_at', state.last_attempt_at) : query.is('last_attempt_at', null)
  const { data, error } = await query.select('id').maybeSingle()
  if (error) throw new SyncError('Could not claim Google Ads sync state.')
  return data?.id ?? null
}

async function writeState(db: Db, id: string, startedAt: string, patch: Record<string, unknown>) {
  const { error } = await db.from('integration_sync_state').update(patch)
    .eq('id', id).eq('last_attempt_at', startedAt).select('id').single()
  if (error) throw new SyncError('Could not save Google Ads sync state.')
}

async function credentialOwner(db: Db): Promise<string> {
  const { data, error } = await db.from('google_oauth_tokens').select('user_id,scopes').order('user_id')
  if (error) throw new SyncError('Could not resolve the Google Ads OAuth connection.')
  const ids = (data ?? []).filter(row => hasGoogleAdsScope(row.scopes ?? [])).map(row => row.user_id)
  if (!ids.length) throw new SyncError('No Google Ads OAuth connection with the Ads scope is available.')
  const { data: users, error: userError } = await db.from('app_users').select('id').in('id', ids)
    .eq('active', true).eq('role', 'SUPER_ADMIN').order('id')
  if (userError || !users?.length) throw new SyncError('No active administrator owns the Google Ads OAuth connection.')
  return users[0].id
}

async function upsertRows(db: Db, table: string, rows: object[], onConflict: string) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const { error } = await db.from(table).upsert(rows.slice(offset, offset + BATCH_SIZE), { onConflict })
    if (error) throw new SyncError(`Could not save ${table}.`)
  }
}

async function previousDays(db: Db, range: { start: string; end: string }) {
  const rows: Array<{ campaign_id: string; date: string }> = []
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const { data, error } = await db.from('google_ads_campaign_daily').select('campaign_id,date')
      .eq('customer_id', GOOGLE_ADS_CUSTOMER_ID).gte('date', range.start).lte('date', range.end)
      .order('date').order('campaign_id').range(offset, offset + BATCH_SIZE - 1)
    if (error) throw new SyncError('Could not read the previous Google Ads reporting window.')
    rows.push(...(data ?? []))
    if (!data || data.length < BATCH_SIZE) return rows
  }
}

/** Company-wide campaign data; no credentials or user ownership on reporting rows.
 * All API requests are read-only search queries. A cursor advances only when
 * metadata, totals and conversion breakdowns have all been saved successfully. */
export async function runGoogleAdsSync(now = new Date()): Promise<GoogleAdsSyncResult> {
  const db = createServiceClient()
  const customerId = GOOGLE_ADS_CUSTOMER_ID
  const startedAt = now.toISOString()
  const result: GoogleAdsSyncResult = { ok: false, customerId, isBackfill: true, skipped: false,
    dateRange: { start: '', end: '' }, dailyRows: 0, conversionResultRows: 0, campaigns: [], conversionActions: [], errors: [] }
  let stateId: string | null = null
  try {
    const state = await readState(db)
    result.isBackfill = !state?.last_success_at
    if (state?.status === 'syncing' && state.last_attempt_at && now.getTime() - Date.parse(state.last_attempt_at) < LEASE_MS) {
      return { ...result, ok: true, skipped: true }
    }
    stateId = await claimState(db, state, startedAt)
    if (!stateId) return { ...result, ok: true, skipped: true }
    const userId = await credentialOwner(db)
    const probe = await probeGoogleAds(userId)
    if (!probe.ok) throw new SyncError(probe.error)
    if (!probe.customerIds.includes(customerId)) throw new SyncError('The configured Google Ads account is unavailable to the connected administrator.')
    const client = await getGoogleOAuth2Client(userId)
    if (!client) throw new SyncError('The Google Ads OAuth connection is unavailable.')
    const search = <T>(query: string, id = customerId) => searchGoogleAds<T>(client, id, query)
    const customerRows = await search<{ customer: AdsCustomer }>('SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer')
    const customer = customerRows[0]?.customer
    if (!customer || customer.id !== customerId || !customer.currencyCode || !customer.timeZone) throw new SyncError('Google Ads returned incomplete account metadata.')
    if (customer.manager) throw new SyncError('Campaign reporting requires an advertiser account; the configured customer is a manager account.')
    const range = adsDateRange(now, customer.timeZone, result.isBackfill)
    result.dateRange = range
    const conversionCustomer = customer.conversionTrackingSetting?.googleAdsConversionCustomer
    const conversionCustomerId = conversionCustomer?.match(/^customers\/(\d{10})$/)?.[1] ?? null
    const campaignRows = await search<{ campaign: AdsCampaign }>("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')")
    const actionRows = await search<{ conversionAction: AdsConversionAction }>('SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal FROM conversion_action', conversionCustomerId ?? customerId)
    const goalRows = await search<{ campaignConversionGoal: Goal }>('SELECT campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal')
    const configRows = await search<{ conversionGoalCampaignConfig: GoalConfig }>('SELECT conversion_goal_campaign_config.campaign, conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal FROM conversion_goal_campaign_config')
    const customGoals = configRows.some(row => row.conversionGoalCampaignConfig.customConversionGoal)
      ? await search<{ customConversionGoal: CustomGoal }>('SELECT custom_conversion_goal.resource_name, custom_conversion_goal.name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions FROM custom_conversion_goal', conversionCustomerId ?? customerId) : []
    const period = `segments.date BETWEEN '${range.start}' AND '${range.end}'`
    const totals = await search<AdsMetricRow>(`SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE ${period} AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')`)
    // Cost/clicks are incompatible with conversion-action segmentation. Query
    // conversion metrics separately and attach them to the single daily total.
    const conversions = await search<AdsMetricRow>(`SELECT campaign.id, segments.date, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE ${period} AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')`)
    const daily = buildAdsDailyRows(customerId, totals, conversions, await previousDays(db, range), range, startedAt)
    const campaigns = campaignRows.map(row => row.campaign)
    const actions = actionRows.map(row => row.conversionAction)
    await upsertRows(db, 'google_ads_accounts', [{ customer_id: customerId, name: customer.descriptiveName ?? null,
      currency_code: customer.currencyCode, time_zone: customer.timeZone, conversion_customer_id: conversionCustomerId, synced_at: startedAt }], 'customer_id')
    await upsertRows(db, 'google_ads_campaigns', campaigns.map(campaign => {
      const resource = `customers/${customerId}/campaigns/${campaign.id}`
      const config = configRows.find(row => row.conversionGoalCampaignConfig.campaign === resource)?.conversionGoalCampaignConfig
      const custom = customGoals.find(row => row.customConversionGoal.resourceName === config?.customConversionGoal)?.customConversionGoal
      return { customer_id: customerId, campaign_id: campaign.id, name: campaign.name, status: campaign.status,
        channel_type: campaign.advertisingChannelType, channel_sub_type: campaign.advertisingChannelSubType ?? null,
        bidding_strategy_type: campaign.biddingStrategyType ?? null, goal_config_level: config?.goalConfigLevel ?? null,
        conversion_goals: goalRows.filter(row => row.campaignConversionGoal.campaign === resource).map(({ campaignConversionGoal: goal }) => ({ category: goal.category, origin: goal.origin, biddable: goal.biddable ?? false })),
        custom_conversion_goal: custom ?? (config?.customConversionGoal ? { resourceName: config.customConversionGoal } : null), synced_at: startedAt }
    }), 'customer_id,campaign_id')
    await upsertRows(db, 'google_ads_conversion_actions', actions.map(action => ({ customer_id: customerId, resource_name: action.resourceName,
      action_id: action.id, name: action.name, status: action.status, type: action.type, category: action.category,
      origin: action.origin ?? null, primary_for_goal: action.primaryForGoal ?? false, synced_at: startedAt })), 'customer_id,resource_name')
    await upsertRows(db, 'google_ads_campaign_daily', daily, 'customer_id,campaign_id,date')
    await writeState(db, stateId, startedAt, { status: 'synced', cursor: range.end, last_success_at: new Date().toISOString(), last_error: null })
    return { ...result, ok: true, dailyRows: daily.length, conversionResultRows: conversions.length,
      campaigns: campaigns.map(c => ({ id: c.id, name: c.name, status: c.status, type: c.advertisingChannelType })),
      conversionActions: actions.map(a => ({ name: a.name, category: a.category, type: a.type, primaryForGoal: a.primaryForGoal ?? false })) }
  } catch (error) {
    const message = error instanceof SyncError || error instanceof GoogleAdsReportingError ? error.message : 'Google Ads sync could not complete.'
    result.errors.push(message)
    if (stateId) {
      try { await writeState(db, stateId, startedAt, { status: 'failed', last_error: message }) }
      catch { result.errors.push('Could not record the failed Google Ads sync attempt.') }
    }
    return result
  }
}
