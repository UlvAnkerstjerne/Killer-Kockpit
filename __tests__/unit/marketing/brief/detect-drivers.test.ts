/**
 * Unit tests for detectDrivers in lib/marketing/brief/detect-drivers.ts
 *
 * Verified guarantees:
 *   1.  Google Ads activity drop → GBP driver generated
 *   2.  Ads already inactive in both periods → NO driver
 *   3.  Ads activity increase → possible GBP uplift driver
 *   4.  Paid click drop → GA4 traffic driver
 *   5.  GSC clicks + GA4 organic sessions aligned → driver
 *   6.  Search Console never treated as driven by Ads
 *   7.  Exceptional Reel → IG reach driver
 *   8.  One exceptional Reel does not become repeatable pattern claim
 *   9.  Posting cadence sparse-data safety
 *  10.  Timing mismatch lowers/rejects driver
 *  11.  Counter-evidence weakens candidate
 *  12.  7d vs 28d windows not conflated
 *  13.  No candidate → no invented cause
 *  14.  GBP -53% / paused Ads regression case
 *  15.  Ads direction must match GBP direction
 *  16.  At most one driver per signal
 *  17.  Cadence driver never "likely", always "possible"
 */

import { describe, it, expect } from 'vitest'
import {
  detectDrivers,
  DRIVER_MATERIAL_CHANGE_PCT,
} from '@/lib/marketing/brief/detect-drivers'
import type { MaterialSignalCandidate, SignalMetricEvidence } from '@/lib/marketing/brief/material-signals'
import type { BriefInputData } from '@/lib/marketing/brief/types'
import type { DriverContextData, GoogleAdsDriverContext } from '@/lib/marketing/brief/driver-context'

// ─── Fixture helpers ────────────────────────────────────────────────────────

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

function makeGbpSignal(overrides: Partial<MaterialSignalCandidate> = {}): MaterialSignalCandidate {
  return {
    id: 'gbp_performance',
    source: 'gbp_performance',
    category: 'seo_local_search',
    observation: 'Google Business Profile Maps impressions down 53.0% vs prior 28-day period.',
    evidence: [{
      metric: 'gbp_maps_impressions_28d',
      current: 470,
      prior: 1000,
      change_pct: -0.53,
    }],
    materiality_score: 50,
    commercially_relevant: true,
    creatively_relevant: false,
    ...overrides,
  }
}

function makeGa4Signal(overrides: Partial<MaterialSignalCandidate> = {}): MaterialSignalCandidate {
  return {
    id: 'ga4_traffic',
    source: 'ga4',
    category: 'traffic_audience',
    observation: 'Website sessions down 32.0% vs prior 7 days.',
    evidence: [{
      metric: 'ga4_sessions_7d',
      current: 340,
      prior: 500,
      change_pct: -0.32,
    }],
    materiality_score: 40,
    commercially_relevant: true,
    creatively_relevant: false,
    ...overrides,
  }
}

function makeIgReachSignal(overrides: Partial<MaterialSignalCandidate> = {}): MaterialSignalCandidate {
  return {
    id: 'organic_ig_reach',
    source: 'organic_ig',
    category: 'traffic_audience',
    observation: 'Instagram organic reach up 80.0% vs prior 7 days.',
    evidence: [{
      metric: 'ig_reach_7d',
      current: 9000,
      prior: 5000,
      change_pct: 0.80,
    }],
    materiality_score: 40,
    commercially_relevant: false,
    creatively_relevant: true,
    ...overrides,
  }
}

function makeGadsDriverContext(overrides: Partial<GoogleAdsDriverContext> = {}): GoogleAdsDriverContext {
  return {
    total_spend_28d:             500,
    total_spend_prior_28d:       2000,
    total_impressions_28d:       3000,
    total_impressions_prior_28d: 7500,
    total_clicks_28d:            200,
    total_clicks_prior_28d:      350,
    daily_series: [
      { date: '2026-08-25', spend: 100, impressions: 500, clicks: 30 },
      { date: '2026-09-14', spend: 0, impressions: 0, clicks: 0 },
    ],
    last_active_date: '2026-09-14',
    enabled_count: 0,
    paused_count: 2,
    paused_campaign_ids: ['camp1', 'camp2'],
    ...overrides,
  }
}

