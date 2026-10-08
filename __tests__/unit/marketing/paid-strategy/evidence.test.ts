import { describe, expect, it } from 'vitest'
import { CURRENT, dates, IDS, NOW, PRIOR, strategyInputs } from '../../../helpers/paid-strategy'
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

  it('positions month-to-date spend against the 15,000 DKK hard cap', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    expect(e.budget).toMatchObject({
      currency: 'DKK', monthly_ceiling: MONTHLY_CEILING_DKK, ceiling_is_hard_cap_not_target: true,
      month_to_date_spend: 7 * 200, month_days_elapsed: 7, month_days_total: 31, ceiling_headroom_this_month: 15000 - 1400,
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

  it('keeps overlapping Meta action types separate and never sums them', () => {
    const e = buildPaidStrategyEvidence(strategyInputs())
    const leads = e.campaigns.find(c => c.objective === 'OUTCOME_LEADS')!
    expect(leads.current_28d.top_actions).toEqual(expect.arrayContaining([
      { type: 'lead', count: 56 }, { type: 'offsite_conversion.fb_pixel_lead', count: 56 }, { type: 'link_click', count: 1680 },
    ]))
    expect(JSON.stringify(e)).not.toMatch(/total_leads|all_leads/)
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
