import { describe, expect, it } from 'vitest'
import { CURRENT, dates, IDS, NOW, PRIOR, strategyInputs } from '../../../helpers/paid-strategy'
import type { StrategyCampaign } from '@/lib/marketing/paid-strategy/evidence'
import { buildPaidStrategyEvidence, dataText, MAX_ADS, MAX_AD_SETS, MAX_CAMPAIGNS, MONTHLY_CEILING_DKK, strategyWindows } from '@/lib/marketing/paid-strategy/evidence'

describe('Paid Strategy evidence preparation', () => {
  it('uses the last 28 completed Copenhagen days and the 28 before them', () => {
    expect(strategyWindows(NOW)).toEqual({ today: '2026-10-08', current: CURRENT, prior: PRIOR })
    // 23:30 UTC on the 7th is already the 8th in Copenhagen.
    expect(strategyWindows(new Date('2026-10-07T23:30:00Z')).today).toBe('2026-10-08')
  })

  it('never sends platform IDs: campaigns, ad sets and ads get local refs', () => {
    const json = JSON.stringify(buildPaidStrategyEvidence(strategyInputs()))
    for (const id of Object.values(IDS)) expect(json).not.toContain(id)
    expect(json).not.toMatch(/\bact_\d{5,}/) // ad account ids; the hostile fixture name only contains the literal 'act_99'
    const e = buildPaidStrategyEvidence(strategyInputs())
    expect(e.campaigns.map(c => c.ref)).toEqual(['C1', 'C2', 'C3'])
    expect(e.ad_sets.map(s => s.ref)).toEqual(['S1', 'S2', 'S3'])
    expect(e.top_ads.map(a => a.ref)).toEqual(['A1', 'A2', 'A3'])
  })

  it('wraps every platform-controlled name as untrusted data, strips control characters and truncates', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    for (const item of [...e.campaigns, ...e.ad_sets, ...e.top_ads]) expect(item.name.startsWith('DATA:')).toBe(true)
    const hostile = e.campaigns.find(c => c.name.includes('Ignore all rules'))!
    expect(hostile.name).not.toMatch(/[\n\r\u0000-\u001f]/)
    expect(dataText('x'.repeat(500)).length).toBe('DATA:'.length + 80)
    expect(dataText(null)).toBe('DATA:')
  })

  it('excludes internal ZZ campaigns from every total and ranks campaigns by current spend', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    expect(e.campaigns.some(c => c.name.includes('ZZ'))).toBe(false)
    // C1 (100/day) and C2 (100/day) = 5,600 over 28 days. ZZ's 500/day is excluded.
    expect(e.budget.spend_current_28d).toBe(5600)
    expect(e.budget.spend_prior_28d).toBe(28 * (100 + 40 + 10))
    expect(e.campaigns[0].current_28d.spend).toBe(2800)
  })

  it('reports month-to-date spend as a fact next to the hard cap', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    expect(e.budget).toMatchObject({
      currency: 'DKK', monthly_ceiling: MONTHLY_CEILING_DKK, ceiling_is_hard_cap_not_target: true,
      month_to_date_spend: 7 * 200, month_days_elapsed: 7, month_days_total: 31,
    })
    expect(MONTHLY_CEILING_DKK).toBe(15000)
  })

  it('declares which calibration inputs are known and unknown instead of inventing them', () => {
    const { calibration } = buildPaidStrategyEvidence(strategyInputs())
    expect(calibration.known).toEqual({ monthly_ceiling_dkk: 15000, ceiling_is_hard_cap: true })
    expect(calibration.unknown).toEqual(expect.arrayContaining(['target_cpl', 'target_roas', 'gross_margin', 'lead_to_customer_rate']))
  })

  it('groups spend by objective across all eligible campaigns', () => {
    const { account } = buildPaidStrategyEvidence(strategyInputs())
    expect(account.spend_by_objective).toEqual([
      { objective: 'OUTCOME_AWARENESS', current_28d: 2800, prior_28d: 2800 },
      { objective: 'OUTCOME_LEADS', current_28d: 2800, prior_28d: 1120 },
      { objective: 'OUTCOME_TRAFFIC', current_28d: 0, prior_28d: 280 },
    ])
  })

  it('reports overlapping lead action names as one outcome, never summed', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    const leads = e.campaigns.find(c => c.objective === 'OUTCOME_LEADS')!
    // Fixture: `lead` and `offsite_conversion.fb_pixel_lead` are both 2/day = 56 over 28 days. That is 56 leads, not 112.
    expect(leads.current_28d.business_outcomes).toEqual([
      expect.objectContaining({ outcome: 'lead', count: 56, reported_as: [{ type: 'lead', count: 56 }, { type: 'offsite_conversion.fb_pixel_lead', count: 56 }] }),
    ])
    expect(leads.current_28d.top_actions).toEqual([{ type: 'link_click', count: 1680 }])
    expect(JSON.stringify(e)).not.toMatch(/"count":112\b/)
  })

  it('computes derived rates from stored counters', () => {
    const c1 = buildPaidStrategyEvidence(strategyInputs()).campaigns.find(c => c.objective === 'OUTCOME_AWARENESS')!
    expect(c1.current_28d).toMatchObject({ spend: 2800, impressions: 280000, link_clicks: 1400, link_ctr_pct: 0.5, cpm: 10, cost_per_link_click: 2, avg_daily_frequency: 1.5, days_with_spend: 28 })
    expect(c1).toMatchObject({ ad_sets_total: 1, ad_sets_active: 1, ads_active: 1, age_days: 68 })
  })

  it('lists ad sets and ads without inventing targeting or copy', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    expect(e.ad_sets.find(s => s.name.includes('Greater Copenhagen'))).toMatchObject({ campaign_ref: 'C2', status: 'ACTIVE' })
    expect(Object.keys(e.ad_sets[0]).sort()).toEqual(['campaign_ref', 'daily_budget', 'name', 'ref', 'status'])
    expect(Object.keys(e.top_ads[0]).sort()).toEqual(['ad_set_ref', 'campaign_ref', 'current_28d', 'name', 'prior_28d_spend', 'ref', 'status'])
    expect(e.data_gaps.join(' ')).toMatch(/targeting and audience definitions are not stored/i)
    expect(e.data_gaps.join(' ')).toMatch(/creative and ad copy text are not stored/i)
    expect(e.data_gaps.join(' ')).toMatch(/action types overlap/i)
  })

  it('bounds campaigns, ad sets, ads and total payload size', () => {
    const many = 40
    const campaigns = Array.from({ length: many }, (_, i) => ({ id: `9${String(i).padStart(14, '0')}`, name: `Campaign ${i} ${'n'.repeat(200)}`, status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC', daily_budget: '10', created_at_meta: null }))
    const adSets = campaigns.flatMap(c => [0, 1].map(k => ({ id: `${c.id}${k}`, campaign_id: c.id, name: `Set ${k}`, status: 'ACTIVE', daily_budget: null })))
    const ads = adSets.map(s => ({ id: `${s.id}9`, ad_set_id: s.id, name: 'Ad', status: 'ACTIVE' }))
    const campaignInsights = campaigns.flatMap((c, i) => dates(CURRENT.start, CURRENT.end).map(d => ({ campaign_id: c.id, date_start: d, impressions: 1000, clicks: 10, inline_link_clicks: 5, spend: String(10 + i), frequency: '1.1', actions_json: null })))
    const adInsights = ads.flatMap((a, i) => dates(CURRENT.start, CURRENT.end).map(d => ({ ad_id: a.id, date_start: d, impressions: 100, clicks: 1, inline_link_clicks: 1, spend: String(1 + i), actions_json: null })))
    const e = buildPaidStrategyEvidence(strategyInputs({ campaigns, adSets, ads, campaignInsights, adInsights }))
    expect(e.campaigns).toHaveLength(MAX_CAMPAIGNS)
    expect(e.ad_sets.length).toBeLessThanOrEqual(MAX_AD_SETS)
    expect(e.top_ads).toHaveLength(MAX_ADS)
    expect(JSON.stringify(e).length).toBeLessThan(60_000)
    expect(e.data_gaps.join(' ')).toContain('28 lower-spend campaigns are omitted')
    // Totals still include omitted campaigns.
    expect(e.budget.spend_current_28d).toBe(Math.round(campaigns.reduce((s, _c, i) => s + (10 + i) * 28, 0)))
  })

  it('copes with an empty account', () => {
    const e = buildPaidStrategyEvidence(strategyInputs({ campaigns: [], adSets: [], ads: [], campaignInsights: [], adInsights: [] }))
    expect(e.campaigns).toEqual([])
    expect(e.budget.spend_current_28d).toBe(0)
    expect(e.data_gaps.join(' ')).toContain('No ad-level delivery rows')
  })

  it('flags a non-DKK account instead of silently comparing to the DKK ceiling', () => {
    expect(buildPaidStrategyEvidence(strategyInputs({ currency: 'EUR' })).data_gaps.join(' ')).toContain('currency is EUR')
  })
})

// ── Budget projection ────────────────────────────────────────────────────────

const insightRow = (campaign_id: string, date_start: string, spend: number) =>
  ({ campaign_id, date_start, impressions: 1000, clicks: 10, inline_link_clicks: 5, spend: String(spend), frequency: '1.0', actions_json: null })
const week = (campaign_id: string, perDay: number, from = '2026-10-01', to = '2026-10-07') => dates(from, to).map(d => insightRow(campaign_id, d, perDay))
const campaign = (id: string, over: Partial<StrategyCampaign> = {}): StrategyCampaign =>
  ({ id, name: `Campaign ${id}`, status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: null, created_at_meta: null, ...over })
const adSet = (id: string, campaign_id: string, daily_budget: string | null, status = 'ACTIVE') => ({ id, campaign_id, name: `Set ${id}`, status, daily_budget })
const projectionOf = (over: Parameters<typeof strategyInputs>[0] = {}) => buildPaidStrategyEvidence(strategyInputs(over)).budget.projection

describe('Paid Strategy budget projection', () => {
  it('projects month-end spend from the recent run rate of active campaigns', () => {
    const p = projectionOf()
    expect(p).toMatchObject({
      reliable: true, unreliable_reasons: [], recent_daily_spend: 200, remaining_days_in_month_including_today: 24,
      assumed_daily_spend_for_existing_campaigns: 200, projected_remaining_existing_spend: 4800,
      projected_month_end_spend: 1400 + 4800, projected_incremental_headroom: 15000 - 6200,
    })
    expect(p.label).toMatch(/^PROJECTION, not a fact/)
  })

  it('removes the misleading month-to-date headroom that the first live run was given', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    expect(JSON.stringify(e)).not.toContain('ceiling_headroom_this_month')
    // Old logic: ceiling - month-to-date. New headroom must be strictly smaller whenever campaigns are still spending.
    expect(e.budget.projection.projected_incremental_headroom!).toBeLessThan(MONTHLY_CEILING_DKK - e.budget.month_to_date_spend)
  })

  it('reproduces the live numbers: ~2.7k of headroom, not the 12.3k the model was first told', () => {
    // Shape of the live account on 2026-10-08: 3 active campaigns, no campaign-level budget, ad-set budgets in minor units.
    const campaigns = [campaign('a'), campaign('b'), campaign('c')]
    const adSets = [adSet('a1', 'a', '25000.000000'), adSet('a2', 'a', '5000.000000', 'PAUSED'), adSet('b1', 'b', '5000.000000'), adSet('c1', 'c', '10000.000000')]
    const campaignInsights = [...week('a', 253.6), ...week('b', 49.9), ...week('c', 79.2)]
    const p = projectionOf({ campaigns, adSets, ads: [], adInsights: [], campaignInsights })
    const mtd = 7 * (253.6 + 49.9 + 79.2)
    expect(p.recent_daily_spend).toBeCloseTo(382.7, 1)
    expect(p.active_daily_budget_total).toBe(400)              // 250 + 50 + 100; the PAUSED 50 is excluded
    expect(p.active_daily_budget_used_as_upper_bound).toBe(true)
    expect(p.assumed_daily_spend_for_existing_campaigns).toBe(400)
    expect(p.projected_month_end_spend).toBeCloseTo(mtd + 400 * 24, 1)
    expect(p.projected_incremental_headroom).toBeCloseTo(15000 - (mtd + 9600), 0)
    expect(p.projected_incremental_headroom!).toBeLessThan(3000)
    // The three tests the model proposed first time (2,000 + 1,500 + 1,500) would not have fitted.
    expect(2000 + 1500 + 1500).toBeGreaterThan(p.projected_incremental_headroom!)
  })

  it('converts Meta minor-unit budgets to DKK in the evidence the model reads', () => {
    const e = buildPaidStrategyEvidence(strategyInputs({
      campaigns: [campaign('a', { daily_budget: '10000.000000' })], adSets: [adSet('a1', 'a', '25000.000000')],
      ads: [], adInsights: [], campaignInsights: week('a', 100),
    }))
    expect(e.campaigns[0].daily_budget).toBe(100)
    expect(e.ad_sets[0].daily_budget).toBe(250)
  })

  it('uses a campaign-level budget instead of double counting its ad sets', () => {
    const p = projectionOf({
      campaigns: [campaign('a', { daily_budget: '12000' })], adSets: [adSet('a1', 'a', '9000'), adSet('a2', 'a', '9000')],
      ads: [], adInsights: [], campaignInsights: week('a', 110),
    })
    expect(p.active_daily_budget_total).toBe(120)
  })

  it('ignores a budget that is not credible against actual spend (wrong units, stale budget)', () => {
    const p = projectionOf({
      campaigns: [campaign('a')], adSets: [adSet('a1', 'a', '10000000')], ads: [], adInsights: [], campaignInsights: week('a', 100),
    })
    expect(p.active_daily_budget_total).toBe(100000)
    expect(p.active_daily_budget_used_as_upper_bound).toBe(false)
    expect(p.assumed_daily_spend_for_existing_campaigns).toBe(100)
    expect(p.projected_incremental_headroom).toBe(15000 - (700 + 100 * 24))
  })

  it('keeps paused campaigns in month-to-date but out of the run rate', () => {
    const p = projectionOf({
      campaigns: [campaign('a'), campaign('p', { status: 'PAUSED' })], adSets: [], ads: [], adInsights: [],
      campaignInsights: [...week('a', 100), ...week('p', 300)],
    })
    expect(p.recent_daily_spend).toBe(100)
    expect(p.projected_month_end_spend).toBe(2800 + 100 * 24)
  })

  it('excludes internal ZZ campaigns', () => {
    const p = projectionOf({ campaigns: [campaign('a'), campaign('z', { name: 'ZZ archive' })], adSets: [], ads: [], adInsights: [], campaignInsights: [...week('a', 100), ...week('z', 900)] })
    expect(p.recent_daily_spend).toBe(100)
  })

  it('never produces negative headroom when existing spend already breaches the ceiling', () => {
    const p = projectionOf({ campaigns: [campaign('a')], adSets: [], ads: [], adInsights: [], campaignInsights: week('a', 900) })
    expect(p.projected_month_end_spend).toBeGreaterThan(MONTHLY_CEILING_DKK)
    expect(p.projected_incremental_headroom).toBe(0)
    expect(p.reliable).toBe(true)
  })

  it('withholds headroom entirely when the run rate is not representative', () => {
    const p = projectionOf({ campaigns: [campaign('a'), campaign('b')], adSets: [], ads: [], adInsights: [], campaignInsights: [...week('a', 100), ...week('b', 100, '2026-10-06', '2026-10-07')] })
    expect(p.reliable).toBe(false)
    expect(p.projected_incremental_headroom).toBeNull()
    expect(p.unreliable_reasons.join(' ')).toMatch(/fewer than 5 of the last 7 days/)
  })

  it('withholds headroom for a non-DKK account', () => {
    const p = projectionOf({ currency: 'EUR' })
    expect(p.reliable).toBe(false)
    expect(p.projected_incremental_headroom).toBeNull()
  })

  it('counts remaining days correctly at month boundaries', () => {
    const first = buildPaidStrategyEvidence(strategyInputs({ now: new Date('2026-10-01T10:00:00Z') })).budget
    expect(first).toMatchObject({ month_days_elapsed: 0, month_to_date_spend: 0 })
    expect(first.projection.remaining_days_in_month_including_today).toBe(31)
    const last = buildPaidStrategyEvidence(strategyInputs({ now: new Date('2026-10-31T10:00:00Z') })).budget
    expect(last.month_days_elapsed).toBe(30)
    expect(last.projection.remaining_days_in_month_including_today).toBe(1)
  })
})

