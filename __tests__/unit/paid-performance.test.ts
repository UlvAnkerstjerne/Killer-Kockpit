import { describe, expect, it } from 'vitest'
import { buildGooglePaidCampaigns, buildMetaPaidCampaigns, costPerResult, formatPaidNumber, googleActionIsPrimary, metaCanonicalAction, paidPeriod, paidRange, visiblePaidCampaigns,
  LEAD_ACTIONS, PURCHASE_ACTIONS, INSTALL_ACTIONS,
  type GooglePaidAction, type GooglePaidCampaign, type GooglePaidDaily } from '@/lib/marketing/paid-performance'
import type { MetaCampaignInsightRow, MetaCampaignRow } from '@/lib/marketing/types/meta'

const range = { start: '2026-06-19', end: '2026-09-16' }
const account = { customer_id: '1111111111', name: 'Account', currency_code: 'DKK', time_zone: 'Europe/Copenhagen' }
const campaign: GooglePaidCampaign = { customer_id: account.customer_id, campaign_id: '123', name: 'Local campaign', status: 'PAUSED', channel_type: 'PERFORMANCE_MAX', goal_config_level: 'CAMPAIGN', custom_conversion_goal: null,
  conversion_goals: [{ category: 'GET_DIRECTIONS', origin: 'GOOGLE_HOSTED', biddable: true }, { category: 'PURCHASE', origin: 'WEBSITE', biddable: true }] }
const action: GooglePaidAction = { customer_id: account.customer_id, resource_name: 'customers/1111111111/conversionActions/1', name: 'Local directions', category: 'GET_DIRECTIONS', origin: 'GOOGLE_HOSTED', primary_for_goal: true, status: 'ENABLED', type: 'GOOGLE_HOSTED' }
const purchase: GooglePaidAction = { ...action, resource_name: 'customers/1111111111/conversionActions/2', name: 'Web purchase', category: 'PURCHASE', origin: 'WEBSITE' }
const row: GooglePaidDaily = { customer_id: account.customer_id, campaign_id: '123', date: '2026-09-10', cost_micros: '100000000', impressions: 500, clicks: 20, conversions: 12.5, all_conversions: 32.5,
  conversion_results: [{ action_resource_name: action.resource_name, action_name: action.name, category: action.category, conversions: 10, all_conversions: 30, conversion_value: 10, all_conversion_value: 30 },
    { action_resource_name: purchase.resource_name, action_name: purchase.name, category: purchase.category, conversions: 2.5, all_conversions: 2.5, conversion_value: 500, all_conversion_value: 500 }] }
const build = (c = campaign, actions = [action, purchase], rows = [row]) => buildGooglePaidCampaigns([c], [account], actions, rows, range)[0]

