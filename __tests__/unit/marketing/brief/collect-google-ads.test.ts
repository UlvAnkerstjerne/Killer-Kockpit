/**
 * Regression tests for collectGoogleAdsData in lib/marketing/brief/collect-data.ts.
 *
 * Verified guarantees:
 *   1. Prior-period account totals (spend, impressions, clicks) are computed from
 *      currently-ENABLED campaigns only — a paused campaign's prior spend must never
 *      contaminate the prior benchmark.
 *   2. Prior-period result comparisons are matched by action resource name only.
 *      A different action in the prior period must not populate prior_count for the
 *      current action (no cross-result aggregation).
 *   3. When a matching action IS present in the prior period, prior_count and
 *      prior_costPerResult are populated correctly.
 *   4. When no active campaigns have prior rows, prior totals are null (not zero).
 *
 * The DB is mocked directly; buildGooglePaidCampaigns runs with real logic so
 * result/goal semantics are exercised end-to-end.
 */

import { describe, it, expect, vi } from 'vitest'
import { collectGoogleAdsData } from '@/lib/marketing/brief/collect-data'

// ── Shared fixtures ────────────────────────────────────────────────────────────

const ACCOUNT = {
  customer_id: 'cust1',
  name: 'Test Account',
  currency_code: 'DKK',
  time_zone: 'Europe/Copenhagen',
}

const ENABLED_CAMPAIGN = {
  customer_id: 'cust1',
  campaign_id: 'camp1',
  name: 'Active Campaign',
  status: 'ENABLED',
  channel_type: 'SEARCH',
  goal_config_level: 'ACCOUNT',
  conversion_goals: [],
  custom_conversion_goal: null,
}

const PAUSED_CAMPAIGN = {
  customer_id: 'cust1',
  campaign_id: 'camp2',
  name: 'Paused Campaign',
  status: 'PAUSED',
  channel_type: 'SEARCH',
  goal_config_level: 'ACCOUNT',
  conversion_goals: [],
  custom_conversion_goal: null,
}

/** A conversion action that is primary at account level (origin !== WEBSITE, primary_for_goal true). */
const ACTION_A = {
  customer_id: 'cust1',
  resource_name: 'customers/1/conversionActions/100',
  name: 'Purchase',
  category: 'PURCHASE',
  origin: 'APP',
  primary_for_goal: true,
  status: 'ENABLED',
  type: 'FLOODLIGHT',
}

/** A second conversion action with a different resource name — must never cross-match with ACTION_A. */
const ACTION_B = {
  customer_id: 'cust1',
  resource_name: 'customers/1/conversionActions/999',
  name: 'Lead',
  category: 'LEAD',
  origin: 'APP',
  primary_for_goal: true,
  status: 'ENABLED',
  type: 'FLOODLIGHT',
}

/** Build a minimal daily row, optionally with a single conversion result. */
function makeDailyRow(opts: {
  customerId: string
  campaignId: string
  date: string
  costMicros: string
  conversions?: number
  actionResourceName?: string
  actionName?: string
  actionCategory?: string
}) {
  const conversions = opts.conversions ?? 0
  return {
    customer_id: opts.customerId,
    campaign_id: opts.campaignId,
    date: opts.date,
    cost_micros: opts.costMicros,
    impressions: '100',
    clicks: '10',
    conversions: String(conversions),
    all_conversions: String(conversions),
    conversion_results:
      conversions > 0 && opts.actionResourceName
        ? [
            {
              action_resource_name: opts.actionResourceName,
              action_name: opts.actionName ?? '',
              category: opts.actionCategory ?? '',
              conversions: String(conversions),
              all_conversions: String(conversions),
              conversion_value: '0',
              all_conversion_value: '0',
            },
          ]
        : [],
  }
}

/** Minimal query chain mock — all builder methods return `chain`, resolves to { data, error: null }. */
function makeQueryChain(data: unknown[]) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'eq', 'gte', 'lte', 'order', 'limit', 'range', 'not']) {
    chain[m] = () => chain
  }
  chain['then'] = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
    Promise.resolve(resolve({ data, error: null }))
  return chain
}

/**
 * Build a DB mock.
 * For google_ads_campaign_daily: the first call (synchronous, inside Promise.all) returns
 * currentDaily; the second returns priorDaily.
 */
