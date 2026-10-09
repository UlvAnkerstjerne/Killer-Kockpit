import { dataText } from '@/lib/marketing/paid-strategy/evidence'
import type { CompileInput, SyncedAdSet, SyncedCampaign } from '@/lib/marketing/paid-strategy/implementation/compile'
import { prodCapabilities } from './fake-meta'
import { IDS, rec } from './paid-strategy'

export const ACCOUNT = 'act_7001'
export const NOW = new Date('2026-10-09T08:00:00Z') // 23 days left in October including today

export const campaigns: SyncedCampaign[] = [
  { id: IDS.c1, name: 'Copenhagen Brand - Always On (V2)', status: 'ACTIVE', ad_account_id: ACCOUNT, daily_budget: '10000', currency: 'DKK' },
  { id: IDS.c2, name: 'Killer Katering - Copenhagen Leads (V1)', status: 'ACTIVE', ad_account_id: ACCOUNT, daily_budget: '10000', currency: 'DKK' },
  { id: IDS.c3, name: 'Malmö Brand - Foodies Always On (V2)', status: 'ACTIVE', ad_account_id: ACCOUNT, daily_budget: null, currency: 'DKK' },
  { id: IDS.c4, name: 'Other account campaign', status: 'ACTIVE', ad_account_id: 'act_9999', daily_budget: '10000', currency: 'DKK' },
]
export const adSets: SyncedAdSet[] = [
  { id: IDS.s1, campaign_id: IDS.c1, name: 'Copenhagen Broad - IG Reels', status: 'ACTIVE', daily_budget: '4000' },
  { id: IDS.s2, campaign_id: IDS.c2, name: 'Katering Leads - Greater Copenhagen Broad', status: 'ACTIVE', daily_budget: '8000' },
]
export const evidenceCampaigns = [
  { ref: 'C1', name: dataText(campaigns[0].name) }, { ref: 'C2', name: dataText(campaigns[1].name) }, { ref: 'C3', name: dataText(campaigns[2].name) },
]

// The three live production recommendations (text taken from the real run), used as the acceptance cases.
export const tracking = rec(1, {
  title: 'Add a measurable conversion event to the catering lead funnel before scaling spend', recommendation_type: 'tracking', incremental_budget_dkk: 0,
  hypothesis: 'If a downstream qualification signal is added (for example a CRM stage or a confirmed-booking event fed back to Meta via CAPI), the account can make spend decisions on business outcomes rather than raw form submissions.',
  exact_test_or_action: "Map the catering enquiry journey from form submission to confirmed booking. Implement a server-side CAPI event (e.g. 'CateringBookingConfirmed') or a CRM webhook that fires when a lead is marked qualified or won. Verify the event appears in Meta Events Manager before any budget change is considered. No incremental spend is required. Budget: 0 DKK.",
  success_metric: "A verified CAPI event for a downstream catering action appears in Events Manager within the next 14 days of C2 running.",
})
export const creative = rec(2, {
  title: 'Test a direct-response offer creative in the catering lead campaign to improve lead volume', recommendation_type: 'creative', incremental_budget_dkk: 0,
  hypothesis: 'A second creative concept using an explicit offer hook will generate a higher lead rate per click than the current carousel within a 14-day test window.',
  exact_test_or_action: 'Within C2, introduce one new ad alongside the existing one using a different concept angle: a single static with an offer-first hook. Run both ads simultaneously for 14 days. Do not increase the ad set daily budget. Budget: 0 DKK incremental.',
  success_metric: "The new ad's click-to-lead rate over 14 days is higher than the existing ad's.",
})
export const newCampaign = rec(3, {
  title: 'Launch a Malmö catering leads campaign mirroring C2 structure to test market demand', recommendation_type: 'campaign_structure', incremental_budget_dkk: 2100,
  hypothesis: 'A new Malmö catering leads campaign using the same creative and form structure as C2 will generate at least one verified lead within 21 days.',
  exact_test_or_action: 'Create a new leads-objective campaign targeting the Malmö metro area, mirroring the S3 broad targeting logic. Set a daily budget of 100 DKK and run for 21 days, spending at most 2,100 DKK incremental.',
  success_metric: 'At least 1 verified lead event for the new Malmö campaign within 21 days.',
})
export const budget = rec(4, { title: 'Reduce spend on the always-on awareness campaign', recommendation_type: 'budget', incremental_budget_dkk: 0, exact_test_or_action: 'Lower the daily budget on C1 to free headroom for the catering test.' })

export function compileInput(over: Partial<CompileInput> = {}): CompileInput {
  return {
    recommendation: tracking, runGeneratedAt: '2026-10-08T10:01:00Z', evidenceCampaigns,
    projectedHeadroomDkk: 8800, headroomReliable: true, reservedByOthersDkk: 0,
    campaigns, adSets, configuredMetaAdAccountId: ACCOUNT, capabilities: prodCapabilities(), inputs: {}, now: NOW, ...over,
  }
}
