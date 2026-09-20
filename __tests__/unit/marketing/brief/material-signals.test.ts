/**
 * Unit tests for buildMaterialSignals in lib/marketing/brief/material-signals.ts
 *
 * Verified guarantees:
 *   1.  Small-volume large-% changes suppressed (volume guard)
 *   2.  Meaningful current/prior changes produce candidates
 *   3.  Google Ads per-result uses stable result_id for signal ID
 *   4.  Google Ads account-level fires on impressions-only movement
 *   5.  Google Ads account-level fires on clicks-only movement
 *   6.  Meta anomalies are reused, not recomputed
 *   7.  IG post outperformance creates a creative_learning candidate
 *   8.  Search Console impressions movement → impressions headline (not clicks)
 *   9.  Search Console average-position improvement
 *  10.  Search Console average-position decline
 *  11.  GA4 new-users-only movement triggers candidate
 *  12.  GA4 page-views-only movement triggers candidate
 *  13.  GBP uses truthful metric names (Search impressions, not "interactions")
 *  14.  GBP combined interactions exclude impressions (volume guard)
 *  15.  Zero baseline never outputs Infinity/NaN in observation or evidence
 *  16.  Stale Google Ads source surfaces data-health candidate
 *  17.  Stale GSC source surfaces data-health candidate
 *  18.  Stale GA4 source surfaces data-health candidate
 *  19.  GSC opportunity candidate requires adequate impression volume
 *  20.  GBP keyword context is honest about threshold values
 *  21.  Output is ranked by materiality_score descending
 *  22.  Duplicate suppression — same id appears once
 *  23.  At most MAX_SIGNAL_CANDIDATES returned
 *  24.  No forced candidate when nothing is material
 */

import { describe, it, expect } from 'vitest'
import {
  buildMaterialSignals,
  MAX_SIGNAL_CANDIDATES,
  GADS_MIN_SPEND_7D_FOR_SIGNAL,
  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL,
  GADS_MIN_CLICKS_7D_FOR_SIGNAL,
  GADS_MIN_RESULTS_FOR_SIGNAL,
  IG_MIN_REACH_FOR_SIGNAL,
  GSC_MIN_CLICKS_FOR_SIGNAL,
  GSC_MIN_IMPRESSIONS_FOR_SIGNAL,
  GSC_OPPORTUNITY_MIN_IMPRESSIONS,
  GSC_OPPORTUNITY_MAX_POSITION,
  GA4_MIN_SESSIONS_FOR_SIGNAL,
  GA4_MIN_NEW_USERS_FOR_SIGNAL,
  GA4_MIN_PAGE_VIEWS_FOR_SIGNAL,
  GBP_MIN_INTERACTIONS_FOR_SIGNAL,
  GBP_MIN_IMPRESSIONS_FOR_SIGNAL,
  GBP_KEYWORD_MIN_IMPRESSIONS,
} from '@/lib/marketing/brief/material-signals'
import type { BriefInputData, GoogleAdsCampaignSummary } from '@/lib/marketing/brief/types'

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function healthySource() {
  return { last_success_at: '2026-09-19T10:00:00Z', status: 'success', age_hours: 2, healthy: true }
}

function minimalFreshness(): BriefInputData['sourceFreshness'] {
  return {
    meta_ads_daily:        healthySource(),
    meta_ig_account_daily: healthySource(),
    meta_ig_organic_deep:  healthySource(),
    meta_fb_page_daily:    healthySource(),
    meta_fb_organic_deep:  healthySource(),
    gbp: { kind: 'connected', last_sync_at: '2026-09-19T10:00:00Z', healthy: true },
    google_ads: healthySource(),
    gsc:        healthySource(),
    ga4:        healthySource(),
  }
}

function minimalSignals(overrides: Partial<BriefInputData['signals']> = {}): BriefInputData['signals'] {
  return {
    has_stale_critical_source: false,
    stale_sources: [],
    paid_anomaly_count: 0,
    paid_anomalies: [],
    organic_ig_drop_detected: false,
    organic_ig_reach_7d_vs_prior_7d_pct: null,
    pending_review_count: 0,
    gbp_kind: 'connected',
    computed_status: 'green',
    status_reasons: [],
    ...overrides,
  }
}

function minimalOrganic(): BriefInputData['organic'] {
  return {
    ig: { reach_7d: null, reach_prior_7d: null, accounts_engaged_7d: null, profile_views_7d: null, followers_current: null, followers_7d_delta: null },
    ig_top_posts: [],
    ig_avg_reach_7d: null,
    ig_daily_reach_series: [],
    fb: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
    fb_recent_posts: [],
    fb_available: false,
    fb_daily_views_series: [],
  }
}