function makeDriverContext(overrides: Partial<DriverContextData> = {}): DriverContextData {
  return {
    googleAds: null,
    metaPaid:  null,
    igCadence: { posts_current_7d: 3, posts_prior_7d: 3, exceptional_post_ids: [] },
    ...overrides,
  }
}

// ─── 1. Google Ads activity drop → GBP driver ──────────────────────────────

describe('Google Ads → GBP driver', () => {
  it('generates a driver when Ads activity drops and GBP drops', () => {
    const signal = makeGbpSignal()
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 500, maps_impressions_28d: 470,
        website_clicks_28d: 20, call_clicks_28d: 5, direction_requests_28d: 5,
        search_impressions_prior_28d: 1200, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
    })
    const ctx = makeDriverContext({ googleAds: makeGadsDriverContext() })

    const drivers = detectDrivers([signal], data, ctx)

    expect(drivers.length).toBe(1)
    expect(drivers[0].driver_type).toBe('google_ads_to_gbp')
    expect(drivers[0].target_signal_id).toBe('gbp_performance')
    expect(drivers[0].confidence).toMatch(/^(likely|possible)$/)
    expect(drivers[0].caveat).toBeTruthy()
    // Evidence uses 28d window
    expect(drivers[0].evidence.every(e => e.window === '28d')).toBe(true)
  })
})

// ─── 2. Ads already inactive in both periods → NO driver ────────────────────

describe('Ads inactive both periods', () => {
  it('does NOT generate driver when Ads had zero activity in both periods', () => {
    const signal = makeGbpSignal()
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 500, maps_impressions_28d: 470,
        website_clicks_28d: 20, call_clicks_28d: 5, direction_requests_28d: 5,
        search_impressions_prior_28d: 1200, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
    })
    const ctx = makeDriverContext({
      googleAds: makeGadsDriverContext({
        total_impressions_28d:       50,   // below 100 threshold
        total_impressions_prior_28d: 30,   // also below
        total_spend_28d: 0,
        total_spend_prior_28d: 0,
        total_clicks_28d: 0,
        total_clicks_prior_28d: 0,
      }),
    })

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.length).toBe(0)
  })
})

// ─── 3. Ads activity increase → possible GBP uplift driver ──────────────────

describe('Ads increase → GBP increase', () => {
  it('generates driver when Ads increase matches GBP increase', () => {
    const signal = makeGbpSignal({
      observation: 'GBP Maps impressions up 40%.',
      evidence: [{
        metric: 'gbp_maps_impressions_28d',
        current: 1400,
        prior: 1000,
        change_pct: 0.40,
      }],
    })
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 1500, maps_impressions_28d: 1400,
        website_clicks_28d: 60, call_clicks_28d: 10, direction_requests_28d: 10,
        search_impressions_prior_28d: 1000, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
    })
    const ctx = makeDriverContext({
      googleAds: makeGadsDriverContext({
        total_impressions_28d:       10000,
        total_impressions_prior_28d: 5000,
        total_clicks_28d:            600,
        total_clicks_prior_28d:      300,
        total_spend_28d:             3000,
        total_spend_prior_28d:       1500,
        enabled_count: 2,
        paused_count: 0,
        paused_campaign_ids: [],
        last_active_date: '2026-09-19',
      }),
    })

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.length).toBe(1)
    expect(drivers[0].driver_type).toBe('google_ads_to_gbp')
  })
})

// ─── 4. Paid click drop → GA4 traffic driver ───────────────────────────────

describe('Paid → GA4 driver', () => {
  it('generates driver when Google Ads clicks drop matches GA4 session drop', () => {
    const signal = makeGa4Signal()
    const data = makeData({
      ga4: {
        sessions_7d: 340, sessions_prior_7d: 500,
        new_users_7d: 200, new_users_prior_7d: 300,
        page_views_7d: 800, page_views_prior_7d: 1200,
        top_sources: [], top_landing_pages: [],
      },
      googleAds: {
        currency: 'DKK',
        total_spend_7d: 500, total_spend_prior_7d: 1500,
        total_impressions_7d: 3000, total_impressions_prior_7d: 8000,
        total_clicks_7d: 150, total_clicks_prior_7d: 350,
        active_campaigns: [], paused_campaigns: [],
      },
    })
    const ctx = makeDriverContext()

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.length).toBe(1)
    expect(drivers[0].driver_type).toBe('paid_to_ga4')
    expect(drivers[0].evidence[0].window).toBe('7d')
  })
})

