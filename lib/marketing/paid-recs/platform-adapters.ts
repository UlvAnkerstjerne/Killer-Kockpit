import 'server-only'
import { fetchMetaAdSetState, fetchMetaAdState, fetchMetaCampaignState, updateMetaAdSetBudget, updateMetaAdSetStatus, updateMetaAdStatus, updateMetaCampaignBudget, updateMetaCampaignStatus } from '@/lib/meta/client'
import { searchGoogleAds, updateGoogleCampaignBudget, updateGoogleCampaignStatus } from '@/lib/google/ads-client'
import type { getGoogleOAuth2Client } from '@/lib/google/auth'
import type { PaidMutationAdapter } from './executor'

type OAuthClient = NonNullable<Awaited<ReturnType<typeof getGoogleOAuth2Client>>>

export function metaMutationAdapter(currency: string): PaidMutationAdapter {
  return {
    async read(plan) {
      if (plan.platform !== 'meta' || !('target_id' in plan) || !('ad_account_id' in plan)) throw new Error('Wrong adapter')
      if (plan.target_type === 'ad') {
        const row = await fetchMetaAdState(plan.target_id)
        return { platform: 'meta', accountId: plan.ad_account_id, status: row.status, currency }
      }
      if (plan.target_type === 'adset') {
        const row = await fetchMetaAdSetState(plan.target_id)
        return { platform: 'meta', accountId: plan.ad_account_id, status: row.status, dailyBudget: row.daily_budget ? Number(row.daily_budget) / 100 : undefined, currency }
      }
      const row = await fetchMetaCampaignState(plan.target_id)
      return { platform: 'meta', accountId: plan.ad_account_id, status: row.status, dailyBudget: row.daily_budget ? Number(row.daily_budget) / 100 : undefined, currency }
    },
    async mutate(plan) {
      if (plan.action_type === 'meta_pause_campaign') await updateMetaCampaignStatus(plan.target_id, 'PAUSED')
      else if (plan.action_type === 'meta_resume_campaign') await updateMetaCampaignStatus(plan.target_id, 'ACTIVE')
      else if (plan.action_type === 'meta_pause_ad') await updateMetaAdStatus(plan.target_id, 'PAUSED')
      else if (plan.action_type === 'meta_resume_ad') await updateMetaAdStatus(plan.target_id, 'ACTIVE')
      else if (plan.action_type === 'meta_pause_adset') await updateMetaAdSetStatus(plan.target_id, 'PAUSED')
      else if (plan.action_type === 'meta_resume_adset') await updateMetaAdSetStatus(plan.target_id, 'ACTIVE')
      else if (plan.action_type === 'meta_set_campaign_budget') await updateMetaCampaignBudget(plan.target_id, Math.round(plan.target_daily_budget * 100))
      else if (plan.action_type === 'meta_set_adset_budget') await updateMetaAdSetBudget(plan.target_id, Math.round(plan.target_daily_budget * 100))
      else throw new Error('Unsupported Meta mutation')
      return {}
    },
  }
}

export function googleMutationAdapter(client: OAuthClient, currency: string): PaidMutationAdapter {
  return {
    async read(plan) {
      if (plan.platform !== 'google' || !('customer_id' in plan)) throw new Error('Wrong adapter')
      const rows = await searchGoogleAds<{ campaign: { status: string; campaignBudget: string }; campaignBudget: { amountMicros: string; explicitlyShared: boolean } }>(client, plan.customer_id, `SELECT campaign.status, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${plan.campaign_id} LIMIT 1`)
      if (rows.length !== 1) throw new Error('Target not found')
      return { platform: 'google', accountId: plan.customer_id, status: rows[0].campaign.status, dailyBudget: Number(rows[0].campaignBudget.amountMicros) / 1_000_000, currency, sharedBudget: rows[0].campaignBudget.explicitlyShared }
    },
    async mutate(plan) {
      if (plan.action_type === 'google_pause_campaign') await updateGoogleCampaignStatus(client, plan.customer_id, plan.campaign_id, 'PAUSED')
      else if (plan.action_type === 'google_resume_campaign') await updateGoogleCampaignStatus(client, plan.customer_id, plan.campaign_id, 'ENABLED')
      else if (plan.action_type === 'google_set_campaign_budget') await updateGoogleCampaignBudget(client, plan.customer_id, plan.campaign_budget_resource_name, Math.round(plan.target_daily_budget * 1_000_000))
      else throw new Error('Unsupported Google mutation')
      return {}
    },
  }
}