describe('Google Paid result selection', () => {
  it('keeps goals separate, uses conversions rather than all conversions and divides spend once per result', () => {
    const c = build()
    expect(c.spend).toBe(100)
    expect(c.goal).toBe('Multiple goals')
    expect(c.results.map(r => [r.count, r.costPerResult])).toEqual([[10, 10], [2.5, 40]])
    expect(c.googleResults?.[0].allCount).toBe(30)
  })
  it('requires biddable category AND origin plus a primary action', () => {
    expect(googleActionIsPrimary(campaign, { ...action, origin: 'WEBSITE' })).toBe(false)
    expect(googleActionIsPrimary(campaign, { ...action, primary_for_goal: false })).toBe(false)
    expect(googleActionIsPrimary({ ...campaign, conversion_goals: [] }, action)).toBe(false)
    expect(build(campaign, [{ ...action, primary_for_goal: false }, purchase]).results.map(r => r.name)).toEqual(['Web purchase'])
  })
  it('uses inherited account settings already reflected in campaign goals', () => {
    expect(googleActionIsPrimary({ ...campaign, goal_config_level: 'CUSTOMER' }, action)).toBe(true)
  })
  it('honors custom actions even if secondary and disabled standard goals', () => {
    const custom = { ...campaign, conversion_goals: [], custom_conversion_goal: { resourceName: 'custom/1', conversionActions: [purchase.resource_name] } }
    const result = build(custom, [action, { ...purchase, primary_for_goal: false }])
    expect(result.results.map(r => r.count)).toEqual([2.5])
    expect(result.googleResults?.find(r => r.id === action.resource_name)?.primary).toBe(false)
  })
  it('keeps biddable standard goals alongside custom actions, as Google specifies', () => {
    const custom = { ...campaign, custom_conversion_goal: { resourceName: 'custom/1', conversionActions: [purchase.resource_name] } }
    expect(build(custom, [action, { ...purchase, primary_for_goal: false }]).results.map(r => r.count)).toEqual([10, 2.5])
    expect(build(custom, [action]).results.map(r => r.count)).toEqual([10, 2.5])
  })
  it('does not guess custom membership or standard membership without a definition', () => {
    expect(build({ ...campaign, conversion_goals: [], custom_conversion_goal: { resourceName: 'custom/1' } }).results).toEqual([])
    expect(build({ ...campaign, custom_conversion_goal: { resourceName: 'custom/1' } }).goalNote).toContain('Custom goal action details are unavailable')
    expect(build(campaign, []).results).toEqual([])
    expect(build(campaign, []).googleResults).toHaveLength(2)
  })
  it('never adds different actions sharing a category into one result', () => {
    const other = { ...purchase, category: action.category, origin: action.origin }
    const c = build(campaign, [action, other], [{ ...row, conversion_results: row.conversion_results.map(r => ({ ...r, category: action.category })) }])
    expect(c.results).toHaveLength(2)
    expect(c.results.map(r => r.count)).toEqual([10, 2.5])
  })
  it('shows a configured zero result and no cost/result for spend without conversions', () => {
    const c = build(campaign, [action], [{ ...row, conversions: 0, all_conversions: 0, conversion_results: [] }])
    expect(c.hasActivity).toBe(true)
    expect(c.results[0]).toMatchObject({ label: 'Directions requests', count: 0, costPerResult: null })
    expect(costPerResult(100, 0)).toBeNull()
  })
  it('retains exact micros, dates, status/type, and excludes rows outside the selected period', () => {
    const c = build(campaign, [action, purchase], [{ ...row, cost_micros: '123456789' }, { ...row, date: '2026-06-18' }, { ...row, date: '2026-09-17' }])
    expect(c).toMatchObject({ spend: 123.456789, status: 'PAUSED', type: 'Performance Max', firstDate: row.date, lastDate: row.date })
  })
})

describe('Periods, filters and formatting', () => {
  it('uses exactly 28/90 completed Copenhagen days across DST and midnight', () => {
    expect(paidRange(90, new Date('2026-09-17T12:00:00Z'))).toEqual(range)
    expect(paidRange(28, new Date('2026-09-16T22:30:00Z'))).toEqual({ start: '2026-08-20', end: '2026-09-16' })
    expect(paidRange(28, new Date('2026-03-30T01:00:00Z'))).toEqual({ start: '2026-03-02', end: '2026-03-29' })
    expect(paidPeriod('90')).toBe(90); expect(paidPeriod(['90'])).toBe(28); expect(paidPeriod('365')).toBe(28)
  })
  it('shows paused/removed historical activity by default and hides idle campaigns', () => {
    const paused = build(), removed = { ...build(), id: 'removed', status: 'REMOVED' }, idle = { ...build(), id: 'idle', hasActivity: false }
    expect(visiblePaidCampaigns([paused, removed, idle], 'all', [], false)).toHaveLength(2)
    expect(visiblePaidCampaigns([paused, removed, idle], 'google', [], true)).toHaveLength(3)
    expect(visiblePaidCampaigns([paused, removed], 'meta', [], false)).toHaveLength(0)
    expect(visiblePaidCampaigns([paused, removed], 'google', ['REMOVED'], false)).toEqual([removed])
    expect(visiblePaidCampaigns([{ ...paused, status: 'ENABLED' }], 'google', ['ACTIVE'], false)).toHaveLength(1)
  })
  it('preserves fractional results and compacts large integers', () => {
    expect(formatPaidNumber(137.421391)).toBe('137.42')
    expect(formatPaidNumber(11292)).toBe('11.3K')
    expect(formatPaidNumber(508000)).toBe('508K')
  })
})