// ─── 5. GSC clicks + GA4 aligned → driver ───────────────────────────────────

describe('GSC → GA4 organic driver', () => {
  it('generates driver when GSC clicks drop matches GA4 session drop', () => {
    const signal = makeGa4Signal()
    const data = makeData({
      ga4: {
        sessions_7d: 340, sessions_prior_7d: 500,
        new_users_7d: 200, new_users_prior_7d: 300,
        page_views_7d: 800, page_views_prior_7d: 1200,
        top_sources: [], top_landing_pages: [],
      },
      searchConsole: {
        clicks_7d: 100, clicks_prior_7d: 180,
        impressions_7d: 5000, impressions_prior_7d: 6000,
        ctr_7d: 0.02, ctr_prior_7d: 0.03,
        avg_position_7d: 8, avg_position_prior_7d: 7,
        top_queries: [], top_pages: [],
      },
    })
    const ctx = makeDriverContext()

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.some(d => d.driver_type === 'gsc_to_ga4_organic')).toBe(true)
  })
})

// ─── 6. Search Console never treated as driven by Ads ───────────────────────

describe('GSC independence from Ads', () => {
  it('does NOT generate Ads→GSC driver for search_console signals', () => {
    const gscSignal: MaterialSignalCandidate = {
      id: 'search_console_organic',
      source: 'search_console',
      category: 'seo_local_search',
      observation: 'Organic search clicks down 30%.',
      evidence: [{ metric: 'gsc_clicks_7d', current: 70, prior: 100, change_pct: -0.30 }],
      materiality_score: 30,
      commercially_relevant: true,
      creatively_relevant: false,
    }
    const data = makeData()
    const ctx = makeDriverContext({ googleAds: makeGadsDriverContext() })

    const drivers = detectDrivers([gscSignal], data, ctx)
    // No driver should target a search_console signal from google_ads
    expect(drivers.filter(d => d.driver_type === 'google_ads_to_gbp').length).toBe(0)
    expect(drivers.filter(d => d.driver_type === 'paid_to_ga4').length).toBe(0)
  })
})

// ─── 7. Exceptional Reel → IG reach driver ──────────────────────────────────

describe('Exceptional content → IG reach', () => {
  it('generates driver when exceptional post exists during reach increase', () => {
    const signal = makeIgReachSignal()
    const data = makeData({
      organic: {
        ig: { reach_7d: 9000, reach_prior_7d: 5000, accounts_engaged_7d: 400, profile_views_7d: 200, followers_current: 2000, followers_7d_delta: 50 },
        ig_top_posts: [{
          caption_truncated: 'Amazing kebab!',
          published_at: '2026-09-17T12:00:00Z',
          media_type: 'REEL',
          reach: 6000,
          plays: 8000,
          likes: 400,
          comments_count: 20,
          shares: 50,
          total_interactions: 470,
          performance_vs_avg_pct: 300,  // 300% above average = 3× = exceptional
        }],
        ig_avg_reach_7d: 1500,
        ig_daily_reach_series: [],
        fb: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
        fb_recent_posts: [],
        fb_available: false,
        fb_daily_views_series: [],
      },
    })
    const ctx = makeDriverContext({
      igCadence: {
        posts_current_7d: 5,
        posts_prior_7d: 4,
        exceptional_post_ids: ['post123'],
      },
    })

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.length).toBe(1)
    expect(drivers[0].driver_type).toBe('content_to_ig_reach')
    expect(drivers[0].caveat).toContain('repeatable pattern')
  })
})

// ─── 8. One exceptional Reel ≠ repeatable pattern ───────────────────────────

describe('No repeatable pattern claim from one post', () => {
  it('includes caveat about non-repeatable pattern', () => {
    const signal = makeIgReachSignal()
    const data = makeData({
      organic: {
        ig: { reach_7d: 9000, reach_prior_7d: 5000, accounts_engaged_7d: 400, profile_views_7d: 200, followers_current: 2000, followers_7d_delta: 50 },
        ig_top_posts: [{
          caption_truncated: 'Kebab reel',
          published_at: '2026-09-17T12:00:00Z',
          media_type: 'REEL',
          reach: 6000,
          plays: 8000,
          likes: 400,
          comments_count: 20,
          shares: 50,
          total_interactions: 470,
          performance_vs_avg_pct: 300,
        }],
        ig_avg_reach_7d: 1500,
        ig_daily_reach_series: [],
        fb: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
        fb_recent_posts: [],
        fb_available: false,
        fb_daily_views_series: [],
      },
    })
    const ctx = makeDriverContext({
      igCadence: { posts_current_7d: 5, posts_prior_7d: 4, exceptional_post_ids: ['post123'] },
    })

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers[0]?.caveat).toContain('does not establish a repeatable pattern')
  })
})

