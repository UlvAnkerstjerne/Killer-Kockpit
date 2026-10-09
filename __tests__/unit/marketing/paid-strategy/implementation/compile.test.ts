import { describe, expect, it } from 'vitest'
import { IDS } from '../../../../helpers/paid-strategy'
import { ACCOUNT, adSets, budget, campaigns, compileInput, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import { compileImplementation, MODE_BY_TYPE, referencedCampaigns, toMajor } from '@/lib/marketing/paid-strategy/implementation/compile'
import { PaidStrategyRecommendationSchema, RECOMMENDATION_TYPES } from '@/lib/marketing/paid-strategy/types'

const compile = (over = {}, index = 0) => compileImplementation(compileInput(over), index)

describe('every recommendation resolves to an implementation state', () => {
  it('maps each of the eight strategy types to exactly one mode', () => {
    for (const type of RECOMMENDATION_TYPES) expect(MODE_BY_TYPE[type], type).toBeTruthy()
    expect(MODE_BY_TYPE).toMatchObject({ tracking: 'implementation_task', funnel: 'implementation_task', creative: 'creative_task', copy: 'creative_task',
      campaign_structure: 'implementation_package', retargeting: 'implementation_package', audience: 'implementation_package', budget: 'platform_action' })
  })
  it('compiles something for every type without throwing, never claiming an unchanged Meta', () => {
    for (const type of RECOMMENDATION_TYPES) {
      const out = compile({ recommendation: { ...tracking, recommendation_type: type, incremental_budget_dkk: 0 } })
      expect(['platform_action', 'implementation_task', 'creative_task', 'implementation_package', 'needs_input']).toContain(out.mode)
      expect(out.changesMeta).toBe(false)
    }
  })
})

describe('the three current production recommendations', () => {
  it('tracking -> IMPLEMENTATION TASK: implementation-ready, not "Investigate", and no Meta change', () => {
    const out = compile({ recommendation: tracking })
    expect(out.mode).toBe('implementation_task')
    expect(out.changesMeta).toBe(false)
    expect(out.task!.title).toBe('Implement: Add a measurable conversion event to the catering lead funnel')
    expect(out.task!.title).not.toMatch(/^investigate/i)
    for (const part of ['Implementation action:', 'qualification/booking conversion signal', 'Done means:', 'Success condition:', 'Qualified and closed catering bookings', 'Known limitation:', 'Why it matters:', 'Source: Paid Strategy', 'recommendation 1 of the run'])
      expect(out.task!.description, part).toContain(part)
    expect(out.willNot).toContain('This will not change Meta, Google or any ad account.')
    expect(out.willNot.join(' ')).toContain('Extra paid-media budget: 0 DKK.')
  })
  it('creative -> CREATIVE / COPY TASK for Killer Kreative with objective, angle, constraints and constants', () => {
    const out = compile({ recommendation: creative }, 1)
    expect(out.mode).toBe('creative_task')
    expect(out.task!.title.startsWith('Killer Kreative: ')).toBe(true)
    for (const part of ['Creative objective:', 'Exact angle or test:', 'Campaign and context:', 'C2 = Killer Katering - Copenhagen Leads (V1)', 'New spend needed:** none', 'Constraints:', 'approved by a person before anything is published', 'Keep constant so the test is readable:', 'Success condition:'])
      expect(out.task!.description, part).toContain(part)
    expect(out.willNot.join(' ')).toContain('No ad is created or published')
    expect(out.cannotAutomate.join(' ')).toContain('cannot produce or publish creative')
  })
  it('new campaign -> IMPLEMENTATION PACKAGE + task, never a Meta campaign', () => {
    const out = compile({ recommendation: newCampaign }, 2)
    expect(out.mode).toBe('implementation_package')
    expect(out.changesMeta).toBe(false)
    expect(out.platform).toBeNull()
    const pkg = out.package!
    expect(pkg).toMatchObject({ version: 'v1', kind: 'new_campaign', market: 'Malmö', maximum_incremental_budget_dkk: 2000, source_campaign_to_mirror: { id: IDS.c2, name: 'Killer Katering - Copenhagen Leads (V1)' } })
    expect(pkg.not_done_by_kockpit.join(' ')).toContain('does not create the campaign, ad set, ad or creative in Meta')
    expect(pkg.must_still_be_confirmed.join(' ')).toContain('Lead form or landing page')
    expect(pkg.must_still_be_confirmed.join(' ')).not.toContain('Target location')
    expect(out.task!.title.startsWith('Launch package: ')).toBe(true)
    expect(out.task!.description).toContain('Maximum incremental budget reserved:** 2,000 DKK')
    expect(out.willNot).toContain('No Meta campaign, ad set, ad or creative will be created in this version.')
  })
  it('asks for the market when none can be read, and accepts it as an input', () => {
    const rec = { ...newCampaign, title: 'Launch a new catering leads campaign', exact_test_or_action: 'Create a catering lead campaign mirroring C2.' }
    expect(compile({ recommendation: rec }).package!.must_still_be_confirmed).toContain('Target location or radius')
    const withLocation = compile({ recommendation: rec, inputs: { package: { location: 'Lund' } } }).package!
    expect(withLocation.market).toBe('Lund')
    expect(withLocation.must_still_be_confirmed).not.toContain('Target location or radius')
  })
  it('does not guess which campaign to mirror when the advice names several', () => {
    const rec = { ...newCampaign, exact_test_or_action: 'Mirror C2 but borrow the audience from C1.' }
    expect(compile({ recommendation: rec }).package!.source_campaign_to_mirror).toBeNull()
  })
})

describe('no AI-supplied platform IDs', () => {
  it('the strategy schema still has no ID, payload or execution field', () => {
    expect(Object.keys(PaidStrategyRecommendationSchema.shape).sort()).toEqual(['evidence', 'evidence_limitations', 'exact_test_or_action', 'hypothesis', 'incremental_budget_dkk', 'interpretation', 'recommendation_type', 'success_metric', 'title'])
  })
  it('an ID written into the advice text is never used as a target', () => {
    const sneaky = { ...budget, exact_test_or_action: `Pause campaign ${IDS.c1} on account ${ACCOUNT} now.` }
    const out = compile({ recommendation: sneaky })
    expect(out.platform).toBeNull()
    expect(out.mode).toBe('needs_input')
    expect(JSON.stringify(out)).not.toContain(IDS.c1)
  })
  it('local C-refs resolve only through the stored evidence name and a unique synced match', () => {
    const rec = { ...creative, exact_test_or_action: 'Test against C2 and C9.' }
    expect(referencedCampaigns(rec, compileInput().evidenceCampaigns, campaigns).map(r => r.ref)).toEqual(['C2'])
    const dup = [...campaigns, { ...campaigns[1], id: '999' }]
    expect(referencedCampaigns(rec, compileInput().evidenceCampaigns, dup)).toEqual([])
  })
})

describe('SAFE PLATFORM ACTION reuses the trusted compiler', () => {
  const pick = (platform: object) => compile({ recommendation: budget, inputs: { platform } as never })
  it('is NEEDS INPUT until a person chooses an existing target and an action', () => {
    const out = compile({ recommendation: budget })
    expect(out.mode).toBe('needs_input')
    expect(out.missing.map(m => m.key)).toEqual(['platform_target', 'platform_action'])
    expect(out.willDo).toEqual([])
    expect(out.willNot).toContain('Nothing has been changed in Meta.')
  })
  it('compiles a within-guardrail budget change into the existing execution-plan schema, converting minor units', () => {
    expect(toMajor('10000')).toBe(100)
    const out = pick({ action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 80 })
    expect(out.mode).toBe('platform_action')
    expect(out.changesMeta).toBe(true)
    expect(out.platform!.plan).toMatchObject({ action_type: 'meta_set_campaign_budget', target_id: IDS.c1, ad_account_id: ACCOUNT, currency: 'DKK', current_daily_budget: 100, target_daily_budget: 80 })
    expect(out.headline).toContain('from 100 DKK per day to 80 DKK per day')
    expect(out.platform!.incrementalDkk).toBe(0)
    expect(out.willDo.join(' ')).toContain('Read the result back from Meta and record before and after')
    expect(out.willNot.join(' ')).toContain('above 20% are refused')
  })
  it('keeps the 20% guardrail: a 30% change is refused and nothing is compiled', () => {
    const out = pick({ action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 70 })
    expect(out.mode).toBe('needs_input')
    expect(out.platform).toBeNull()
    expect(out.headline).toMatch(/exceeds the 20% automation limit/)
  })
  it('keeps account ownership: a campaign on another ad account is refused', () => {
    const out = pick({ action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c4 })
    expect(out.platform).toBeNull()
    expect(out.headline).toMatch(/does not belong to the configured Meta ad account/)
  })
  it('refuses when the ad account is not configured (cannot verify ownership)', () => {
    const out = compile({ recommendation: budget, configuredMetaAdAccountId: undefined, inputs: { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c1 } } })
    expect(out.platform).toBeNull()
    expect(out.headline).toMatch(/not configured/)
  })
  it('refuses unknown targets, wrong current status, ad-set pauses and non-DKK accounts', () => {
    expect(pick({ action: 'pause_campaign', targetType: 'campaign', targetId: '12345' }).headline).toMatch(/not in the synced Meta data/)
    expect(pick({ action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c3 }).headline).toMatch(/not ACTIVE/)
    expect(pick({ action: 'resume_campaign', targetType: 'campaign', targetId: IDS.c1 }).headline).toMatch(/not PAUSED/)
    expect(pick({ action: 'pause_campaign', targetType: 'adset', targetId: IDS.s1 }).headline).toMatch(/Ad set and ad status changes are not supported/)
    const eur = campaigns.map(c => ({ ...c, currency: 'EUR' }))
    expect(compile({ recommendation: budget, campaigns: eur, inputs: { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c1 } } }).headline).toMatch(/not DKK/)
  })
  it('supports an ad-set budget through the same compiler', () => {
    const out = pick({ action: 'set_daily_budget', targetType: 'adset', targetId: IDS.s1, targetDailyBudget: 45 })
    expect(out.platform!.plan).toMatchObject({ action_type: 'meta_set_adset_budget', target_id: IDS.s1, campaign_id: IDS.c1, current_daily_budget: 40, target_daily_budget: 45 })
    expect(adSets.length).toBeGreaterThan(0)
  })
  it('reserves the month-end cost of an increase, and of resuming a paused campaign', () => {
    const up = pick({ action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 110 })
    expect(up.platform!.incrementalDkk).toBe(230) // +10 DKK/day x 23 remaining days
    const resume = pick({ action: 'resume_campaign', targetType: 'campaign', targetId: IDS.c3 })
    expect(resume.platform!.incrementalDkk).toBe(1150) // 50 DKK/day x 23
  })
})