describe('Meta alignment', () => {
  const metaCampaign = { id: 'meta1', ad_account_id: 'act1', name: 'Brand', status: 'ACTIVE', objective: 'OUTCOME_AWARENESS' } as MetaCampaignRow
  const metaRow = { campaign_id: 'meta1', date_start: '2026-09-10', spend: '100', impressions: 10000, clicks: 100, reach: 5000,
    actions_json: [{ action_type: 'link_click', value: '100' }, { action_type: 'landing_page_view', value: '20' }, { action_type: 'omni_landing_page_view', value: '20' }, { action_type: 'post_engagement', value: '50' }] } as MetaCampaignInsightRow
  const meta = (objective: string, r = metaRow) => buildMetaPaidCampaigns([{ ...metaCampaign, objective }], [{ id: 'act1', name: 'Meta', currency: 'DKK' }], [r], range)[0]
  it('preserves Awareness impressions and CPM, and Engagement count/cost', () => {
    expect(meta('OUTCOME_AWARENESS').results[0]).toMatchObject({ count: 10000, costPerResult: 10, id: 'CPM' })
    expect(meta('OUTCOME_ENGAGEMENT').results[0]).toMatchObject({ count: 50, costPerResult: 2 })
  })
  it('preserves Traffic LPV threshold and alternate-action fallback without double counting', () => {
    expect(meta('OUTCOME_TRAFFIC').results[0]).toMatchObject({ label: 'Landing page views', count: 20, costPerResult: 5 })
    expect(meta('OUTCOME_TRAFFIC', { ...metaRow, actions_json: [{ action_type: 'link_click', value: '100' }] }).results[0]).toMatchObject({ label: 'Link clicks', count: 100, costPerResult: 1 })
  })

  it('maps Meta Leads using canonical lead action and cost/lead', () => {
    const leadRow = { ...metaRow, actions_json: [{ action_type: 'lead', value: '3' }] } as MetaCampaignInsightRow
    const c = meta('OUTCOME_LEADS', leadRow)
    expect(c.goal).toBe('Leads')
    expect(c.results[0]).toMatchObject({ label: 'Leads', count: 3, costPerResult: 100 / 3 })
    expect(c.results[0].id).toBe('Cost / lead')
  })

  it('maps Meta Sales using canonical purchase action and cost/purchase', () => {
    const salesRow = { ...metaRow, actions_json: [{ action_type: 'purchase', value: '5' }] } as MetaCampaignInsightRow
    const c = meta('OUTCOME_SALES', salesRow)
    expect(c.goal).toBe('Sales')
    expect(c.results[0]).toMatchObject({ label: 'Purchases', count: 5, costPerResult: 20 })
    expect(c.results[0].id).toBe('Cost / purchase')
  })

  it('maps Meta App Promotion using canonical install action and cost/install', () => {
    const appRow = { ...metaRow, actions_json: [{ action_type: 'app_install', value: '10' }] } as MetaCampaignInsightRow
    const c = meta('OUTCOME_APP_PROMOTION', appRow)
    expect(c.goal).toBe('App promotion')
    expect(c.results[0]).toMatchObject({ label: 'App installs', count: 10, costPerResult: 10 })
    expect(c.results[0].id).toBe('Cost / install')
  })

  it('shows zero leads with null cost when no lead actions exist', () => {
    const noLeadRow = { ...metaRow, actions_json: [{ action_type: 'link_click', value: '50' }] } as MetaCampaignInsightRow
    const c = meta('OUTCOME_LEADS', noLeadRow)
    expect(c.results[0]).toMatchObject({ label: 'Leads', count: 0, costPerResult: null })
  })

  it('shows zero purchases with null cost when no purchase actions exist', () => {
    const c = meta('OUTCOME_SALES', { ...metaRow, actions_json: [] } as MetaCampaignInsightRow)
    expect(c.results[0]).toMatchObject({ label: 'Purchases', count: 0, costPerResult: null })
  })

  it('shows zero installs with null cost when no install actions exist', () => {
    const c = meta('OUTCOME_APP_PROMOTION', { ...metaRow, actions_json: [] } as MetaCampaignInsightRow)
    expect(c.results[0]).toMatchObject({ label: 'App installs', count: 0, costPerResult: null })
  })

  it('maps unknown objective to raw objective string', () => {
    const c = meta('SOME_FUTURE_OBJECTIVE')
    expect(c.goal).toBe('SOME_FUTURE_OBJECTIVE')
  })

  it('maps null objective to Unspecified goal', () => {
    const c = buildMetaPaidCampaigns(
      [{ ...metaCampaign, objective: null } as MetaCampaignRow],
      [{ id: 'act1', name: 'Meta', currency: 'DKK' }], [metaRow], range,
    )[0]
    expect(c.goal).toBe('Unspecified goal')
  })
})

