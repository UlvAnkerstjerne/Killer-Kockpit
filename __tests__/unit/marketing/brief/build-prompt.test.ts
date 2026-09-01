/**
 * Tests for lib/marketing/brief/build-prompt.ts
 *
 * Verifies that the prompt builder:
 *   - Produces well-formed output for each data configuration
 *   - Correctly handles GBP pending_approval state (no invented data)
 *   - Includes the pre-determined status
 *   - Marks external text as DATA
 *   - Is a pure function (same input → same output)
 */

import { describe, it, expect } from 'vitest'
import { buildBriefUserMessage, MORNING_BRIEF_SYSTEM_PROMPT, BRIEF_PROMPT_VERSION } from '@/lib/marketing/brief/build-prompt'
import type { BriefInputData, OverallStatus } from '@/lib/marketing/brief/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMinimalInput(overrides?: Partial<BriefInputData>): BriefInputData {
  return {
    briefDate:      '2026-08-31',
    dataWindowStart: '2026-08-24',
    dataWindowEnd:   '2026-08-30',
    currency:       'DKK',
    sourceFreshness: {
      meta_ads_daily:        { last_success_at: '2026-08-31T06:15:00Z', status: 'synced', age_hours: 1.5, healthy: true },
      meta_ig_account_daily: { last_success_at: '2026-08-31T06:20:00Z', status: 'synced', age_hours: 1.4, healthy: true },
      meta_ig_organic_deep:  { last_success_at: '2026-08-27T06:00:00Z', status: 'synced', age_hours: 72,  healthy: true },
      meta_fb_page_daily:    { last_success_at: '2026-08-31T06:25:00Z', status: 'synced', age_hours: 1.3, healthy: true },
      meta_fb_organic_deep:  { last_success_at: '2026-08-27T06:00:00Z', status: 'synced', age_hours: 72,  healthy: true },
      gbp: { kind: 'pending_approval', last_sync_at: null, healthy: true },
    },
    signals: {
      has_stale_critical_source: false,
      stale_sources: [],
      paid_anomaly_count: 0,
      paid_anomalies: [],
      organic_ig_drop_detected: false,
      organic_ig_reach_7d_vs_prior_7d_pct: null,
      pending_review_count: 0,
      gbp_kind: 'pending_approval',
      computed_status: 'green',
      status_reasons: [],
    },
    paid: null,
    organic: {
      ig: {
        reach_7d: 28400, reach_prior_7d: 24100,
        accounts_engaged_7d: 1840, profile_views_7d: 3200,
        followers_current: 8420, followers_7d_delta: 34,
      },
      ig_top_posts: [],
      ig_avg_reach_7d: null,
      ig_daily_reach_series: [],
      fb: { views_7d: 3200, engaged_users_7d: 420, fan_count_current: 1200, fan_count_7d_delta: 5 },
      fb_recent_posts: [],
      fb_available: true,
      fb_daily_views_series: [],
    },
    gbp: {
      integration_status: { kind: 'pending_approval', last_sync_at: null, healthy: true },
      pending_reply_count: 0,
      new_reviews_yesterday: null,
      avg_star_rating_7d: null,
    },
    needsReview: { total: 0, review_reply: 0, paid_recommendation: 0, content_approval: 0 },
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BRIEF_PROMPT_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof BRIEF_PROMPT_VERSION).toBe('string')
    expect(BRIEF_PROMPT_VERSION.length).toBeGreaterThan(0)
  })
})

describe('MORNING_BRIEF_SYSTEM_PROMPT', () => {
  it('contains untrusted data instruction', () => {
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain('UNTRUSTED')
  })

  it('specifies the required JSON output fields', () => {
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain('overall_reason')
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain('ai_summary')
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain('paid_assessment')
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain('organic_assessment')
    expect(MORNING_BRIEF_SYSTEM_PROMPT).toContain('gbp_assessment')
  })
})