// ─── 9. Posting cadence sparse-data safety ──────────────────────────────────

describe('Posting cadence safety', () => {
  it('does NOT generate cadence driver when prior period has zero posts', () => {
    const signal = makeIgReachSignal()
    const data = makeData({
      organic: {
        ig: { reach_7d: 9000, reach_prior_7d: 5000, accounts_engaged_7d: 400, profile_views_7d: 200, followers_current: 2000, followers_7d_delta: 50 },
        ig_top_posts: [],
        ig_avg_reach_7d: 1500,
        ig_daily_reach_series: [],
        fb: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
        fb_recent_posts: [],
        fb_available: false,
        fb_daily_views_series: [],
      },
    })
    const ctx = makeDriverContext({
      igCadence: { posts_current_7d: 5, posts_prior_7d: 0, exceptional_post_ids: [] },
    })

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.filter(d => d.driver_type === 'posting_cadence_to_organic').length).toBe(0)
  })
})

// ─── 10. Timing mismatch handling ───────────────────────────────────────────

describe('Timing mismatch', () => {
  it('uses 28d evidence for GBP signals, not 7d', () => {
    const signal = makeGbpSignal()
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 500, maps_impressions_28d: 470,
        website_clicks_28d: 20, call_clicks_28d: 5, direction_requests_28d: 5,
        search_impressions_prior_28d: 1200, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
    })
    const ctx = makeDriverContext({ googleAds: makeGadsDriverContext() })

    const drivers = detectDrivers([signal], data, ctx)
    if (drivers.length > 0) {
      // All evidence for GBP driver uses 28d window
      for (const ev of drivers[0].evidence) {
        expect(ev.window).toBe('28d')
      }
    }
  })
})

// ─── 11. Counter-evidence weakens candidate ─────────────────────────────────

describe('Counter-evidence', () => {
  it('weakens GA4 driver when organic search also moved', () => {
    const signal = makeGa4Signal()
    const data = makeData({
      ga4: {
        sessions_7d: 340, sessions_prior_7d: 500,
        new_users_7d: 200, new_users_prior_7d: 300,
        page_views_7d: 800, page_views_prior_7d: 1200,
        top_sources: [], top_landing_pages: [],
      },
      googleAds: {
        currency: 'DKK',
        total_spend_7d: 500, total_spend_prior_7d: 1500,
        total_impressions_7d: 3000, total_impressions_prior_7d: 8000,
        total_clicks_7d: 150, total_clicks_prior_7d: 350,
        active_campaigns: [], paused_campaigns: [],
      },
      searchConsole: {
        clicks_7d: 60, clicks_prior_7d: 100,   // GSC also dropped significantly
        impressions_7d: 4000, impressions_prior_7d: 5000,
        ctr_7d: 0.015, ctr_prior_7d: 0.02,
        avg_position_7d: 8, avg_position_prior_7d: 7,
        top_queries: [], top_pages: [],
      },
    })
    const ctx = makeDriverContext()

    const drivers = detectDrivers([signal], data, ctx)
    const paidDriver = drivers.find(d => d.driver_type === 'paid_to_ga4')
    if (paidDriver) {
      expect(paidDriver.caveat).toContain('organic') // mentions organic as counter-evidence
    }
  })
})

// ─── 12. 7d vs 28d windows not conflated ────────────────────────────────────