describe('Meta canonical action priority (no double counting)', () => {
  const makeRow = (...actions: { action_type: string; value: string }[]) =>
    ({ campaign_id: 'x', date_start: '2026-09-10', spend: '0', impressions: 0, clicks: 0, reach: 0, actions_json: actions } as MetaCampaignInsightRow)

  it('prefers "lead" over "onsite_web_lead" and "offsite_conversion.fb_pixel_lead"', () => {
    const rows = [makeRow(
      { action_type: 'lead', value: '5' },
      { action_type: 'onsite_web_lead', value: '3' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '4' },
    )]
    expect(metaCanonicalAction(rows, LEAD_ACTIONS)).toBe(5)
  })

  it('falls back to onsite_web_lead when lead is absent', () => {
    const rows = [makeRow(
      { action_type: 'onsite_web_lead', value: '7' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '4' },
    )]
    expect(metaCanonicalAction(rows, LEAD_ACTIONS)).toBe(7)
  })

  it('falls back to pixel lead when only pixel lead is present', () => {
    const rows = [makeRow({ action_type: 'offsite_conversion.fb_pixel_lead', value: '2' })]
    expect(metaCanonicalAction(rows, LEAD_ACTIONS)).toBe(2)
  })

  it('sums across multiple daily rows for the canonical action only', () => {
    const rows = [
      makeRow({ action_type: 'lead', value: '3' }, { action_type: 'onsite_web_lead', value: '10' }),
      makeRow({ action_type: 'lead', value: '2' }, { action_type: 'onsite_web_lead', value: '8' }),
    ]
    expect(metaCanonicalAction(rows, LEAD_ACTIONS)).toBe(5)
  })

  it('returns 0 when no matching action exists', () => {
    const rows = [makeRow({ action_type: 'link_click', value: '100' })]
    expect(metaCanonicalAction(rows, LEAD_ACTIONS)).toBe(0)
  })

  it('skips a priority action present with zero value', () => {
    const rows = [makeRow(
      { action_type: 'lead', value: '0' },
      { action_type: 'onsite_web_lead', value: '3' },
    )]
    expect(metaCanonicalAction(rows, LEAD_ACTIONS)).toBe(3)
  })

  it('prefers "purchase" over pixel and onsite purchase aliases', () => {
    const rows = [makeRow(
      { action_type: 'purchase', value: '2' },
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' },
      { action_type: 'onsite_web_purchase', value: '1' },
    )]
    expect(metaCanonicalAction(rows, PURCHASE_ACTIONS)).toBe(2)
  })

  it('prefers "app_install" over mobile_app_install', () => {
    const rows = [makeRow(
      { action_type: 'app_install', value: '8' },
      { action_type: 'mobile_app_install', value: '8' },
    )]
    expect(metaCanonicalAction(rows, INSTALL_ACTIONS)).toBe(8)
  })
})

describe('Google single and multiple primary goals', () => {
  it('shows a single goal label when only one primary result has conversions', () => {
    const singleGoalCampaign: GooglePaidCampaign = { ...campaign, conversion_goals: [{ category: 'GET_DIRECTIONS', origin: 'GOOGLE_HOSTED', biddable: true }] }
    const singleRow: GooglePaidDaily = { ...row, conversion_results: [row.conversion_results[0]] }
    const c = buildGooglePaidCampaigns([singleGoalCampaign], [account], [action], [singleRow], range)[0]
    expect(c.goal).toBe('Directions requests')
    expect(c.results).toHaveLength(1)
    expect(c.results[0].count).toBe(10)
  })

  it('shows "Multiple goals" when two or more primary results have conversions', () => {
    const c = build()
    expect(c.goal).toBe('Multiple goals')
    expect(c.results).toHaveLength(2)
  })

  it('shows "Primary goal unavailable" when no primary actions are configured', () => {
    const noGoals: GooglePaidCampaign = { ...campaign, conversion_goals: [], custom_conversion_goal: null }
    const c = buildGooglePaidCampaigns([noGoals], [account], [], [row], range)[0]
    expect(c.goal).toBe('Primary goal unavailable')
  })
})

describe('Cost-per-outcome calculation', () => {
  it('returns spend / count when count > 0', () => {
    expect(costPerResult(100, 4)).toBe(25)
    expect(costPerResult(273.42, 3)).toBeCloseTo(91.14, 2)
  })

  it('returns null when count is 0', () => {
    expect(costPerResult(100, 0)).toBeNull()
    expect(costPerResult(0, 0)).toBeNull()
  })

  it('returns 0 cost per result when spend is 0 but count > 0', () => {
    expect(costPerResult(0, 5)).toBe(0)
  })
})
