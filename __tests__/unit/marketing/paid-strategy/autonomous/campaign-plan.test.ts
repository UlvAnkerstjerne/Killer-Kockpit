import { describe, expect, it } from 'vitest'
import { COPENHAGEN_COPY, malmoTargeting, pausedAd, SRC, sourceAd, sourceAdSet, sourceCampaign } from '../../../../helpers/meta-source-config'
import { countryForMarket, geoFromExistingTargetings, geoFromSearch, localiseCopy, planCampaignClone, type PlanInput } from '@/lib/marketing/paid-strategy/autonomous/campaign-plan'

const geo = geoFromExistingTargetings('Malmö', [{ campaignName: 'Malmö Brand - Foodies Always On (V2)', targeting: malmoTargeting }, { campaignName: 'Copenhagen Brand - Always On (V2)', targeting: sourceAdSet().targeting }])
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  token: 'KK-ab12cd34', market: 'Malmö', sourceMarket: 'Copenhagen', sourceCampaignName: 'Killer Katering - Copenhagen Leads (V1)',
  configuredAccountId: SRC.act, sourceAccountId: SRC.act, currency: 'DKK',
  source: { campaign: sourceCampaign(), adSets: [sourceAdSet()], ads: [sourceAd(), pausedAd()] },
  geo, dailyBudgetDkk: 100, durationDays: 21, approvedIncrementalDkk: 2100, ...over,
})
const plan = (over: Partial<PlanInput> = {}) => planCampaignClone(input(over))
const blockers = (over: Partial<PlanInput> = {}) => { const r = plan(over); if (r.ok) throw new Error('expected blockers'); return r.blockers }