describe('shared budget headroom', () => {
  it('lets an approver lower the proposed budget but never raise it', () => {
    expect(compile({ recommendation: newCampaign, inputs: { reserveBudgetDkk: 500 } }).budget.requestedDkk).toBe(500)
    expect(compile({ recommendation: newCampaign, inputs: { reserveBudgetDkk: 9000 } }).budget.requestedDkk).toBe(2000)
  })
  it('subtracts budget already reserved by other approved work', () => {
    const out = compile({ recommendation: newCampaign, reservedByOthersDkk: 7000 })
    expect(out.budget.availableDkk).toBe(1800)
    expect(out.mode).toBe('needs_input')
    expect(out.intendedMode).toBe('implementation_package')
    expect(out.missing[0].detail).toContain('Only 1,800 DKK of the shared headroom is still available (7,000 DKK is already reserved')
  })
  it('allows a reduced amount to go ahead once it fits', () => {
    const out = compile({ recommendation: newCampaign, reservedByOthersDkk: 7000, inputs: { reserveBudgetDkk: 1800 } })
    expect(out.mode).toBe('implementation_package')
    expect(out.package!.maximum_incremental_budget_dkk).toBe(1800)
  })
  it('refuses any incremental budget when headroom is null or unreliable, but allows a 0 DKK start', () => {
    for (const over of [{ projectedHeadroomDkk: null }, { headroomReliable: false }]) {
      const out = compile({ recommendation: newCampaign, ...over })
      expect(out.mode).toBe('needs_input')
      expect(out.missing[0].detail).toContain('no reliable spend headroom')
      expect(compile({ recommendation: newCampaign, ...over, inputs: { reserveBudgetDkk: 0 } }).mode).toBe('implementation_package')
    }
  })
  it('a recommendation that needs no extra budget never depends on headroom', () => {
    expect(compile({ recommendation: tracking, projectedHeadroomDkk: null, headroomReliable: false }).mode).toBe('implementation_task')
  })
})