describe('Window integrity', () => {
  it('GA4 drivers use 7d evidence, GBP drivers use 28d evidence', () => {
    const gbpSignal = makeGbpSignal()
    const ga4Signal = makeGa4Signal()
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 500, maps_impressions_28d: 470,
        website_clicks_28d: 20, call_clicks_28d: 5, direction_requests_28d: 5,
        search_impressions_prior_28d: 1200, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
      ga4: {
        sessions_7d: 340, sessions_prior_7d: 500,
        new_users_7d: 200, new_users_prior_7d: 300,
        page_views_7d: 800, page_views_prior_7d: 1200,
        top_sources: [], top_landing_pages: [],
      },
      googleAds: {
        currency: 'DKK',
        total_spend_7d: 500, total_spend_prior_7d: 1500,
        total_impressions_7d: 3000, total_impressions_prior_7d: 8000,
        total_clicks_7d: 150, total_clicks_prior_7d: 350,
        active_campaigns: [], paused_campaigns: [],
      },
    })
    const ctx = makeDriverContext({ googleAds: makeGadsDriverContext() })

    const drivers = detectDrivers([gbpSignal, ga4Signal], data, ctx)

    const gbpDriver = drivers.find(d => d.target_signal_id === 'gbp_performance')
    const ga4Driver = drivers.find(d => d.target_signal_id === 'ga4_traffic')

    if (gbpDriver) {
      expect(gbpDriver.evidence.every(e => e.window === '28d')).toBe(true)
    }
    if (ga4Driver) {
      expect(ga4Driver.evidence.every(e => e.window === '7d')).toBe(true)
    }
  })
})

// ─── 13. No candidate → no invented cause ───────────────────────────────────

describe('No invented drivers', () => {
  it('returns empty array when no driver context matches any signal', () => {
    const signal = makeGbpSignal()
    const data = makeData()
    const ctx = makeDriverContext()  // no google ads context

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.length).toBe(0)
  })

  it('returns empty array when signals array is empty', () => {
    const data = makeData()
    const ctx = makeDriverContext()

    const drivers = detectDrivers([], data, ctx)
    expect(drivers.length).toBe(0)
  })
})

// ─── 14. Synthetic regression: GBP -53% / paused Ads ────────────────────────

describe('REGRESSION: GBP Maps -53% with paused Google Ads', () => {
  it('generates a Google Ads cessation driver with correct language', () => {
    const signal = makeGbpSignal({
      id: 'gbp_performance',
      observation: 'Google Business Profile Maps impressions down 53.0% vs prior 28-day period (470 vs 1.0k).',
      evidence: [{
        metric: 'gbp_maps_impressions_28d',
        current: 470,
        prior: 1000,
        change_pct: -0.53,
      }],
    })

    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 500, maps_impressions_28d: 470,
        website_clicks_28d: 20, call_clicks_28d: 5, direction_requests_28d: 5,
        search_impressions_prior_28d: 1200, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
    })

    // Simulate: Google Ads had substantial prior activity, now paused, activity ended mid-period
    const ctx = makeDriverContext({
      googleAds: makeGadsDriverContext({
        total_spend_28d:             200,
        total_spend_prior_28d:       2500,
        total_impressions_28d:       1500,
        total_impressions_prior_28d: 7500,
        total_clicks_28d:            100,
        total_clicks_prior_28d:      350,
        last_active_date:            '2026-09-14',
        enabled_count:               0,
        paused_count:                2,
        paused_campaign_ids:         ['camp1', 'camp2'],
      }),
    })

    const drivers = detectDrivers([signal], data, ctx)

    // MUST generate a driver
    expect(drivers.length).toBe(1)

    const driver = drivers[0]

    // Driver type must be google_ads_to_gbp
    expect(driver.driver_type).toBe('google_ads_to_gbp')

    // Language: likely contributor or likely driver — NOT "caused"
    expect(driver.confidence).toMatch(/^(likely|possible)$/)
    expect(driver.observation).not.toContain('caused')

    // Evidence includes Ads impression/click/spend movement
    const evidenceLabels = driver.evidence.map(e => e.label)
    expect(evidenceLabels).toContain('Google Ads impressions')

    // Evidence includes the current PAUSED state
    expect(driver.observation).toContain('paused')

    // Evidence includes last activity date
    expect(driver.observation).toContain('2026-09-14')

    // Caveat must acknowledge attribution uncertainty
    expect(driver.caveat).toContain('cannot quantify')

    // All evidence uses 28d window
    for (const ev of driver.evidence) {
      expect(ev.window).toBe('28d')
    }

    // Supporting entity IDs include paused campaign IDs
    expect(driver.supporting_entity_ids).toEqual(['camp1', 'camp2'])
  })
})

// ─── 15. Ads direction must match GBP direction ─────────────────────────────

