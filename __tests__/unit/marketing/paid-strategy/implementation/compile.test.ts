import { describe, expect, it } from 'vitest'
import { IDS } from '../../../../helpers/paid-strategy'
import { ACCOUNT, budget, campaigns, compileInput, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import { PROD_ENV, prodCapabilities } from '../../../../helpers/fake-meta'
import { compileImplementation, detectMarket, MODE_BY_TYPE, parseSpendPlan, referencedCampaigns, toMajor } from '@/lib/marketing/paid-strategy/implementation/compile'
import { PaidStrategyRecommendationSchema, RECOMMENDATION_TYPES } from '@/lib/marketing/paid-strategy/types'

const compile = (over = {}, index = 0) => compileImplementation(compileInput(over), index)

describe('every recommendation resolves to an execution mode, never to a task', () => {
  it('maps each of the eight strategy types to exactly one mode', () => {
    for (const type of RECOMMENDATION_TYPES) expect(MODE_BY_TYPE[type], type).toBeTruthy()
    expect(MODE_BY_TYPE).toMatchObject({ tracking: 'tracking_execution', funnel: 'tracking_execution', creative: 'creative_execution', copy: 'creative_execution', campaign_structure: 'campaign_creation', retargeting: 'campaign_creation', audience: 'campaign_creation', budget: 'platform_action' })
  })
  it('there is no task or package field anywhere in a compiled implementation', () => {
    for (const type of RECOMMENDATION_TYPES) {
      const out = compile({ recommendation: { ...tracking, recommendation_type: type, incremental_budget_dkk: 0 } })
      expect(Object.keys(out)).not.toEqual(expect.arrayContaining(['task'])); expect(Object.keys(out)).not.toEqual(expect.arrayContaining(['package']))
      expect(JSON.stringify(out.willDo)).not.toMatch(/\btask\b/i)
    }
  })
})

describe('the three live production recommendations', () => {
  it('tracking -> Kockpit investigates and implements; today it expects to stop at the exact missing access', () => {
    const out = compile({ recommendation: tracking })
    expect(out.mode).toBe('tracking_execution'); expect(out.changesMeta).toBe(false)
    expect(out.expectedBlockers.map(b => b.code)).toEqual(['lead_source_missing', 'enquiry_contact_unreadable'])
    expect(out.headline).toContain('Kockpit will investigate your live tracking now')
    expect(out.willDo.join(' ')).toMatch(/Inspect the live website/); expect(out.willDo.join(' ')).toMatch(/Implement the downstream conversion event itself/); expect(out.willDo.join(' ')).toMatch(/Verify the event reaches Meta/)
    expect(out.willNot).toContain('It will not create a task for work Kockpit can do.'); expect(out.willNot).toContain('It will not report this complete without a verified write.')
    expect(out.budget.requestedDkk).toBe(0); expect(out.peopleNeeded.join(' ')).toContain('Smallest unblock:')
  })
  it('creative -> Kockpit writes the creative and prepares a PAUSED ad in the existing ad set', () => {
    const out = compile({ recommendation: creative }, 1)
    expect(out.mode).toBe('creative_execution'); expect(out.changesMeta).toBe(true)
    expect(out.referencedCampaigns).toEqual([{ ref: 'C2', name: 'Killer Katering - Copenhagen Leads (V1)' }])
    expect(out.headline).toContain('prepare a paused ad in "Killer Katering - Copenhagen Leads (V1)"')
    for (const part of ['using only facts the existing ad already states', 'Reuse the existing images and destination', 'same ad set', 'create it PAUSED and read it back', 'test design', 'READY TO ACTIVATE']) expect(out.willDo.join(' '), part).toContain(part)
    expect(out.willNot.join(' ')).toContain('It will not publish or spend anything')
    expect(out.willNot.join(' ')).toContain('It will not invent an offer, price, guarantee or response time')
    expect(out.willNot.join(' ')).toContain('only for the filming')
    expect(out.budget.requestedDkk).toBe(0)
  })
  it('Malmö campaign -> Kockpit builds a paused clone of C2 and reserves the stated spend', () => {
    const out = compile({ recommendation: newCampaign }, 2)
    expect(out.mode).toBe('campaign_creation'); expect(out.changesMeta).toBe(true)
    expect(out.market).toBe('Malmö'); expect(out.spend).toEqual({ dailyBudgetDkk: 100, durationDays: 21, totalDkk: 2100 })
    expect(out.budget).toMatchObject({ requestedDkk: 2100, availableDkk: 8800 })
    expect(out.referencedCampaigns).toEqual([{ ref: 'C2', name: 'Killer Katering - Copenhagen Leads (V1)' }])
    expect(out.headline).toBe('Kockpit will build a paused Malmö copy of "Killer Katering - Copenhagen Leads (V1)": 100 DKK a day for 21 days (2,100 DKK at most).')
    for (const part of ['objective, optimisation, attribution, placements, targeting, ad copy and images', 'Malmö location, copy localised from Copenhagen', 'validate every request, then create the campaign, ad set, creative and ad, all PAUSED, and read each one back', 'Reserve 2,100 DKK', 'READY TO ACTIVATE']) expect(out.willDo.join(' '), part).toContain(part)
    expect(out.willNot).toEqual(expect.arrayContaining(['It will not activate or spend anything: everything is created paused.', 'It will not change the source campaign or any existing campaign.']))
    expect(out.willNot.join(' ')).toContain('It will not create a task')
    expect(out.expectedBlockers).toEqual([])
  })
})

describe('what stops a creation, stated before the person confirms', () => {
  const stopped = (over = {}) => compile({ recommendation: newCampaign, ...over })
  const codes = (over = {}) => stopped(over).expectedBlockers.map(b => b.code)
  it('missing creation capability is an access blocker, not a task', () => {
    const out = stopped({ capabilities: prodCapabilities(PROD_ENV, ['ads_read']) })
    expect(out.mode).toBe('needs_input'); expect(out.intendedMode).toBe('campaign_creation')
    expect(out.expectedBlockers.every(b => b.kind === 'access')).toBe(true); expect(codes({ capabilities: prodCapabilities(PROD_ENV, ['ads_read']) })).toContain('missing_meta_campaign_creation')
  })
  it('audiences and retargeting are named as not built, never turned into a task', () => {
    const out = compile({ recommendation: { ...newCampaign, recommendation_type: 'retargeting' } })
    expect(out.mode).toBe('needs_input'); expect(out.expectedBlockers.find(b => b.code === 'structure_unsupported')).toMatchObject({ kind: 'capability' })
  })
  it('ambiguity and impossibilities are questions or blockers', () => {
    expect(codes({ recommendation: { ...newCampaign, exact_test_or_action: 'Mirror C2 but copy the audience from C1 in Malmö, daily budget of 100 DKK for 21 days.' } })).toContain('source_unresolved')
    expect(codes({ recommendation: { ...newCampaign, title: 'Launch a new catering campaign mirroring C2', hypothesis: 'It will work.', exact_test_or_action: 'Mirror C2 with a daily budget of 100 DKK for 21 days.' } })).toContain('market_unresolved')
    expect(codes({ recommendation: { ...newCampaign, title: 'Launch a Copenhagen catering campaign mirroring C2', exact_test_or_action: 'Mirror C2 in Copenhagen, daily budget of 100 DKK for 21 days.', hypothesis: 'x leads' } })).toContain('same_market')
    expect(codes({ configuredMetaAdAccountId: undefined })).toContain('account_unconfigured')
    expect(codes({ campaigns: campaigns.map(c => c.id === IDS.c2 ? { ...c, ad_account_id: 'act_9999' } : c) })).toContain('account_mismatch')
  })
  it('a plan above the strategy\'s own proposal is refused, and a missing budget is asked for', () => {
    expect(codes({ recommendation: { ...newCampaign, incremental_budget_dkk: 2000 } })).toContain('budget_over_approval')
    const noBudget = compile({ recommendation: { ...newCampaign, exact_test_or_action: 'Create a new leads campaign in Malmö mirroring C2.' } })
    expect(noBudget.mode).toBe('needs_input'); expect(noBudget.missing.map(m => m.key)).toEqual(['daily_budget', 'duration'])
    const supplied = compile({ recommendation: { ...newCampaign, exact_test_or_action: 'Create a new leads campaign in Malmö mirroring C2.' }, inputs: { campaign: { dailyBudgetDkk: 100, durationDays: 21 } } })
    expect(supplied.mode).toBe('campaign_creation'); expect(supplied.spend?.totalDkk).toBe(2100)
  })
  it('the 15,000 DKK ceiling and shared headroom: other approved work reduces what is available', () => {
    const out = stopped({ reservedByOthersDkk: 7000 })
    expect(out.budget.availableDkk).toBe(1800); expect(out.mode).toBe('needs_input')
    expect(out.missing[0]).toMatchObject({ key: 'reserve_budget', detail: expect.stringContaining('Only 1,800 DKK of the shared headroom is still available (7,000 DKK is already reserved') })
    for (const over of [{ projectedHeadroomDkk: null }, { headroomReliable: false }]) {
      const o = stopped(over); expect(o.mode).toBe('needs_input'); expect(o.missing[0].detail).toContain('no reliable spend headroom')
    }
    expect(compile({ recommendation: tracking, projectedHeadroomDkk: null, headroomReliable: false }).mode).toBe('tracking_execution') // zero budget never depends on headroom
  })
})

describe('server-side resolution, no AI platform ids', () => {
  it('the strategy schema still has no ID, payload or execution field', () => {
    expect(Object.keys(PaidStrategyRecommendationSchema.shape).sort()).toEqual(['display_summary', 'display_title', 'evidence', 'evidence_limitations', 'exact_test_or_action', 'hypothesis', 'incremental_budget_dkk', 'interpretation', 'recommendation_type', 'success_metric', 'title'])
  })
  it('an ID or account written into the advice is never used as a target', () => {
    const sneaky = { ...budget, exact_test_or_action: `Pause campaign ${IDS.c1} on account ${ACCOUNT} now.` }
    const out = compile({ recommendation: sneaky })
    expect(out.platform).toBeNull(); expect(out.mode).toBe('needs_input'); expect(JSON.stringify(out)).not.toContain(IDS.c1)
  })
  it('local C-refs resolve only through the stored evidence name and a unique synced match', () => {
    const rec = { ...creative, exact_test_or_action: 'Test against C2 and C9.' }
    expect(referencedCampaigns(rec, compileInput().evidenceCampaigns, campaigns).map(r => r.ref)).toEqual(['C2'])
    expect(referencedCampaigns(rec, compileInput().evidenceCampaigns, [...campaigns, { ...campaigns[1], id: '999' }])).toEqual([])
  })
  it('spend and market are read from the advice with strict patterns, and never guessed', () => {
    expect(parseSpendPlan('Set a daily budget of 100 DKK and run for 21 days')).toEqual({ dailyBudgetDkk: 100, durationDays: 21 })
    expect(parseSpendPlan('spend 150 DKK per day over 14 days')).toEqual({ dailyBudgetDkk: 150, durationDays: 14 })
    expect(parseSpendPlan('Launch something soon')).toEqual({ dailyBudgetDkk: null, durationDays: null })
    expect(detectMarket('a Malmö campaign')).toBe('Malmö'); expect(detectMarket('Malmöbrand')).toBeNull(); expect(detectMarket('nothing here')).toBeNull()
  })
})

describe('guardrailed changes to an existing object (unchanged, and budget units fixed)', () => {
  const pick = (platform: object) => compile({ recommendation: budget, inputs: { platform } as never })
  it('is NEEDS INPUT until a person chooses an existing target and an action', () => {
    const out = compile({ recommendation: budget })
    expect(out.mode).toBe('needs_input'); expect(out.missing.map(m => m.key)).toEqual(['platform_target', 'platform_action']); expect(out.willNot).toContain('Nothing has been changed in Meta.')
  })
  it('compiles a within-guardrail change into the existing plan schema, converting minor units to whole units', () => {
    expect(toMajor('10000')).toBe(100)
    const out = pick({ action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 80 })
    expect(out.mode).toBe('platform_action')
    expect(out.platform!.plan).toMatchObject({ action_type: 'meta_set_campaign_budget', target_id: IDS.c1, ad_account_id: ACCOUNT, currency: 'DKK', current_daily_budget: 100, target_daily_budget: 80 })
    expect(out.headline).toContain('from 100 DKK per day to 80 DKK per day')
  })
  it('keeps the 20% guardrail, account ownership, and refuses unknown or unsupported targets', () => {
    expect(pick({ action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 70 }).headline).toMatch(/exceeds the 20% automation limit/)
    expect(pick({ action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c4 }).headline).toMatch(/does not belong to the configured Meta ad account/)
    expect(pick({ action: 'pause_campaign', targetType: 'campaign', targetId: '12345' }).headline).toMatch(/not in the synced Meta data/)
    expect(pick({ action: 'pause_campaign', targetType: 'adset', targetId: IDS.s1 }).headline).toMatch(/Ad set and ad status changes are not supported/)
    expect(compile({ recommendation: budget, configuredMetaAdAccountId: undefined, inputs: { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c1 } } }).headline).toMatch(/not configured/)
  })
  it('reserves the month-end cost of an increase and of restarting a paused campaign', () => {
    expect(pick({ action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 110 }).platform!.incrementalDkk).toBe(230)
    const paused = campaigns.map(c => c.id === IDS.c1 ? { ...c, status: 'PAUSED' } : c)
    expect(compile({ recommendation: budget, campaigns: paused, inputs: { platform: { action: 'resume_campaign', targetType: 'campaign', targetId: IDS.c1 } } }).platform!.incrementalDkk).toBe(2300)
  })
})
