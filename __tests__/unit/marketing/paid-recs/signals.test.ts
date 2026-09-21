/**
 * Unit tests for lib/marketing/paid-recs/signals.ts
 *
 * Verified guarantees:
 *   1.  pickSignalType — returns null when spend below MIN_SPEND_7D
 *   2.  pickSignalType — spend_no_results when spend ≥ threshold and 0 results
 *   3.  pickSignalType — cpr_worsening when CPR up ≥ 25% with adequate prior
 *   4.  pickSignalType — cpr_improving when CPR down ≥ 25% with adequate prior
 *   5.  pickSignalType — strong_performance when results up ≥ 30%
 *   6.  pickSignalType — no signal when change is within thresholds
 *   7.  pickSignalType — spend_no_results wins over missing prior data
 *   8.  pickSignalType — skips CPR comparison if prior result_count < MIN_RESULTS_PRIOR
 *   9.  metaResultForObjective — OUTCOME_LEADS sums lead actions
 *   10. metaResultForObjective — OUTCOME_AWARENESS uses impressions
 *   11. metaResultForObjective — OUTCOME_TRAFFIC uses link_click when no LPV
 *   12. metaResultForObjective — OUTCOME_TRAFFIC uses LPV when ratio > 10%
 *   13. metaResultForObjective — OUTCOME_ENGAGEMENT uses post_engagement
 *   14. buildMetaSignals — skips ZZ-prefixed campaigns
 *   15. buildMetaSignals — skips campaigns below spend threshold
 *   16. buildMetaSignals — emits spend_no_results for OUTCOME_LEADS with zero leads
 *   17. buildMetaSignals — emits cpr_worsening when CPL increases
 *   18. buildGoogleSignals — emits spend_no_results when cost but no conversions
 *   19. rankSignals — orders spend_no_results before cpr_improving
 *   20. rankSignals — caps at MAX_SIGNALS_FOR_AI
 */

import { describe, it, expect } from 'vitest'
import {
  pickSignalType,
  metaResultForObjective,
  buildMetaSignals,
  buildGoogleSignals,
  rankSignals,
  MIN_SPEND_7D,
  MIN_RESULTS_PRIOR,
  CPR_CHANGE_THRESHOLD,
  STRONG_PERF_THRESHOLD,
  MAX_SIGNALS_FOR_AI,
} from '@/lib/marketing/paid-recs/signals'
import type { PaidRecWindow } from '@/lib/marketing/paid-recs/types'
import type { MetaCampaignInsightRow } from '@/lib/marketing/types/meta'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWindow(spend: number, result_count: number): PaidRecWindow {
  return { spend, result_count, cpr: result_count > 0 ? spend / result_count : null }
}

function makeInsightRow(overrides: Partial<MetaCampaignInsightRow> = {}): MetaCampaignInsightRow {
  return {
    campaign_id: 'c1',
    date_start: '2026-09-14',
    impressions: 1000,
    reach: null,
    clicks: null,
    inline_link_clicks: null,
    spend: '100',
    cpm: null,
    cpc: null,
    ctr: null,
    frequency: null,
    actions_json: null,
    cost_per_action_json: null,
    action_values_json: null,
    ...overrides,
  }
}

// ─── pickSignalType ───────────────────────────────────────────────────────────