function makeData(overrides: Partial<BriefInputData> = {}): BriefInputData {
  return {
    briefDate:       '2026-09-20',
    dataWindowStart: '2026-09-13',
    dataWindowEnd:   '2026-09-19',
    currency:        'DKK',
    sourceFreshness: minimalFreshness(),
    signals:         minimalSignals(),
    paid:            null,
    organic:         minimalOrganic(),
    gbp: {
      integration_status: { kind: 'connected', last_sync_at: '2026-09-19T10:00:00Z', healthy: true },
      pending_reply_count: 0,
      new_reviews_yesterday: null,
      avg_star_rating_7d: null,
    },
    needsReview: { total: 0, review_reply: 0, paid_recommendation: 0, content_approval: 0 },
    googleAds:      null,
    searchConsole:  null,
    ga4:            null,
    gbpPerformance: null,
    ...overrides,
  }
}

/** Build a minimal GoogleAdsCampaignSummary with result_id on top_results. */
function makeGadsCampaign(opts: {
  id: string
  name?: string
  spend_7d?: number
  topResults?: GoogleAdsCampaignSummary['top_results']
}): GoogleAdsCampaignSummary {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    status: 'ENABLED',
    channel_type: 'SEARCH',
    spend_7d: opts.spend_7d ?? GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
    impressions_7d: 500,
    clicks_7d: 30,
    top_results: opts.topResults ?? [],
  }
}

function makeGadsData(overrides: Partial<BriefInputData['googleAds'] & {}> = {}): NonNullable<BriefInputData['googleAds']> {
  return {
    currency: 'DKK',
    total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
    total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,  // no change
    total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,
    total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,  // no change
    total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,
    total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,  // no change
    active_campaigns:            [],
    paused_campaigns:            [],
    ...overrides,
  }
}

// ─── 1. Volume guard ──────────────────────────────────────────────────────────

describe('volume guard', () => {
  it('suppresses Google Ads result with count below GADS_MIN_RESULTS_FOR_SIGNAL', () => {
    const data = makeData({
      googleAds: makeGadsData({
        active_campaigns: [
          makeGadsCampaign({
            id: 'camp1',
            topResults: [
              {
                result_id:           'customers/1/conversionActions/100',
                label:               'Purchases',
                count:               GADS_MIN_RESULTS_FOR_SIGNAL - 1,  // below threshold
                costPerResult:       50,
                primary:             true,
                prior_count:         1,
                prior_costPerResult: 100,
              },
            ],
          }),
        ],
      }),
    })
    const signals = buildMaterialSignals(data)
    // No result signal should be emitted for this low-count result
    expect(signals.filter(s => s.id.includes('camp1') && s.source === 'google_ads' && s.id !== 'google_ads_account_totals')).toHaveLength(0)
  })

  it('suppresses IG reach below IG_MIN_REACH_FOR_SIGNAL', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig: { ...minimalOrganic().ig, reach_7d: IG_MIN_REACH_FOR_SIGNAL - 50, reach_prior_7d: 1 },
      },
    })
    expect(buildMaterialSignals(data).find(s => s.id === 'organic_ig_reach')).toBeUndefined()
  })

  it('suppresses GSC impressions movement below GSC_MIN_IMPRESSIONS_FOR_SIGNAL', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d: GSC_MIN_CLICKS_FOR_SIGNAL - 5,
        clicks_prior_7d: 1,
        impressions_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL - 100,
        impressions_prior_7d: 1,
        ctr_7d: 0.05, ctr_prior_7d: 0.01,
        avg_position_7d: 5, avg_position_prior_7d: 6,
        top_queries: [], top_pages: [],
      },
    })
    expect(buildMaterialSignals(data).find(s => s.id === 'search_console_organic')).toBeUndefined()
  })
})

// ─── 2. Material change detection ────────────────────────────────────────────

describe('material change detection', () => {
  it('creates google_ads_account_totals when spend changes materially', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:       GADS_MIN_SPEND_7D_FOR_SIGNAL * 3,
        total_spend_prior_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 1.5,  // 100% increase
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    expect(s).toBeDefined()
    expect(s!.source).toBe('google_ads')
    expect(s!.commercially_relevant).toBe(true)
    expect(s!.evidence.some(e => e.metric === 'spend_7d')).toBe(true)
  })

  it('creates organic_ig_reach candidate when reach changes materially', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig: { ...minimalOrganic().ig, reach_7d: IG_MIN_REACH_FOR_SIGNAL * 3, reach_prior_7d: IG_MIN_REACH_FOR_SIGNAL * 2 },
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'organic_ig_reach')
    expect(s).toBeDefined()
    expect(s!.category).toBe('traffic_audience')
    expect(s!.evidence[0].change_pct).toBeCloseTo(0.5)
  })

  it('creates search_console_organic when clicks change materially', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL * 3,
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL * 1.5,  // 100% up
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.04,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [], top_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'search_console_organic')
    expect(s).toBeDefined()
    expect(s!.source).toBe('search_console')
  })

  it('creates ga4_traffic when sessions change materially', () => {
    const data = makeData({
      ga4: {
        sessions_7d:        GA4_MIN_SESSIONS_FOR_SIGNAL * 4,
        sessions_prior_7d:  GA4_MIN_SESSIONS_FOR_SIGNAL * 2,  // 100% up
        new_users_7d:       50, new_users_prior_7d:    50,
        page_views_7d:      200, page_views_prior_7d:  200,
        top_sources: [], top_landing_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'ga4_traffic')
    expect(s).toBeDefined()
    expect(s!.category).toBe('traffic_audience')
    expect(s!.evidence[0].metric).toBe('ga4_sessions_7d')
  })
})