describe('buildBriefUserMessage', () => {
  it('includes the brief date', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'green')
    expect(msg).toContain('2026-08-31')
  })

  it('includes the pre-determined status', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'amber')
    expect(msg).toContain('AMBER')
  })

  it('includes GREEN status correctly', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'green')
    expect(msg).toContain('GREEN')
  })

  it('includes RED status correctly', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'red')
    expect(msg).toContain('RED')
  })

  it('includes data window dates', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'green')
    expect(msg).toContain('2026-08-24')
    expect(msg).toContain('2026-08-30')
  })

  it('includes currency', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'green')
    expect(msg).toContain('DKK')
  })

  it('GBP pending_approval: includes pending_approval status without invented data', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'green')
    expect(msg).toContain('pending_approval')
    expect(msg).toContain('Set gbp_assessment to null')
    // Must NOT include fictional review counts
    expect(msg).not.toContain('New reviews yesterday: ')
  })

  it('GBP connected: includes review data', () => {
    const input = makeMinimalInput({
      gbp: {
        integration_status: { kind: 'connected', last_sync_at: '2026-08-31T06:00:00Z', healthy: true },
        pending_reply_count: 2,
        new_reviews_yesterday: 1,
        avg_star_rating_7d: 4.3,
      },
    })
    const msg = buildBriefUserMessage(input, 'amber')
    expect(msg).toContain('New reviews yesterday')
    expect(msg).toContain('awaiting approval')
  })

  it('includes anomaly warning when anomalies present', () => {
    const input = makeMinimalInput({
      signals: {
        ...makeMinimalInput().signals,
        paid_anomaly_count: 1,
        paid_anomalies: [{
          campaign_name: 'Test Campaign',
          metric_label: 'cpc',
          change_pct: 28.5,
          direction: 'increase',
          yesterday_value: 12.5,
          baseline_value: 9.7,
        }],
      },
    })
    const msg = buildBriefUserMessage(input, 'amber')
    expect(msg).toContain('ANOMALIES DETECTED')
    expect(msg).toContain('Test Campaign')
  })

  it('marks campaign names as DATA', () => {
    const input = makeMinimalInput({
      paid: {
        active_campaigns: [{
          id: 'c1', name: 'Summer Ramp', status: 'ACTIVE', objective: 'LINK_CLICKS',
          spend_7d: 1200, spend_yesterday: 180, impressions_7d: 45000, reach_7d: 38000,
          clicks_7d: 620, ctr_7d: 1.38, cpm_7d: 26.7, cpc_7d: 1.94, frequency_7d: 1.18,
          primary_actions: [], anomaly: null,
        }],
        paused_campaigns: [],
        total_active_spend_7d: 1200,
        total_active_impressions_7d: 45000,
        daily_spend_series: [],
        daily_impressions_series: [],
      },
    })
    const msg = buildBriefUserMessage(input, 'green')
    // Campaign names must be prefixed with DATA:
    expect(msg).toMatch(/DATA:.*Summer Ramp/)
  })

  it('is deterministic — same input produces same output', () => {
    const input = makeMinimalInput()
    const msg1 = buildBriefUserMessage(input, 'green')
    const msg2 = buildBriefUserMessage(input, 'green')
    expect(msg1).toBe(msg2)
  })

  it('includes stale source warning when present', () => {
    const input = makeMinimalInput({
      signals: {
        ...makeMinimalInput().signals,
        has_stale_critical_source: true,
        stale_sources: ['meta_ads_daily'],
        computed_status: 'red',
      },
    })
    const msg = buildBriefUserMessage(input, 'red')
    expect(msg).toContain('STALE DATA SOURCES')
    expect(msg).toContain('meta_ads_daily')
  })

  it('includes Facebook unavailable message when fb_available is false', () => {
    const input = makeMinimalInput({
      organic: {
        ...makeMinimalInput().organic,
        fb_available: false,
      },
    })
    const msg = buildBriefUserMessage(input, 'green')
    expect(msg).toContain('Facebook page not configured')
  })

  it('does not include post-level Facebook reach/views (unavailable in v26)', () => {
    const msg = buildBriefUserMessage(makeMinimalInput(), 'green')
    // The note about unavailable metrics should be present
    expect(msg).toContain('unavailable in Graph API v26')
  })
})