describe('pickSignalType', () => {
  it('1. returns null when spend below MIN_SPEND_7D', () => {
    const current = makeWindow(MIN_SPEND_7D - 1, 0)
    expect(pickSignalType(current, null)).toBeNull()
  })

  it('2. returns spend_no_results when spend ≥ threshold and 0 results', () => {
    const current = makeWindow(MIN_SPEND_7D, 0)
    const result = pickSignalType(current, null)
    expect(result?.signal).toBe('spend_no_results')
    expect(result?.change_pct).toBeNull()
  })

  it('3. returns cpr_worsening when CPR up ≥ threshold with adequate prior', () => {
    const cprPrior = 100
    const cprCurrent = cprPrior * (1 + CPR_CHANGE_THRESHOLD + 0.01) // just above threshold
    const current = { spend: cprCurrent * 10, result_count: 10, cpr: cprCurrent }
    const prior = { spend: cprPrior * MIN_RESULTS_PRIOR, result_count: MIN_RESULTS_PRIOR, cpr: cprPrior }
    const result = pickSignalType(current, prior)
    expect(result?.signal).toBe('cpr_worsening')
    expect(result?.change_pct).toBeCloseTo(CPR_CHANGE_THRESHOLD + 0.01, 2)
  })

  it('4. returns cpr_improving when CPR down ≥ threshold with adequate prior', () => {
    const cprPrior = 100
    const cprCurrent = cprPrior * (1 - CPR_CHANGE_THRESHOLD - 0.01)
    // Keep result_count the same as prior so strong_performance doesn't fire
    const current = { spend: cprCurrent * MIN_RESULTS_PRIOR, result_count: MIN_RESULTS_PRIOR, cpr: cprCurrent }
    const prior = { spend: cprPrior * MIN_RESULTS_PRIOR, result_count: MIN_RESULTS_PRIOR, cpr: cprPrior }
    const result = pickSignalType(current, prior)
    expect(result?.signal).toBe('cpr_improving')
    expect(result?.change_pct).toBeLessThan(0)
  })

  it('5. returns strong_performance when results up ≥ STRONG_PERF_THRESHOLD', () => {
    const priorCount = MIN_RESULTS_PRIOR
    // CPR stays roughly the same — ensures cpr_worsening/improving don't fire first
    const priorCpr = 100
    const currentCount = Math.ceil(priorCount * (1 + STRONG_PERF_THRESHOLD + 0.01))
    const prior = { spend: priorCpr * priorCount, result_count: priorCount, cpr: priorCpr }
    // currentCpr slightly better but below cpr_improving threshold
    const currentCpr = priorCpr * 0.90  // 10% better — below 25% threshold
    const current = { spend: currentCpr * currentCount, result_count: currentCount, cpr: currentCpr }
    const result = pickSignalType(current, prior)
    expect(result?.signal).toBe('strong_performance')
  })

  it('6. returns null when change is within thresholds', () => {
    const cprPrior = 100
    const cprCurrent = cprPrior * 1.10 // 10% CPR change, below 25% threshold
    // Keep result_count identical so strong_performance doesn't fire
    const current = { spend: cprCurrent * MIN_RESULTS_PRIOR, result_count: MIN_RESULTS_PRIOR, cpr: cprCurrent }
    const prior = { spend: cprPrior * MIN_RESULTS_PRIOR, result_count: MIN_RESULTS_PRIOR, cpr: cprPrior }
    expect(pickSignalType(current, prior)).toBeNull()
  })

  it('7. spend_no_results wins even with null prior', () => {
    const current = makeWindow(MIN_SPEND_7D + 50, 0)
    const result = pickSignalType(current, null)
    expect(result?.signal).toBe('spend_no_results')
  })

  it('8. skips CPR comparison if prior result_count < MIN_RESULTS_PRIOR', () => {
    const cprPrior = 100
    const cprCurrent = 200  // 100% worse
    const current = { spend: cprCurrent * 5, result_count: 5, cpr: cprCurrent }
    const prior = { spend: cprPrior * (MIN_RESULTS_PRIOR - 1), result_count: MIN_RESULTS_PRIOR - 1, cpr: cprPrior }
    // Not enough prior results — should fall through to strong_performance or null
    const result = pickSignalType(current, prior)
    expect(result?.signal).not.toBe('cpr_worsening')
  })
})

// ─── metaResultForObjective ───────────────────────────────────────────────────

describe('metaResultForObjective', () => {
  it('9. OUTCOME_LEADS sums lead actions', () => {
    const rows = [
      makeInsightRow({ actions_json: [{ action_type: 'lead', value: '3' }] }),
      makeInsightRow({ actions_json: [{ action_type: 'onsite_conversion.lead_grouped', value: '2' }] }),
    ]
    const { label, count } = metaResultForObjective(rows, 'OUTCOME_LEADS')
    expect(label).toBe('Leads')
    expect(count).toBe(5)
  })

  it('10. OUTCOME_AWARENESS uses impressions', () => {
    const rows = [
      makeInsightRow({ impressions: 1500 }),
      makeInsightRow({ impressions: 800 }),
    ]
    const { label, count } = metaResultForObjective(rows, 'OUTCOME_AWARENESS')
    expect(label).toBe('Impressions')
    expect(count).toBe(2300)
  })

  it('11. OUTCOME_TRAFFIC uses link_click when no LPV', () => {
    const rows = [
      makeInsightRow({ actions_json: [{ action_type: 'link_click', value: '50' }] }),
    ]
    const { label, count } = metaResultForObjective(rows, 'OUTCOME_TRAFFIC')
    expect(label).toBe('Link clicks')
    expect(count).toBe(50)
  })

  it('12. OUTCOME_TRAFFIC uses LPV when ratio > 10%', () => {
    const rows = [
      makeInsightRow({
        actions_json: [
          { action_type: 'link_click', value: '100' },
          { action_type: 'landing_page_view', value: '80' },
        ],
      }),
    ]
    const { label, count } = metaResultForObjective(rows, 'OUTCOME_TRAFFIC')
    expect(label).toBe('Landing page views')
    expect(count).toBe(80)
  })

  it('13. OUTCOME_ENGAGEMENT uses post_engagement', () => {
    const rows = [
      makeInsightRow({ actions_json: [{ action_type: 'post_engagement', value: '120' }] }),
    ]
    const { label, count } = metaResultForObjective(rows, 'OUTCOME_ENGAGEMENT')
    expect(label).toBe('Post engagements')
    expect(count).toBe(120)
  })
})

// ─── buildMetaSignals ─────────────────────────────────────────────────────────

function makeMetaCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    ad_account_id: 'act_1',
    name: 'Test Campaign',
    status: 'ACTIVE',
    objective: 'OUTCOME_LEADS',
    daily_budget: null,
    lifetime_budget: null,
    created_at_meta: null,
    synced_at: '2026-09-21T10:00:00Z',
    currency: 'DKK',
    ...overrides,
  }
}