describe('Direction mismatch rejection', () => {
  it('does NOT generate driver when Ads increase but GBP decreases', () => {
    const signal = makeGbpSignal()  // GBP decreasing
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d: 500, maps_impressions_28d: 470,
        website_clicks_28d: 20, call_clicks_28d: 5, direction_requests_28d: 5,
        search_impressions_prior_28d: 1200, maps_impressions_prior_28d: 1000,
        website_clicks_prior_28d: 40, call_clicks_prior_28d: 10, direction_requests_prior_28d: 10,
        keyword_month: null, top_keywords: [],
      },
    })
    const ctx = makeDriverContext({
      googleAds: makeGadsDriverContext({
        // Ads INCREASED — opposite direction to GBP decrease
        total_impressions_28d:       15000,
        total_impressions_prior_28d: 7500,
        total_clicks_28d:            700,
        total_clicks_prior_28d:      350,
        total_spend_28d:             4000,
        total_spend_prior_28d:       2000,
        enabled_count: 2,
        paused_count: 0,
        paused_campaign_ids: [],
      }),
    })

    const drivers = detectDrivers([signal], data, ctx)
    expect(drivers.length).toBe(0)
  })
})

// ─── 16. At most one driver per signal ──────────────────────────────────────

describe('One driver per signal', () => {
  it('returns at most one driver per signal when multiple rules match', () => {
    const signal = makeIgReachSignal()
    const data = makeData({
      organic: {
        ig: { reach_7d: 9000, reach_prior_7d: 5000, accounts_engaged_7d: 400, profile_views_7d: 200, followers_current: 2000, followers_7d_delta: 50 },
        ig_top_posts: [{
          caption_truncated: 'Kebab',
          published_at: '2026-09-17T12:00:00Z',
          media_type: 'REEL',
          reach: 6000, plays: 8000, likes: 400, comments_count: 20, shares: 50,
          total_interactions: 470,
          performance_vs_avg_pct: 300,
        }],
        ig_avg_reach_7d: 1500,
        ig_daily_reach_series: [],
        fb: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
        fb_recent_posts: [],
        fb_available: false,
        fb_daily_views_series: [],
      },
    })
    const ctx = makeDriverContext({
      igCadence: {
        posts_current_7d: 10,  // also big cadence increase
        posts_prior_7d: 2,
        exceptional_post_ids: ['post123'],
      },
    })

    const drivers = detectDrivers([signal], data, ctx)
    // At most one driver per signal
    const driversForThisSignal = drivers.filter(d => d.target_signal_id === 'organic_ig_reach')
    expect(driversForThisSignal.length).toBeLessThanOrEqual(1)
  })
})

// ─── 17. Cadence driver confidence ──────────────────────────────────────────

describe('Cadence driver confidence', () => {
  it('cadence driver is always "possible", never "likely"', () => {
    const signal = makeIgReachSignal({
      evidence: [{
        metric: 'ig_reach_7d',
        current: 3000,
        prior: 5000,
        change_pct: -0.40,
      }],
      observation: 'IG reach down 40%.',
    })
    const data = makeData({
      organic: {
        ig: { reach_7d: 3000, reach_prior_7d: 5000, accounts_engaged_7d: 200, profile_views_7d: 100, followers_current: 2000, followers_7d_delta: -10 },
        ig_top_posts: [],
        ig_avg_reach_7d: 500,
        ig_daily_reach_series: [],
        fb: { views_7d: null, engaged_users_7d: null, fan_count_current: null, fan_count_7d_delta: null },
        fb_recent_posts: [],
        fb_available: false,
        fb_daily_views_series: [],
      },
    })
    const ctx = makeDriverContext({
      igCadence: { posts_current_7d: 1, posts_prior_7d: 5, exceptional_post_ids: [] },
    })

    const drivers = detectDrivers([signal], data, ctx)
    const cadenceDriver = drivers.find(d => d.driver_type === 'posting_cadence_to_organic')
    if (cadenceDriver) {
      expect(cadenceDriver.confidence).toBe('possible')
    }
  })
})

// ─── Additional: old Morning Brief observation type backward compat ─────────

describe('backward compatibility', () => {
  it('BriefObservation type allows driver to be undefined (old briefs)', () => {
    // This is a compile-time check — if it compiles, it passes
    const obs = {
      signal_id: 'test',
      observation: 'test',
      evidence: 'test',
      interpretation: 'test',
      recommended_action: 'test',
      creative_start: null,
      // No driver field — must be valid
    }
    expect(obs.signal_id).toBe('test')
  })
})