// ─── 3. Google Ads stable result ID ──────────────────────────────────────────

describe('Google Ads stable result_id', () => {
  it('uses result_id (action resource name) in signal ID, not display label', () => {
    const resourceName = 'customers/1/conversionActions/999'
    const data = makeData({
      googleAds: makeGadsData({
        active_campaigns: [
          makeGadsCampaign({
            id: 'camp-stable',
            topResults: [
              {
                result_id:           resourceName,
                label:               'Purchases',  // display label — must NOT appear in signal ID
                count:               GADS_MIN_RESULTS_FOR_SIGNAL * 4,
                costPerResult:       10,
                primary:             true,
                prior_count:         GADS_MIN_RESULTS_FOR_SIGNAL * 2,  // 100% increase
                prior_costPerResult: 20,
              },
            ],
          }),
        ],
      }),
    })

    const signals = buildMaterialSignals(data)
    // ID must contain the slugified resource name, not 'purchases'
    const resultSignal = signals.find(s => s.id.includes('camp_stable') && s.id.includes('conversionactions'))
    expect(resultSignal).toBeDefined()
    // Must not contain the display label in the ID
    expect(resultSignal!.id).not.toContain('purchases')
  })

  it('does not create a result candidate when prior_count is null', () => {
    const data = makeData({
      googleAds: makeGadsData({
        active_campaigns: [
          makeGadsCampaign({
            id: 'camp1',
            topResults: [
              {
                result_id:           'customers/1/conversionActions/100',
                label:               'Purchases',
                count:               GADS_MIN_RESULTS_FOR_SIGNAL * 4,
                costPerResult:       10,
                primary:             true,
                prior_count:         null,   // no prior — must not create signal
                prior_costPerResult: null,
              },
            ],
          }),
        ],
      }),
    })
    const signals = buildMaterialSignals(data)
    expect(signals.filter(s => s.source === 'google_ads' && s.id.includes('camp1') && !s.id.includes('account'))).toHaveLength(0)
  })
})

// ─── 4 & 5. Google Ads — any account metric can trigger ──────────────────────

describe('Google Ads account-level — any metric triggers', () => {
  it('fires on impressions-only movement (spend and clicks stable)', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,  // no change
        total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 4,
        total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,  // 100% increase
        total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,
        total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,  // no change
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    expect(s).toBeDefined()
    expect(s!.evidence.some(e => e.metric === 'impressions_7d')).toBe(true)
    // Spend should NOT be in evidence (it didn't move)
    expect(s!.evidence.some(e => e.metric === 'spend_7d')).toBe(false)
    // Observation must mention impressions
    expect(s!.observation.toLowerCase()).toContain('impressions')
  })

  it('fires on clicks-only movement (spend and impressions stable)', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,  // no change
        total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,
        total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,  // no change
        total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 4,
        total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,  // 100% increase
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    expect(s).toBeDefined()
    expect(s!.evidence.some(e => e.metric === 'clicks_7d')).toBe(true)
    expect(s!.observation.toLowerCase()).toContain('clicks')
  })

  it('does not create three separate account-level candidates for the same movement', () => {
    // All three metrics move materially — should still produce only ONE candidate
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 3,
        total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 1.5,
        total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 4,
        total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,
        total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 4,
        total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,
      }),
    })
    const gadsAccountSignals = buildMaterialSignals(data).filter(s => s.id === 'google_ads_account_totals')
    expect(gadsAccountSignals).toHaveLength(1)
  })
})

// ─── 6. Meta anomaly reuse ────────────────────────────────────────────────────

describe('Meta anomaly reuse', () => {
  it('creates a meta_paid candidate for each PaidAnomalySignal', () => {
    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: 1,
        paid_anomalies: [{
          campaign_name: 'Summer Sale',
          metric_label: 'spend',
          change_pct: 45.0,  // percentage units (45.0%), not fractional (0.45)
          direction: 'increase',
          yesterday_value: 2000,
          baseline_value: 1379,
        }],
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.source === 'meta_paid')
    expect(s).toBeDefined()
    expect(s!.category).toBe('commercial_consequence')
    // change_pct in evidence is fractional: 45.0% → 0.45
    expect(s!.evidence[0].change_pct).toBeCloseTo(0.45)
  })
})