// ── Business outcomes (regression: first live run lost 6 real leads behind engagement actions) ──

describe('Paid Strategy business outcomes survive the top-N action ranking', () => {
  // The exact C2 failure: 12 engagement/context action types outrank the lead events, which sit at rank 13.
  const engagement = [
    ['page_engagement', 404], ['post_engagement', 404], ['link_click', 295], ['post_interaction_net', 112], ['post_interaction_gross', 109],
    ['landing_page_view', 103], ['omni_landing_page_view', 103], ['post_reaction', 63], ['onsite_conversion.post_net_like', 62],
    ['onsite_conversion.post_save', 25], ['onsite_conversion.post_net_save', 23], ['post', 21],
  ] as const
  const leadAliases = [['offsite_conversion.fb_pixel_lead', 6], ['onsite_web_lead', 6], ['offsite_lead_add_20_s_calls', 6], ['lead', 6]] as const
  const actions = (pairs: readonly (readonly [string, number])[]) => pairs.map(([action_type, value]) => ({ action_type, value: String(value) }))

  /** 21 spending days totalling exactly 1,972.29 DKK, all actions recorded on the first day. */
  function c2(pairs: readonly (readonly [string, number])[]) {
    const days = dates('2026-09-17', '2026-10-07')
    const campaignInsights = days.map((d, i) => ({
      campaign_id: 'c2', date_start: d, impressions: 1000, clicks: 10, inline_link_clicks: 5, spend: i === 0 ? '92.29' : '94', frequency: '1.1',
      actions_json: i === 0 ? actions(pairs) : null,
    }))
    return buildPaidStrategyEvidence(strategyInputs({
      campaigns: [campaign('c2', { name: 'Killer Katering - Copenhagen Leads (V1)' })], adSets: [], ads: [], adInsights: [], campaignInsights,
    }))
  }

  it('keeps the 6 leads, once, although they rank below the top 8 actions', () => {
    const e = c2([...engagement, ...leadAliases])
    const w = e.campaigns[0].current_28d
    expect(w.spend).toBe(1972.29)
    expect(w.top_actions).toHaveLength(8)
    expect(w.top_actions.map(a => a.type)).not.toEqual(expect.arrayContaining(['lead']))
    expect(w.top_actions.map(a => a.type).join(' ')).not.toMatch(/lead/)
    expect(w.business_outcomes).toHaveLength(1)
    expect(w.business_outcomes[0]).toMatchObject({ outcome: 'lead', count: 6, small_sample: true })
  })

  it('does not double count the overlapping lead labels', () => {
    const e = c2([...engagement, ...leadAliases])
    const lead = e.campaigns[0].current_28d.business_outcomes[0]
    expect(lead.count).toBe(6)
    expect(lead.reported_as).toHaveLength(4)
    expect(lead.reported_as.every(a => a.count === 6)).toBe(true)
    expect(JSON.stringify(e)).not.toMatch(/"count":(12|18|24)\b/)
    expect(e.account.business_outcomes_current_28d).toEqual([expect.objectContaining({ outcome: 'lead', count: 6 })])
  })

  it('states the observed cost per lead (~329 DKK) and flags it as a small sample', () => {
    const lead = c2([...engagement, ...leadAliases]).campaigns[0].current_28d.business_outcomes[0]
    expect(lead.observed_cost_per_outcome).toBeCloseTo(328.72, 2)
    expect(lead.observed_cost_per_outcome).toBeGreaterThan(328)
    expect(lead.observed_cost_per_outcome).toBeLessThan(330)
    expect(lead.small_sample).toBe(true)
  })

  it('says plainly that outcomes carry no downstream value data', () => {
    const gaps = c2([...engagement, ...leadAliases]).data_gaps.join(' ')
    expect(gaps).toMatch(/no closed-order, revenue or customer-quality data/i)
    expect(gaps).toMatch(/business_outcomes/)
    expect(gaps).toMatch(/never truncated/)
  })

  it('prefers the canonical type, else the largest alias, when aliases disagree', () => {
    expect(c2([...engagement, ['lead', 6], ['offsite_conversion.fb_pixel_lead', 5]]).campaigns[0].current_28d.business_outcomes[0].count).toBe(6)
    expect(c2([...engagement, ['offsite_conversion.fb_pixel_lead', 5], ['onsite_web_lead', 6]]).campaigns[0].current_28d.business_outcomes[0].count).toBe(6)
  })

  it('keeps engagement context unchanged: top_actions still shows the highest-volume non-outcome types', () => {
    const w = c2([...engagement, ...leadAliases]).campaigns[0].current_28d
    expect(w.top_actions.map(a => a.type)).toEqual(['page_engagement', 'post_engagement', 'link_click', 'post_interaction_net', 'post_interaction_gross', 'landing_page_view', 'omni_landing_page_view', 'post_reaction'])
  })

  it('preserves other commercial outcomes however low their volume', () => {
    const w = c2([
      ...engagement, ['purchase', 2], ['omni_purchase', 2], ['offsite_conversion.fb_pixel_purchase', 2], ['complete_registration', 3], ['mobile_app_install', 4],
      ['initiate_checkout', 5], ['omni_add_to_cart', 7], ['onsite_conversion.messaging_conversation_started_7d', 1], ['voucher_redemption', 1],
      ['offsite_conversion.custom.123456789', 3],
    ]).campaigns[0].current_28d
    const byName = Object.fromEntries(w.business_outcomes.map(o => [o.outcome, o.count]))
    expect(byName).toEqual({
      purchase: 2, complete_registration: 3, app_install: 4, initiate_checkout: 5, add_to_cart: 7,
      messaging_conversation_started: 1, voucher_redemption: 1, 'custom_conversion:offsite_conversion.custom.123456789': 3,
    })
    expect(w.top_actions).toHaveLength(8)
  })

  it('does not mistake engagement or landing-page actions for business outcomes', () => {
    const w = c2([...engagement]).campaigns[0].current_28d
    expect(w.business_outcomes).toEqual([])
    expect(w.top_actions.map(a => a.type)).toContain('landing_page_view')
  })

  it('applies to ads and to the prior window too', () => {
    const base = strategyInputs()
    const e = buildPaidStrategyEvidence({
      ...base,
      adInsights: dates(CURRENT.start, CURRENT.end).map((d, i) => ({ ad_id: IDS.a3, date_start: d, impressions: 100, clicks: 1, inline_link_clicks: 1, spend: '10', actions_json: i === 0 ? actions([...engagement, ...leadAliases]) : null })),
    })
    expect(e.top_ads[0].current_28d.business_outcomes[0]).toMatchObject({ outcome: 'lead', count: 6 })
    expect(e.campaigns[0].prior_28d.business_outcomes).toBeDefined()
  })
})
