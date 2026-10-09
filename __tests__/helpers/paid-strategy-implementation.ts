import { dataText } from '@/lib/marketing/paid-strategy/evidence'
import type { CompileInput, SyncedAdSet, SyncedCampaign } from '@/lib/marketing/paid-strategy/implementation/compile'
import { IDS, rec } from './paid-strategy'

export const ACCOUNT = 'act_7001'
export const NOW = new Date('2026-10-09T08:00:00Z') // 23 days left in October including today

export const campaigns: SyncedCampaign[] = [
  { id: IDS.c1, name: 'Copenhagen Brand - Always On (V2)', status: 'ACTIVE', ad_account_id: ACCOUNT, daily_budget: '10000', currency: 'DKK' },
  { id: IDS.c2, name: 'Killer Katering - Copenhagen Leads (V1)', status: 'ACTIVE', ad_account_id: ACCOUNT, daily_budget: '10000', currency: 'DKK' },
  { id: IDS.c3, name: 'ZZ Old archive', status: 'PAUSED', ad_account_id: ACCOUNT, daily_budget: '5000', currency: 'DKK' },
  { id: IDS.c4, name: 'Other account campaign', status: 'ACTIVE', ad_account_id: 'act_9999', daily_budget: '10000', currency: 'DKK' },
]
export const adSets: SyncedAdSet[] = [
  { id: IDS.s1, campaign_id: IDS.c1, name: 'Copenhagen Broad - IG Reels', status: 'ACTIVE', daily_budget: '4000' },
  { id: IDS.s2, campaign_id: IDS.c2, name: 'Katering Leads - Greater Copenhagen Broad', status: 'ACTIVE', daily_budget: null },
]
export const evidenceCampaigns = [
  { ref: 'C1', name: dataText(campaigns[0].name) }, { ref: 'C2', name: dataText(campaigns[1].name) }, { ref: 'C3', name: dataText(campaigns[2].name) },
]

/** The three production recommendations this feature was designed around. */
export const tracking = rec(1, {
  title: 'Add a measurable conversion event to the catering lead funnel', recommendation_type: 'tracking', incremental_budget_dkk: 0,
  exact_test_or_action: 'Add a downstream catering qualification/booking conversion signal so Meta lead submissions can be distinguished from qualified/closed bookings, then verify the new event reaches Kockpit.',
  success_metric: 'Qualified and closed catering bookings are reported against C2 for 14 days.',
})
export const creative = rec(2, {
  title: 'Test a direct-response offer creative in the catering lead campaign', recommendation_type: 'creative', incremental_budget_dkk: 0,
  exact_test_or_action: 'Run one direct-response offer creative against the current creative in C2, same audience and budget, for 14 days.',
})
export const newCampaign = rec(3, {
  title: 'Launch a Malmö catering leads campaign mirroring C2 structure', recommendation_type: 'campaign_structure', incremental_budget_dkk: 2000,
  exact_test_or_action: 'Create a Malmö catering lead campaign that mirrors the C2 structure, with a maximum incremental budget of 2,000 DKK for the test.',
})
export const budget = rec(4, { title: 'Reduce spend on the always-on awareness campaign', recommendation_type: 'budget', incremental_budget_dkk: 0, exact_test_or_action: 'Lower the daily budget on C1 to free headroom for the catering test.' })

export function compileInput(over: Partial<CompileInput> = {}): CompileInput {
  return {
    recommendation: tracking, runGeneratedAt: '2026-10-08T10:01:00Z', evidenceCampaigns,
    projectedHeadroomDkk: 8800, headroomReliable: true, reservedByOthersDkk: 0,
    campaigns, adSets, configuredMetaAdAccountId: ACCOUNT, inputs: {}, now: NOW, ...over,
  }
}