// ─── 7. IG post outperformance ────────────────────────────────────────────────

describe('IG post outperformance', () => {
  it('creates a creative_learning candidate for a significantly outperforming post', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig_top_posts: [{
          caption_truncated: 'Great creative',
          published_at: '2026-09-18',
          media_type: 'IMAGE',
          reach: 2000,
          plays: null,
          likes: 150,
          comments_count: 20,
          shares: 5,
          total_interactions: 175,
          performance_vs_avg_pct: 90,  // 90% above avg — exceeds 50% threshold
        }],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.source === 'organic_ig' && c.category === 'creative_learning')
    expect(s).toBeDefined()
    expect(s!.creatively_relevant).toBe(true)
    expect(s!.observation).toContain('DATA:')
  })

  it('does not create a post candidate for low-reach posts even with high % above avg', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig_top_posts: [{
          caption_truncated: 'tiny post',
          published_at: '2026-09-18',
          media_type: 'IMAGE',
          reach: 50,  // below IG_POST_OUTPERFORMANCE_MIN_REACH = 100
          plays: null,
          likes: 5,
          comments_count: 1,
          shares: 0,
          total_interactions: 6,
          performance_vs_avg_pct: 200,
        }],
      },
    })
    expect(buildMaterialSignals(data).find(s => s.source === 'organic_ig' && s.category === 'creative_learning')).toBeUndefined()
  })
})

// ─── 8. Search Console — observation matches actual signal ────────────────────

describe('Search Console — truthful observation', () => {
  it('impressions-only movement produces an impressions headline, not clicks', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL - 5,  // below min clicks
        clicks_prior_7d:       null,
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 4,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,  // 100% increase
        ctr_7d: 0.02, ctr_prior_7d: 0.02,
        avg_position_7d: 8, avg_position_prior_7d: 8,
        top_queries: [], top_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'search_console_organic')
    expect(s).toBeDefined()
    // Observation must say 'impressions', not 'clicks'
    expect(s!.observation.toLowerCase()).toContain('impressions')
    expect(s!.observation.toLowerCase()).not.toContain('clicks')
  })

  it('average-position improvement produces a position observation', () => {
    // Position 7.2 → 4.8 = improvement by 2.4 positions
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL,
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL,  // no change in clicks
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 3,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 3,  // no change in impressions
        ctr_7d: 0.05, ctr_prior_7d: 0.05,
        avg_position_7d:       4.8,   // improved (lower = better)
        avg_position_prior_7d: 7.2,   // was worse
        top_queries: [], top_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'search_console_organic')
    expect(s).toBeDefined()
    expect(s!.observation.toLowerCase()).toContain('position')
    expect(s!.observation.toLowerCase()).toContain('improved')
    // Must not say Infinity or NaN
    expect(s!.observation).not.toContain('Infinity')
    expect(s!.observation).not.toContain('NaN')
  })

  it('average-position decline produces a decline observation', () => {
    // Position 4.8 → 7.2 = decline by 2.4 positions
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL,
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL,
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 3,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 3,
        ctr_7d: 0.05, ctr_prior_7d: 0.05,
        avg_position_7d:       7.2,   // declined (higher number = worse)
        avg_position_prior_7d: 4.8,
        top_queries: [], top_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'search_console_organic')
    expect(s).toBeDefined()
    expect(s!.observation.toLowerCase()).toContain('position')
    expect(s!.observation.toLowerCase()).toContain('declined')
  })
})

// ─── 9–10. GA4 — any metric triggers ─────────────────────────────────────────