describe('buildMetaSignals', () => {
  it('14. skips ZZ-prefixed campaigns', () => {
    const input = [{
      campaign: makeMetaCampaign({ name: 'ZZ Old Campaign' }),
      currentRows: [makeInsightRow({ spend: '500' })],
      priorRows: [],
    }]
    expect(buildMetaSignals(input)).toHaveLength(0)
  })

  it('15. skips campaigns below spend threshold', () => {
    const input = [{
      campaign: makeMetaCampaign(),
      currentRows: [makeInsightRow({ spend: String(MIN_SPEND_7D - 1) })],
      priorRows: [],
    }]
    expect(buildMetaSignals(input)).toHaveLength(0)
  })

  it('16. emits spend_no_results for OUTCOME_LEADS with zero leads', () => {
    const input = [{
      campaign: makeMetaCampaign({ objective: 'OUTCOME_LEADS' }),
      currentRows: [makeInsightRow({ spend: String(MIN_SPEND_7D + 100), actions_json: [] })],
      priorRows: [],
    }]
    const signals = buildMetaSignals(input)
    expect(signals).toHaveLength(1)
    expect(signals[0].signal_type).toBe('spend_no_results')
    expect(signals[0].platform).toBe('meta')
    expect(signals[0].result_label).toBe('Leads')
  })

  it('17. emits cpr_worsening when CPL increases significantly', () => {
    const priorRows = Array(MIN_RESULTS_PRIOR).fill(null).map((_, i) =>
      makeInsightRow({
        spend: '100',
        actions_json: [{ action_type: 'lead', value: '1' }],
        date_start: `2026-09-${String(i + 1).padStart(2, '0')}`,
      })
    )
    // CPR prior = 100 DKK/lead. Current: same leads but 2x spend = 200 DKK/lead
    const currentRows = [
      makeInsightRow({
        spend: String(MIN_RESULTS_PRIOR * 200),
        actions_json: [{ action_type: 'lead', value: String(MIN_RESULTS_PRIOR) }],
        date_start: '2026-09-14',
      }),
    ]
    const input = [{
      campaign: makeMetaCampaign({ objective: 'OUTCOME_LEADS' }),
      currentRows,
      priorRows,
    }]
    const signals = buildMetaSignals(input)
    expect(signals).toHaveLength(1)
    expect(signals[0].signal_type).toBe('cpr_worsening')
    expect(signals[0].change_pct).toBeGreaterThan(CPR_CHANGE_THRESHOLD)
  })
})

// ─── buildGoogleSignals ───────────────────────────────────────────────────────

describe('buildGoogleSignals', () => {
  it('18. emits spend_no_results when cost but no conversions', () => {
    const campaign = {
      customer_id: '123',
      campaign_id: '456',
      name: 'Google Campaign',
      status: 'ENABLED',
      channel_type: 'SEARCH',
      channel_sub_type: null,
      bidding_strategy_type: null,
      goal_config_level: null,
      conversion_goals: [],
      custom_conversion_goal: null,
      synced_at: '2026-09-21T10:00:00Z',
      currency: 'DKK',
    }
    const currentRows = [{
      customer_id: '123',
      campaign_id: '456',
      date: '2026-09-14',
      cost_micros: String(MIN_SPEND_7D * 2 * 1_000_000),
      impressions: 500,
      clicks: 20,
      conversions: 0,
      all_conversions: 0,
      conversion_results: [],
    }]
    const input = [{ campaign, actions: [], currentRows, priorRows: [] }]
    const signals = buildGoogleSignals(input)
    expect(signals).toHaveLength(1)
    expect(signals[0].signal_type).toBe('spend_no_results')
    expect(signals[0].platform).toBe('google')
  })
})

// ─── rankSignals ──────────────────────────────────────────────────────────────

describe('rankSignals', () => {
  function makeSignal(type: string, platform = 'meta') {
    return {
      platform: platform as 'meta' | 'google',
      campaign_id: `c_${type}`,
      campaign_name: 'Test',
      objective: 'OUTCOME_LEADS',
      signal_type: type as never,
      currency: 'DKK',
      result_label: 'Leads',
      current: makeWindow(200, 5),
      prior: null,
      change_pct: null,
    }
  }

  it('19. orders spend_no_results before cpr_improving', () => {
    const signals = rankSignals(
      [makeSignal('cpr_improving'), makeSignal('spend_no_results')],
      [],
    )
    expect(signals[0].signal_type).toBe('spend_no_results')
    expect(signals[1].signal_type).toBe('cpr_improving')
  })

  it('20. caps at MAX_SIGNALS_FOR_AI', () => {
    const many = Array(MAX_SIGNALS_FOR_AI + 3).fill(null).map((_, i) => makeSignal('cpr_improving', i % 2 === 0 ? 'meta' : 'google'))
    const signals = rankSignals(many, [])
    expect(signals).toHaveLength(MAX_SIGNALS_FOR_AI)
  })
})