describe('Malmö clone of the real C2 structure', () => {
  it('compiles a complete, deterministic PAUSED-ready structure', () => {
    const r = plan(); expect(r.ok).toBe(true); if (!r.ok) return
    const p = r.plan
    expect(p.campaign).toMatchObject({ objective: 'OUTCOME_LEADS', buyingType: 'AUCTION', specialAdCategories: [], isAdsetBudgetSharingEnabled: false })
    expect(p.adSet).toMatchObject({ dailyBudgetMinor: 10000, optimizationGoal: 'OFFSITE_CONVERSIONS', billingEvent: 'IMPRESSIONS', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', destinationType: 'WEBSITE' })
    expect(p.adSet.promotedObject).toEqual({ pixel_id: '942936014341416', custom_event_type: 'LEAD', smart_pse_enabled: false })
    expect(p.adSet.attributionSpec).toEqual(sourceAdSet().attribution_spec)
    expect(p.dailyBudgetDkk * p.durationDays).toBe(2100); expect(p.totalBudgetDkk).toBe(2100)
  })
  it('keeps every source targeting setting but swaps the geography for the Malmö one the account already uses', () => {
    const r = plan(); if (!r.ok) throw new Error('x')
    const t = r.plan.adSet.targeting as Record<string, unknown>
    expect(t.geo_locations).toEqual(malmoTargeting.geo_locations)
    expect(JSON.stringify(t)).not.toContain('Copenhagen')
    expect(t).toMatchObject({ age_min: 18, age_max: 65, publisher_platforms: ['instagram'], instagram_positions: ['stream', 'profile_feed'], device_platforms: ['mobile', 'desktop'], targeting_automation: { advantage_audience: 0 } })
    expect(r.plan.geoOrigin).toContain('Malmö Brand - Foodies Always On (V2)')
  })
  it('reuses the source assets and destination, localises the copy, and leaves facts untouched', () => {
    const r = plan(); if (!r.ok) throw new Error('x')
    const link = (r.plan.creative.objectStorySpec as { link_data: { message: string; link: string; child_attachments: { image_hash: string }[] } }).link_data
    expect(link.child_attachments.map(c => c.image_hash)).toEqual((sourceAd().creative!.object_story_spec as { link_data: { child_attachments: { image_hash: string }[] } }).link_data.child_attachments.map((c: { image_hash: string }) => c.image_hash))
    expect(link.link).toBe('https://www.killerkebab.com/catering')
    expect(link.message).toContain('#Malmö'); expect(link.message).toContain('#malmöfood'); expect(link.message).toContain('#malmöeats')
    expect(link.message).not.toMatch(/copenhagen/i)
    for (const fact of ['149 DKK per person', 'Minimum 10 people', 'hello@killerkebab.com', 'five dishes']) expect(link.message).toContain(fact)
    expect(r.plan.creative.degreesOfFreedomSpec).toEqual(sourceAd().creative!.degrees_of_freedom_spec)
    expect(r.plan.review.reviewNotes.join(' ')).toContain('mentions of Copenhagen in the ad copy were changed to Malmö')
  })
  it('puts a reconciliation token in every object name, and copies from the paused duplicate nothing', () => {
    const r = plan(); if (!r.ok) throw new Error('x')
    for (const name of [r.plan.campaign.name, r.plan.adSet.name, r.plan.adName, r.plan.creative.name]) expect(name).toContain('[KK-ab12cd34]')
    expect(r.plan.source.adId).toBe(SRC.ad) // the active ad, not the paused one with no usable creative
    expect(r.plan.campaign.name).toContain('Malmö')
  })
  it('never schedules spend itself: no end or start time in the creation spec', () => {
    const r = plan(); if (!r.ok) throw new Error('x')
    expect(JSON.stringify(r.plan.adSet)).not.toMatch(/end_time|start_time|ACTIVE/)
  })
})

describe('what blocks cloning, exactly', () => {
  it('account ownership, currency and unconfigured account are refused before anything else', () => {
    expect(blockers({ sourceAccountId: 'act_9' })[0]).toMatchObject({ code: 'account_mismatch' })
    expect(blockers({ configuredAccountId: undefined })[0]).toMatchObject({ code: 'account_unconfigured', kind: 'access' })
    expect(blockers({ currency: 'EUR' })[0]).toMatchObject({ code: 'currency' })
  })
  it('unsupported shapes are named, not guessed', () => {
    expect(blockers({ source: { campaign: sourceCampaign({ objective: 'OUTCOME_SALES' }), adSets: [sourceAdSet()], ads: [sourceAd()] } }).map(b => b.code)).toContain('objective_unsupported')
    expect(blockers({ source: { campaign: sourceCampaign({ special_ad_categories: ['HOUSING'] }), adSets: [sourceAdSet()], ads: [sourceAd()] } }).map(b => b.code)).toContain('special_ad_category')
    expect(blockers({ source: { campaign: sourceCampaign({ daily_budget: '5000' }), adSets: [sourceAdSet()], ads: [sourceAd()] } }).map(b => b.code)).toContain('campaign_budget_unsupported')
    expect(blockers({ source: { campaign: sourceCampaign(), adSets: [sourceAdSet({ bid_strategy: 'COST_CAP' })], ads: [sourceAd()] } }).map(b => b.code)).toContain('bid_strategy')
    expect(blockers({ source: { campaign: sourceCampaign(), adSets: [sourceAdSet({ promoted_object: null })], ads: [sourceAd()] } }).map(b => b.code)).toContain('adset_incomplete')
  })
  it('ambiguity becomes a question, never a pick', () => {
    expect(blockers({ source: { campaign: sourceCampaign(), adSets: [sourceAdSet(), sourceAdSet({ id: '9' })], ads: [sourceAd()] } })[0]).toMatchObject({ kind: 'input', code: 'source_adset' })
    expect(blockers({ source: { campaign: sourceCampaign(), adSets: [sourceAdSet()], ads: [sourceAd(), { ...sourceAd(), id: '77' }] } }).map(b => b.code)).toContain('source_ad_ambiguous')
    expect(blockers({ source: { campaign: sourceCampaign(), adSets: [sourceAdSet()], ads: [pausedAd()] } }).map(b => b.code)).toContain('source_ad')
  })
  it('budget: a missing budget is asked for, and a plan above the approved amount is refused', () => {
    expect(blockers({ dailyBudgetDkk: null })[0]).toMatchObject({ kind: 'input', code: 'budget' })
    expect(blockers({ dailyBudgetDkk: 150, durationDays: 21 })[0]).toMatchObject({ code: 'budget_over_approval', message: expect.stringContaining('3150 DKK, above the 2100 DKK approved') })
    expect(plan({ dailyBudgetDkk: 100, durationDays: 21, approvedIncrementalDkk: 2100 }).ok).toBe(true)
    expect(plan({ approvedIncrementalDkk: 2099 }).ok).toBe(false)
  })
  it('an unresolved market geography is a question', () => {
    expect(blockers({ geo: { geo: null, origin: null } })[0]).toMatchObject({ kind: 'input', code: 'geo' })
  })
})

describe('geography resolution is server-side and deterministic', () => {
  it('uses an existing campaign\'s definition when exactly one distinct one exists, and asks when they disagree', () => {
    expect(geo.geo).toEqual(malmoTargeting.geo_locations)
    const other = { geo_locations: { cities: [{ key: '1', name: 'Malmö', radius: 40 }] } }
    const r = geoFromExistingTargetings('Malmö', [{ campaignName: 'Malmö A', targeting: malmoTargeting }, { campaignName: 'Malmö B', targeting: other }])
    expect(r.geo).toBeNull(); expect(r.blocker).toMatchObject({ kind: 'input', code: 'geo_ambiguous' })
    expect(geoFromExistingTargetings('Malmö', [{ campaignName: 'Copenhagen Brand', targeting: sourceAdSet().targeting }])).toMatchObject({ geo: null, blocker: null })
  })
  it('falls back to an exact city search match, and never to a fuzzy one', () => {
    const hit = geoFromSearch('Malmö', 'SE', [{ key: '77', name: 'Malmö', country_code: 'SE', type: 'city' }, { key: '78', name: 'Malmberget', country_code: 'SE', type: 'city' }])
    expect(hit.geo).toMatchObject({ cities: [{ key: '77', radius: 17, distance_unit: 'kilometer' }] })
    expect(geoFromSearch('Malmö', 'SE', [{ key: '78', name: 'Malmberget', country_code: 'SE', type: 'city' }]).blocker).toMatchObject({ code: 'geo_unresolved' })
    expect(geoFromSearch('Malmö', 'SE', [{ key: '1', name: 'Malmö', country_code: 'SE', type: 'city' }, { key: '2', name: 'Malmö', country_code: 'SE', type: 'city' }]).geo).toBeNull()
    expect(countryForMarket('Malmö')).toBe('SE'); expect(countryForMarket('Atlantis')).toBeNull()
  })
  it('localises case-correctly and counts what it changed', () => {
    expect(localiseCopy('#Copenhagen COPENHAGEN copenhagenfood', 'Copenhagen', 'Malmö')).toEqual({ text: '#Malmö MALMÖ malmöfood', changed: 3 })
    expect(localiseCopy(COPENHAGEN_COPY, 'Copenhagen', 'Malmö').changed).toBe(3)
    expect(localiseCopy('No city here', 'Copenhagen', 'Malmö')).toEqual({ text: 'No city here', changed: 0 })
  })
})