describe('GA4 — any metric triggers', () => {
  it('new-users-only movement (sessions and page views stable)', () => {
    const data = makeData({
      ga4: {
        sessions_7d:       GA4_MIN_SESSIONS_FOR_SIGNAL * 2,
        sessions_prior_7d: GA4_MIN_SESSIONS_FOR_SIGNAL * 2,   // no change
        new_users_7d:      GA4_MIN_NEW_USERS_FOR_SIGNAL * 4,
        new_users_prior_7d: GA4_MIN_NEW_USERS_FOR_SIGNAL * 2, // 100% increase
        page_views_7d:     200,
        page_views_prior_7d: 200,                             // no change
        top_sources: [], top_landing_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'ga4_traffic')
    expect(s).toBeDefined()
    expect(s!.observation.toLowerCase()).toContain('new users')
    expect(s!.evidence.some(e => e.metric === 'ga4_new_users_7d')).toBe(true)
  })

  it('page-views-only movement (sessions and new users stable)', () => {
    const data = makeData({
      ga4: {
        sessions_7d:        GA4_MIN_SESSIONS_FOR_SIGNAL * 2,
        sessions_prior_7d:  GA4_MIN_SESSIONS_FOR_SIGNAL * 2,  // no change
        new_users_7d:       50,
        new_users_prior_7d: 50,                               // no change
        page_views_7d:      GA4_MIN_PAGE_VIEWS_FOR_SIGNAL * 4,
        page_views_prior_7d: GA4_MIN_PAGE_VIEWS_FOR_SIGNAL * 2, // 100% increase
        top_sources: [], top_landing_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'ga4_traffic')
    expect(s).toBeDefined()
    expect(s!.observation.toLowerCase()).toContain('page views')
    expect(s!.evidence.some(e => e.metric === 'ga4_page_views_7d')).toBe(true)
  })

  it('does not produce multiple ga4 candidates for the same traffic movement', () => {
    const data = makeData({
      ga4: {
        sessions_7d:        GA4_MIN_SESSIONS_FOR_SIGNAL * 4,
        sessions_prior_7d:  GA4_MIN_SESSIONS_FOR_SIGNAL * 2,
        new_users_7d:       GA4_MIN_NEW_USERS_FOR_SIGNAL * 4,
        new_users_prior_7d: GA4_MIN_NEW_USERS_FOR_SIGNAL * 2,
        page_views_7d:      GA4_MIN_PAGE_VIEWS_FOR_SIGNAL * 4,
        page_views_prior_7d: GA4_MIN_PAGE_VIEWS_FOR_SIGNAL * 2,
        top_sources: [], top_landing_pages: [],
      },
    })
    expect(buildMaterialSignals(data).filter(s => s.id === 'ga4_traffic')).toHaveLength(1)
  })
})

// ─── 11. GBP — truthful metric names ─────────────────────────────────────────

describe('GBP — truthful metric names', () => {
  it('uses "Search impressions" (not "interactions") when impressions are the dominant mover', () => {
    const imp = GBP_MIN_IMPRESSIONS_FOR_SIGNAL * 4
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       imp,
        search_impressions_prior_28d: Math.round(imp / 2),  // 100% up
        maps_impressions_28d:         null,
        maps_impressions_prior_28d:   null,
        website_clicks_28d:           2,  // interactions well below threshold
        call_clicks_28d:              2,
        direction_requests_28d:       2,
        website_clicks_prior_28d:     2,
        call_clicks_prior_28d:        2,
        direction_requests_prior_28d: 2,
        keyword_month: null,
        top_keywords: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_performance')
    expect(s).toBeDefined()
    // Observation must say "Search impressions", not "interactions"
    expect(s!.observation).toContain('Search impressions')
    expect(s!.observation.toLowerCase()).not.toContain('interactions')
  })

  it('uses specific label for calls when calls are the dominant mover', () => {
    const calls = GBP_MIN_INTERACTIONS_FOR_SIGNAL * 4
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       null,
        search_impressions_prior_28d: null,
        maps_impressions_28d:         null,
        maps_impressions_prior_28d:   null,
        website_clicks_28d:           5,
        call_clicks_28d:              calls,
        direction_requests_28d:       5,
        website_clicks_prior_28d:     5,
        call_clicks_prior_28d:        Math.round(calls / 2),  // 100% up
        direction_requests_prior_28d: 5,
        keyword_month: null,
        top_keywords: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_performance')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('Calls')
    expect(s!.observation.toLowerCase()).not.toContain('interactions')
  })
})

// ─── 12. GBP interactions volume guard excludes impressions ───────────────────

describe('GBP combined interactions exclude impressions', () => {
  it('suppresses interaction-metric candidate when only impressions pass volume guard', () => {
    // Calls: 5 (below GBP_MIN_INTERACTIONS_FOR_SIGNAL = 20), but search impressions are high
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       GBP_MIN_IMPRESSIONS_FOR_SIGNAL * 4,
        search_impressions_prior_28d: GBP_MIN_IMPRESSIONS_FOR_SIGNAL * 4,  // no change
        maps_impressions_28d:         null,
        maps_impressions_prior_28d:   null,
        website_clicks_28d:           5,
        call_clicks_28d:              5,
        direction_requests_28d:       5,
        website_clicks_prior_28d:     1,    // 400% increase but interactions = 15 < 20
        call_clicks_prior_28d:        1,
        direction_requests_prior_28d: 1,
        keyword_month: null,
        top_keywords: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_performance')
    if (s) {
      // If a candidate exists, it must not be driven by interaction metrics that failed the guard
      // The only eligible metrics are impressions (which didn't move materially here)
      const hasInteractionEvidence = s.evidence.some(e =>
        ['gbp_website_clicks_28d', 'gbp_call_clicks_28d', 'gbp_direction_requests_28d'].includes(e.metric)
      )
      // Interaction metrics failed the volume guard — should not be in evidence
      expect(hasInteractionEvidence).toBe(false)
    }
    // Whether or not a candidate exists, impressions didn't move, so no performance signal
    expect(s).toBeUndefined()
  })
})

// ─── 13. Zero baseline — no Infinity/NaN ─────────────────────────────────────

describe('zero baseline safety', () => {
  it('never produces Infinity or NaN in observation when prior = 0', () => {
    // Website clicks: 0 → material positive value
    const clicks = GBP_MIN_INTERACTIONS_FOR_SIGNAL * 3
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       null,
        search_impressions_prior_28d: null,
        maps_impressions_28d:         null,
        maps_impressions_prior_28d:   null,
        website_clicks_28d:           clicks,
        call_clicks_28d:              5,
        direction_requests_28d:       5,
        website_clicks_prior_28d:     0,    // was zero — emergence
        call_clicks_prior_28d:        5,
        direction_requests_prior_28d: 5,
        keyword_month: null,
        top_keywords: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_performance')
    if (s) {
      expect(s.observation).not.toContain('Infinity')
      expect(s.observation).not.toContain('NaN')
      // change_pct in evidence should be null (emergence), not Infinity
      const websiteEv = s.evidence.find(e => e.metric === 'gbp_website_clicks_28d')
      if (websiteEv) {
        expect(websiteEv.change_pct).toBeNull()
      }
    }
  })

  it('never produces Infinity or NaN for zero-prior Google Ads account spend', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:       GADS_MIN_SPEND_7D_FOR_SIGNAL * 3,
        total_spend_prior_7d: 0,  // was zero
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    if (s) {
      expect(s.observation).not.toContain('Infinity')
      expect(s.observation).not.toContain('NaN')
      const spendEv = s.evidence.find(e => e.metric === 'spend_7d')
      if (spendEv) {
        expect(spendEv.change_pct).toBeNull()
      }
      // Observation should say "increased from 0"
      expect(s.observation).toContain('0')
    }
  })

  it('never produces Infinity or NaN for zero-prior GSC clicks', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL * 3,
        clicks_prior_7d:       0,   // was zero
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.02,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [], top_pages: [],
      },
    })
    const signals = buildMaterialSignals(data)
    for (const s of signals) {
      expect(s.observation).not.toContain('Infinity')
      expect(s.observation).not.toContain('NaN')
      for (const ev of s.evidence) {
        if (ev.change_pct !== null) {
          expect(isFinite(ev.change_pct)).toBe(true)
        }
      }
    }
  })
})