function makeDb(opts: {
  campaigns: unknown[]
  actions: unknown[]
  currentDaily: unknown[]
  priorDaily: unknown[]
}) {
  let dailyCallCount = 0
  return {
    from: vi.fn((table: string) => {
      if (table === 'google_ads_accounts')           return makeQueryChain([ACCOUNT])
      if (table === 'google_ads_campaigns')          return makeQueryChain(opts.campaigns)
      if (table === 'google_ads_conversion_actions') return makeQueryChain(opts.actions)
      if (table === 'google_ads_campaign_daily') {
        return dailyCallCount++ === 0
          ? makeQueryChain(opts.currentDaily)
          : makeQueryChain(opts.priorDaily)
      }
      return makeQueryChain([])
    }),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('collectGoogleAdsData — active-only prior totals', () => {
  it('excludes currently-paused campaign spend from prior-period totals', async () => {
    // camp1 (ENABLED): prior spend = DKK 3.00 (3_000_000 micros)
    // camp2 (PAUSED):  prior spend = DKK 2.00 (2_000_000 micros)
    // Expected: total_spend_prior_7d = 3.0 — NOT 5.0
    const db = makeDb({
      campaigns: [ENABLED_CAMPAIGN, PAUSED_CAMPAIGN],
      actions: [],
      currentDaily: [
        makeDailyRow({ customerId: 'cust1', campaignId: 'camp1', date: '2026-09-19', costMicros: '5000000' }),
      ],
      priorDaily: [
        makeDailyRow({ customerId: 'cust1', campaignId: 'camp1', date: '2026-09-12', costMicros: '3000000' }),
        // Paused campaign — must NOT be included in prior totals
        makeDailyRow({ customerId: 'cust1', campaignId: 'camp2', date: '2026-09-12', costMicros: '2000000' }),
      ],
    })

    const result = await collectGoogleAdsData(db as never, '2026-09-13', '2026-09-19')

    expect(result).not.toBeNull()
    expect(result!.total_spend_prior_7d).toBeCloseTo(3.0)
    // Explicitly verify the paused campaign's 2 DKK did not contaminate the total
    expect(result!.total_spend_prior_7d).not.toBeCloseTo(5.0)
  })

  it('returns null prior totals when no active campaign has prior-period rows', async () => {
    // Only the paused campaign has prior rows — the enabled campaign has none
    const db = makeDb({
      campaigns: [ENABLED_CAMPAIGN, PAUSED_CAMPAIGN],
      actions: [],
      currentDaily: [
        makeDailyRow({ customerId: 'cust1', campaignId: 'camp1', date: '2026-09-19', costMicros: '5000000' }),
      ],
      priorDaily: [
        makeDailyRow({ customerId: 'cust1', campaignId: 'camp2', date: '2026-09-12', costMicros: '2000000' }),
      ],
    })

    const result = await collectGoogleAdsData(db as never, '2026-09-13', '2026-09-19')

    expect(result).not.toBeNull()
    expect(result!.total_spend_prior_7d).toBeNull()
    expect(result!.total_impressions_prior_7d).toBeNull()
    expect(result!.total_clicks_prior_7d).toBeNull()
  })
})

describe('collectGoogleAdsData — per-result prior comparisons', () => {
  it('prior_count matches the same action resource name in the prior period', async () => {
    // Current: ACTION_A → 5 conversions, spend DKK 10.00
    // Prior:   ACTION_A → 3 conversions, spend DKK 6.00
    // Expected: top_results[0].prior_count = 3, prior_costPerResult ≈ 2.0
    const db = makeDb({
      campaigns: [ENABLED_CAMPAIGN],
      actions: [ACTION_A],
      currentDaily: [
        makeDailyRow({
          customerId: 'cust1', campaignId: 'camp1', date: '2026-09-19',
          costMicros: '10000000', conversions: 5,
          actionResourceName: ACTION_A.resource_name,
          actionName: ACTION_A.name,
          actionCategory: ACTION_A.category,
        }),
      ],
      priorDaily: [
        makeDailyRow({
          customerId: 'cust1', campaignId: 'camp1', date: '2026-09-12',
          costMicros: '6000000', conversions: 3,
          actionResourceName: ACTION_A.resource_name,
          actionName: ACTION_A.name,
          actionCategory: ACTION_A.category,
        }),
      ],
    })

    const result = await collectGoogleAdsData(db as never, '2026-09-13', '2026-09-19')

    expect(result).not.toBeNull()
    const campaign = result!.active_campaigns[0]
    expect(campaign).toBeDefined()
    const topResult = campaign.top_results[0]
    expect(topResult).toBeDefined()
    expect(topResult.count).toBe(5)
    expect(topResult.prior_count).toBe(3)
    // 6 DKK / 3 conversions = DKK 2.00
    expect(topResult.prior_costPerResult).toBeCloseTo(2.0)
  })

  it('prior_count is null when current action has no matching entry in prior period (no cross-result aggregation)', async () => {
    // Current:  ACTION_A (resource 100) → 5 conversions
    // Prior:    ACTION_B (resource 999) only → 10 conversions (completely different action)
    // Expected: ACTION_A's prior_count = null — ACTION_B's count must NOT cross over
    const db = makeDb({
      campaigns: [ENABLED_CAMPAIGN],
      actions: [ACTION_A, ACTION_B],
      currentDaily: [
        makeDailyRow({
          customerId: 'cust1', campaignId: 'camp1', date: '2026-09-19',
          costMicros: '10000000', conversions: 5,
          actionResourceName: ACTION_A.resource_name,
          actionName: ACTION_A.name,
          actionCategory: ACTION_A.category,
        }),
      ],
      priorDaily: [
        makeDailyRow({
          customerId: 'cust1', campaignId: 'camp1', date: '2026-09-12',
          costMicros: '8000000', conversions: 10,
          actionResourceName: ACTION_B.resource_name,
          actionName: ACTION_B.name,
          actionCategory: ACTION_B.category,
        }),
      ],
    })

    const result = await collectGoogleAdsData(db as never, '2026-09-13', '2026-09-19')

    expect(result).not.toBeNull()
    const campaign = result!.active_campaigns[0]
    // googleResultLabel('PURCHASE', ...) → 'Purchases'
    const purchaseResult = campaign.top_results.find(r => r.label === 'Purchases')
    expect(purchaseResult).toBeDefined()
    expect(purchaseResult!.count).toBe(5)
    // ACTION_B (Lead, 10 conversions) must NOT contaminate ACTION_A's prior_count
    expect(purchaseResult!.prior_count).toBeNull()
    expect(purchaseResult!.prior_costPerResult).toBeNull()
  })
})