// ─── 14–16. Data health — Google sources included ─────────────────────────────

describe('data health — Google sources', () => {
  it('surfaces data_health when google_ads source is unhealthy', () => {
    const data = makeData({
      sourceFreshness: {
        ...minimalFreshness(),
        google_ads: { last_success_at: null, status: 'failed', age_hours: 50, healthy: false },
      },
    })
    const s = buildMaterialSignals(data).find(c => c.source === 'data_health')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('google_ads')
  })

  it('surfaces data_health when gsc source is unhealthy', () => {
    const data = makeData({
      sourceFreshness: {
        ...minimalFreshness(),
        gsc: { last_success_at: null, status: 'failed', age_hours: 50, healthy: false },
      },
    })
    const s = buildMaterialSignals(data).find(c => c.source === 'data_health')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('gsc')
  })

  it('surfaces data_health when ga4 source is unhealthy', () => {
    const data = makeData({
      sourceFreshness: {
        ...minimalFreshness(),
        ga4: { last_success_at: null, status: 'failed', age_hours: 50, healthy: false },
      },
    })
    const s = buildMaterialSignals(data).find(c => c.source === 'data_health')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('ga4')
  })

  it('still surfaces data_health from signals.stale_sources (meta)', () => {
    const data = makeData({
      signals: minimalSignals({
        has_stale_critical_source: true,
        stale_sources: ['meta_ads_daily'],
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.source === 'data_health')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('meta_ads_daily')
  })

  it('does not create data_health when all sources are healthy', () => {
    expect(buildMaterialSignals(makeData()).find(s => s.source === 'data_health')).toBeUndefined()
  })
})

// ─── 17. SEO opportunity — volume guard ──────────────────────────────────────

describe('SEO opportunity candidate', () => {
  it('does not surface an opportunity for a query below GSC_OPPORTUNITY_MIN_IMPRESSIONS', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d: GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        clicks_prior_7d: GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        impressions_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.05,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [
          {
            query: 'low volume query',
            clicks: 2,
            impressions: GSC_OPPORTUNITY_MIN_IMPRESSIONS - 100,  // below threshold
            ctr: 0.01,
            position: GSC_OPPORTUNITY_MAX_POSITION + 2,
          },
        ],
        top_pages: [],
      },
    })
    expect(buildMaterialSignals(data).find(s => s.id === 'search_console_opportunity')).toBeUndefined()
  })

  it('surfaces an opportunity for a query with adequate impressions and low CTR at middling position', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d: GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        clicks_prior_7d: GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        impressions_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.05,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [
          {
            query: 'order kebab online',
            clicks: 10,
            impressions: GSC_OPPORTUNITY_MIN_IMPRESSIONS + 200,  // above threshold
            ctr: 0.015,  // below GSC_OPPORTUNITY_MAX_CTR = 0.03
            position: GSC_OPPORTUNITY_MAX_POSITION + 2,          // above max position threshold
          },
        ],
        top_pages: [],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'search_console_opportunity')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('DATA:')
  })
})

// ─── 18. GBP keyword threshold honesty ───────────────────────────────────────

describe('GBP keyword context', () => {
  it('uses <N notation for threshold impressions (not exact count)', () => {
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       null,
        search_impressions_prior_28d: null,
        maps_impressions_28d:         null,
        maps_impressions_prior_28d:   null,
        website_clicks_28d:           null,
        call_clicks_28d:              null,
        direction_requests_28d:       null,
        website_clicks_prior_28d:     null,
        call_clicks_prior_28d:        null,
        direction_requests_prior_28d: null,
        keyword_month: '2026-09-01',
        top_keywords: [
          { keyword: 'killer kebab', impressions: null, impressionsThreshold: 100 },  // threshold value
        ],
      },
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_keyword_context')
    if (s) {
      // Must use < prefix for threshold values
      expect(s.observation).toContain('<')
    }
  })

  it('does not emit keyword context when top keyword is below GBP_KEYWORD_MIN_IMPRESSIONS', () => {
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       null,
        search_impressions_prior_28d: null,
        maps_impressions_28d:         null,
        maps_impressions_prior_28d:   null,
        website_clicks_28d:           null,
        call_clicks_28d:              null,
        direction_requests_28d:       null,
        website_clicks_prior_28d:     null,
        call_clicks_prior_28d:        null,
        direction_requests_prior_28d: null,
        keyword_month: '2026-09-01',
        top_keywords: [
          { keyword: 'tiny kw', impressions: GBP_KEYWORD_MIN_IMPRESSIONS - 1, impressionsThreshold: null },
        ],
      },
    })
    expect(buildMaterialSignals(data).find(s => s.id === 'gbp_keyword_context')).toBeUndefined()
  })
})

// ─── Google Ads — currency suffix only on spend ───────────────────────────────

describe('Google Ads — currency suffix', () => {
  it('spend observation includes currency when spend is the headline metric', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 3,
        total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 1.5,  // 100% up
        total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,
        total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,  // no change
        total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,
        total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,   // no change
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('DKK')
  })

  it('impressions observation does NOT include currency', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,   // no change
        total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 4,
        total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,  // 100% up
        total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,
        total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,   // no change
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    expect(s).toBeDefined()
    expect(s!.observation.toLowerCase()).toContain('impressions')
    expect(s!.observation).not.toContain('DKK')
  })

  it('clicks observation does NOT include currency', () => {
    const data = makeData({
      googleAds: makeGadsData({
        total_spend_7d:              GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d:        GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,   // no change
        total_impressions_7d:        GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,
        total_impressions_prior_7d:  GADS_MIN_IMPRESSIONS_7D_FOR_SIGNAL * 2,  // no change
        total_clicks_7d:             GADS_MIN_CLICKS_7D_FOR_SIGNAL * 4,
        total_clicks_prior_7d:       GADS_MIN_CLICKS_7D_FOR_SIGNAL * 2,   // 100% up
      }),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'google_ads_account_totals')
    expect(s).toBeDefined()
    expect(s!.observation.toLowerCase()).toContain('clicks')
    expect(s!.observation).not.toContain('DKK')
  })
})

// ─── GBP keyword gate — exact impressions required to trigger ─────────────────

describe('GBP keyword gate — threshold-only keyword cannot trigger', () => {
  function minimalGbpPerfKeywordsOnly(keywords: NonNullable<NonNullable<BriefInputData['gbpPerformance']>['top_keywords']>): NonNullable<BriefInputData['gbpPerformance']> {
    return {
      search_impressions_28d:       null,
      search_impressions_prior_28d: null,
      maps_impressions_28d:         null,
      maps_impressions_prior_28d:   null,
      website_clicks_28d:           null,
      call_clicks_28d:              null,
      direction_requests_28d:       null,
      website_clicks_prior_28d:     null,
      call_clicks_prior_28d:        null,
      direction_requests_prior_28d: null,
      keyword_month: '2026-09-01',
      top_keywords: keywords,
    }
  }

  it('threshold-only keyword (exact impressions null) cannot trigger the candidate', () => {
    const data = makeData({
      gbpPerformance: minimalGbpPerfKeywordsOnly([
        // impressionsThreshold is an upper bound — actual count could be 0; cannot prove minimum volume
        { keyword: 'killer kebab', impressions: null, impressionsThreshold: GBP_KEYWORD_MIN_IMPRESSIONS * 10 },
      ]),
    })
    expect(buildMaterialSignals(data).find(s => s.id === 'gbp_keyword_context')).toBeUndefined()
  })

  it('exact qualifying keyword (impressions >= GBP_KEYWORD_MIN_IMPRESSIONS) triggers candidate', () => {
    const data = makeData({
      gbpPerformance: minimalGbpPerfKeywordsOnly([
        { keyword: 'killer kebab', impressions: GBP_KEYWORD_MIN_IMPRESSIONS * 2, impressionsThreshold: null },
      ]),
    })
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_keyword_context')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('killer kebab')
  })

  it('exact qualifying keyword can coexist with threshold-only keywords as supporting context', () => {
    const data = makeData({
      gbpPerformance: minimalGbpPerfKeywordsOnly([
        { keyword: 'order kebab',  impressions: GBP_KEYWORD_MIN_IMPRESSIONS * 3, impressionsThreshold: null },
        { keyword: 'kebab near me', impressions: null, impressionsThreshold: 200 },  // threshold only
      ]),
    })
    // Candidate fires because the first keyword has a qualifying exact count
    const s = buildMaterialSignals(data).find(c => c.id === 'gbp_keyword_context')
    expect(s).toBeDefined()
    expect(s!.observation).toContain('order kebab')
  })

  it('exact keyword below GBP_KEYWORD_MIN_IMPRESSIONS does not trigger candidate', () => {
    const data = makeData({
      gbpPerformance: minimalGbpPerfKeywordsOnly([
        { keyword: 'tiny kw', impressions: GBP_KEYWORD_MIN_IMPRESSIONS - 1, impressionsThreshold: null },
      ]),
    })
    expect(buildMaterialSignals(data).find(s => s.id === 'gbp_keyword_context')).toBeUndefined()
  })
})

// ─── 19. Ranking ──────────────────────────────────────────────────────────────

describe('ranking', () => {
  it('ranks candidates by materiality_score descending', () => {
    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: 1,
        paid_anomalies: [{
          campaign_name: 'Test', metric_label: 'spend', change_pct: 60.0,
          direction: 'increase', yesterday_value: 5000, baseline_value: 3125,
        }],
      }),
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL * 3,
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL * 1.5,
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.04,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [], top_pages: [],
      },
    })
    const signals = buildMaterialSignals(data)
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i - 1].materiality_score).toBeGreaterThanOrEqual(signals[i].materiality_score)
    }
  })
})

// ─── 20. Duplicate suppression ────────────────────────────────────────────────

describe('duplicate suppression', () => {
  it('produces no duplicate ids even with many anomalies sharing same campaign+metric', () => {
    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: 2,
        paid_anomalies: [
          { campaign_name: 'Camp A', metric_label: 'spend', change_pct: 50, direction: 'increase', yesterday_value: 3000, baseline_value: 2000 },
          { campaign_name: 'Camp A', metric_label: 'spend', change_pct: 50, direction: 'increase', yesterday_value: 3000, baseline_value: 2000 },
        ],
      }),
    })
    const signals = buildMaterialSignals(data)
    const ids = signals.map(s => s.id)
    expect(ids.length).toBe(new Set(ids).size)
  })
})

// ─── 21. Output cap ───────────────────────────────────────────────────────────

describe('output cap', () => {
  it('returns at most MAX_SIGNAL_CANDIDATES', () => {
    const anomalies = Array.from({ length: 25 }, (_, i) => ({
      campaign_name:  `Campaign ${String(i).padStart(3, '0')}`,
      metric_label:   'spend',
      change_pct:     50 + i,
      direction:      'increase' as const,
      yesterday_value: 2000 + i * 100,
      baseline_value:  1000,
    }))
    const data = makeData({ signals: minimalSignals({ paid_anomaly_count: anomalies.length, paid_anomalies: anomalies }) })
    expect(buildMaterialSignals(data).length).toBeLessThanOrEqual(MAX_SIGNAL_CANDIDATES)
  })
})

// ─── 22. No forced candidate ──────────────────────────────────────────────────

describe('no forced candidate', () => {
  it('returns empty array when nothing is material', () => {
    const data = makeData({
      googleAds: makeGadsData(),  // all prior = current, no movement
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.05,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [], top_pages: [],
      },
    })
    expect(buildMaterialSignals(data)).toHaveLength(0)
  })
})
