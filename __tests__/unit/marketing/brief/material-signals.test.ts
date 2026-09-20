/**
 * Unit tests for buildMaterialSignals in lib/marketing/brief/material-signals.ts
 *
 * Verified guarantees:
 *   1. Small-volume large-% changes are suppressed (volume guard)
 *   2. Meaningful current/prior changes produce candidates
 *   3. Google Ads per-result comparison matches only the same action
 *   4. Meta anomalies are reused, not recomputed
 *   5. IG post outperformance creates a creative_learning candidate
 *   6. Search Console material movement creates a candidate
 *   7. GA4 material movement creates a candidate
 *   8. GBP prior 28d comparison creates a candidate when material
 *   9. Output is ranked by materiality_score descending
 *  10. Candidates are deduplicated (same id → one entry)
 *  11. At most MAX_SIGNAL_CANDIDATES returned
 *  12. No forced candidate when nothing is material
 *  13. Stale critical source creates a data_health candidate
 */

import { describe, it, expect } from 'vitest'
import {
  buildMaterialSignals,
  MAX_SIGNAL_CANDIDATES,
  GADS_MIN_SPEND_7D_FOR_SIGNAL,
  GADS_MIN_RESULTS_FOR_SIGNAL,
  IG_MIN_REACH_FOR_SIGNAL,
  GSC_MIN_CLICKS_FOR_SIGNAL,
  GSC_MIN_IMPRESSIONS_FOR_SIGNAL,
  GA4_MIN_SESSIONS_FOR_SIGNAL,
  GBP_MIN_INTERACTIONS_FOR_SIGNAL,
} from '@/lib/marketing/brief/material-signals'
import type { BriefInputData } from '@/lib/marketing/brief/types'

// ─── Minimal fixture builder ──────────────────────────────────────────────────

function minimalFreshness() {
  const healthy = {
    last_success_at: '2026-09-19T10:00:00Z',
    status: 'success',
    age_hours: 2,
    healthy: true,
  }
  return {
    meta_ads_daily:        healthy,
    meta_ig_account_daily: healthy,
    meta_ig_organic_deep:  healthy,
    meta_fb_page_daily:    healthy,
    meta_fb_organic_deep:  healthy,
    gbp: { kind: 'connected' as const, last_sync_at: '2026-09-19T10:00:00Z', healthy: true },
    google_ads: healthy,
    gsc:        healthy,
    ga4:        healthy,
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

function minimalIg(): BriefInputData['organic']['ig'] {
  return {
    reach_7d: null,
    reach_prior_7d: null,
    accounts_engaged_7d: null,
    profile_views_7d: null,
    followers_current: null,
    followers_7d_delta: null,
  }
}

function minimalFbPage(): BriefInputData['organic']['fb'] {
  return {
    views_7d: null,
    engaged_users_7d: null,
    fan_count_current: null,
    fan_count_7d_delta: null,
  }
}

function minimalOrganic(): BriefInputData['organic'] {
  return {
    ig: minimalIg(),
    ig_top_posts: [],
    ig_avg_reach_7d: null,
    ig_daily_reach_series: [],
    fb: minimalFbPage(),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildMaterialSignals — volume guard', () => {
  it('suppresses small-volume large-% Google Ads result changes (below min results threshold)', () => {
    const data = makeData({
      googleAds: {
        currency: 'DKK',
        total_spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_impressions_7d: 1000,
        total_impressions_prior_7d: 1000,
        total_clicks_7d: 50,
        total_clicks_prior_7d: 50,
        active_campaigns: [
          {
            id: 'camp1',
            name: 'Camp',
            status: 'ENABLED',
            channel_type: 'SEARCH',
            spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
            impressions_7d: 500,
            clicks_7d: 30,
            top_results: [
              {
                label: 'Purchases',
                count: 2, // BELOW GADS_MIN_RESULTS_FOR_SIGNAL = 5
                costPerResult: 50,
                primary: true,
                prior_count: 1,
                prior_costPerResult: 100,
              },
            ],
          },
        ],
        paused_campaigns: [],
      },
    })

    const signals = buildMaterialSignals(data)
    const resultSignal = signals.find((s) => s.id.includes('camp1') && s.id.includes('purchases'))
    expect(resultSignal).toBeUndefined()
  })

  it('suppresses small-volume large-% IG reach changes (below min reach threshold)', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig: {
          ...minimalIg(),
          reach_7d: IG_MIN_REACH_FOR_SIGNAL - 50, // below threshold
          reach_prior_7d: 1,                       // enormous % change but tiny volume
        },
      },
    })

    const signals = buildMaterialSignals(data)
    expect(signals.find((s) => s.id === 'organic_ig_reach')).toBeUndefined()
  })

  it('suppresses small-volume GSC changes (below min clicks threshold)', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL - 5, // below min
        clicks_prior_7d:       1,
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL - 100, // below min
        impressions_prior_7d:  1,
        ctr_7d:                0.05,
        ctr_prior_7d:          0.01,
        avg_position_7d:       5,
        avg_position_prior_7d: 6,
        top_queries: [],
        top_pages: [],
      },
    })

    const signals = buildMaterialSignals(data)
    expect(signals.find((s) => s.id === 'search_console_organic')).toBeUndefined()
  })

  it('suppresses small-volume GA4 changes (below min sessions threshold)', () => {
    const data = makeData({
      ga4: {
        sessions_7d:       GA4_MIN_SESSIONS_FOR_SIGNAL - 10, // below threshold
        sessions_prior_7d: 1,
        new_users_7d:      20,
        new_users_prior_7d: 1,
        page_views_7d:     100,
        page_views_prior_7d: 1,
        top_sources: [],
        top_landing_pages: [],
      },
    })

    const signals = buildMaterialSignals(data)
    expect(signals.find((s) => s.id === 'ga4_sessions')).toBeUndefined()
  })

  it('suppresses GBP changes when total interactions are below threshold', () => {
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       GBP_MIN_INTERACTIONS_FOR_SIGNAL - 5,
        maps_impressions_28d:         null,
        website_clicks_28d:           5,     // interactions = 5+5 = 10 < GBP_MIN
        call_clicks_28d:              null,
        direction_requests_28d:       null,
        search_impressions_prior_28d: 1,
        maps_impressions_prior_28d:   null,
        website_clicks_prior_28d:     1,
        call_clicks_prior_28d:        null,
        direction_requests_prior_28d: null,
        keyword_month: null,
        top_keywords: [],
      },
    })

    const signals = buildMaterialSignals(data)
    expect(signals.find((s) => s.id === 'gbp_performance')).toBeUndefined()
  })
})

describe('buildMaterialSignals — material change detection', () => {
  it('creates a google_ads_account_spend candidate when spend changes materially', () => {
    const data = makeData({
      googleAds: {
        currency: 'DKK',
        total_spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 3,       // 300 DKK
        total_spend_prior_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 1.5, // 150 DKK — 100% increase
        total_impressions_7d: 1000,
        total_impressions_prior_7d: 1000,
        total_clicks_7d: 50,
        total_clicks_prior_7d: 50,
        active_campaigns: [],
        paused_campaigns: [],
      },
    })

    const signals = buildMaterialSignals(data)
    const spendSignal = signals.find((s) => s.id === 'google_ads_account_spend')
    expect(spendSignal).toBeDefined()
    expect(spendSignal!.source).toBe('google_ads')
    expect(spendSignal!.category).toBe('commercial_consequence')
    expect(spendSignal!.commercially_relevant).toBe(true)
    const ev = spendSignal!.evidence[0]
    expect(ev.metric).toBe('spend_7d')
    expect(ev.change_pct).toBeGreaterThan(0)
  })

  it('creates an organic_ig_reach candidate when reach changes materially', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig: {
          ...minimalIg(),
          reach_7d: IG_MIN_REACH_FOR_SIGNAL * 3,      // 600
          reach_prior_7d: IG_MIN_REACH_FOR_SIGNAL * 2, // 400 — 50% increase
        },
      },
    })

    const signals = buildMaterialSignals(data)
    const reachSignal = signals.find((s) => s.id === 'organic_ig_reach')
    expect(reachSignal).toBeDefined()
    expect(reachSignal!.source).toBe('organic_ig')
    expect(reachSignal!.category).toBe('traffic_audience')
    const ev = reachSignal!.evidence[0]
    expect(ev.change_pct).toBeCloseTo(0.5)
  })

  it('creates a search_console_organic candidate when clicks change materially', () => {
    const data = makeData({
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL * 3,   // 90
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL * 1.5, // 45 — 100% increase
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d:                0.05,
        ctr_prior_7d:          0.04,
        avg_position_7d:       5,
        avg_position_prior_7d: 5,
        top_queries: [],
        top_pages: [],
      },
    })

    const signals = buildMaterialSignals(data)
    const gscSignal = signals.find((s) => s.id === 'search_console_organic')
    expect(gscSignal).toBeDefined()
    expect(gscSignal!.source).toBe('search_console')
    expect(gscSignal!.category).toBe('seo_local_search')
  })

  it('creates a ga4_sessions candidate when sessions change materially', () => {
    const data = makeData({
      ga4: {
        sessions_7d:       GA4_MIN_SESSIONS_FOR_SIGNAL * 4, // 200
        sessions_prior_7d: GA4_MIN_SESSIONS_FOR_SIGNAL * 2, // 100 — 100% increase
        new_users_7d:      50,
        new_users_prior_7d: 40,
        page_views_7d:     400,
        page_views_prior_7d: 200,
        top_sources: [],
        top_landing_pages: [],
      },
    })

    const signals = buildMaterialSignals(data)
    const ga4Signal = signals.find((s) => s.id === 'ga4_sessions')
    expect(ga4Signal).toBeDefined()
    expect(ga4Signal!.category).toBe('traffic_audience')
    const sessEv = ga4Signal!.evidence.find((e) => e.metric === 'ga4_sessions_7d')
    expect(sessEv?.change_pct).toBeCloseTo(1.0)
  })

  it('creates a gbp_performance candidate when GBP interactions change materially', () => {
    const interactions = GBP_MIN_INTERACTIONS_FOR_SIGNAL * 3
    const data = makeData({
      gbpPerformance: {
        search_impressions_28d:       null,
        maps_impressions_28d:         null,
        website_clicks_28d:           interactions,
        call_clicks_28d:              null,
        direction_requests_28d:       null,
        search_impressions_prior_28d: null,
        maps_impressions_prior_28d:   null,
        website_clicks_prior_28d:     Math.round(interactions / 2), // 50% drop
        call_clicks_prior_28d:        null,
        direction_requests_prior_28d: null,
        keyword_month: null,
        top_keywords: [],
      },
    })

    const signals = buildMaterialSignals(data)
    const gbpSignal = signals.find((s) => s.id === 'gbp_performance')
    expect(gbpSignal).toBeDefined()
    expect(gbpSignal!.source).toBe('gbp_performance')
    expect(gbpSignal!.category).toBe('seo_local_search')
  })
})

describe('buildMaterialSignals — Google Ads result isolation', () => {
  it('does not create a result candidate when prior_count is null (no cross-result aggregation)', () => {
    const data = makeData({
      googleAds: {
        currency: 'DKK',
        total_spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_impressions_7d: 500,
        total_impressions_prior_7d: 500,
        total_clicks_7d: 50,
        total_clicks_prior_7d: 50,
        active_campaigns: [
          {
            id: 'camp1',
            name: 'Camp',
            status: 'ENABLED',
            channel_type: 'SEARCH',
            spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
            impressions_7d: 500,
            clicks_7d: 30,
            top_results: [
              {
                label: 'Purchases',
                count: GADS_MIN_RESULTS_FOR_SIGNAL * 4,
                costPerResult: 10,
                primary: true,
                prior_count: null,           // no matching prior
                prior_costPerResult: null,
              },
            ],
          },
        ],
        paused_campaigns: [],
      },
    })

    const signals = buildMaterialSignals(data)
    // The result signal requires prior_count — should not exist
    const resultSignal = signals.find(
      (s) => s.id.includes('camp1') && s.id.includes('purchases'),
    )
    expect(resultSignal).toBeUndefined()
  })

  it('creates a result candidate only for the matching action (prior_count present)', () => {
    const data = makeData({
      googleAds: {
        currency: 'DKK',
        total_spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_impressions_7d: 500,
        total_impressions_prior_7d: 500,
        total_clicks_7d: 50,
        total_clicks_prior_7d: 50,
        active_campaigns: [
          {
            id: 'camp2',
            name: 'Active Camp',
            status: 'ENABLED',
            channel_type: 'SEARCH',
            spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
            impressions_7d: 500,
            clicks_7d: 40,
            top_results: [
              {
                label: 'Purchases',
                count: GADS_MIN_RESULTS_FOR_SIGNAL * 4,  // 20
                costPerResult: 10,
                primary: true,
                prior_count: GADS_MIN_RESULTS_FOR_SIGNAL * 2,  // 10 — 100% increase
                prior_costPerResult: 20,
              },
            ],
          },
        ],
        paused_campaigns: [],
      },
    })

    const signals = buildMaterialSignals(data)
    const resultSignal = signals.find(
      (s) => s.id.includes('camp2') && s.id.includes('purchases'),
    )
    expect(resultSignal).toBeDefined()
    expect(resultSignal!.source).toBe('google_ads')
    const ev = resultSignal!.evidence[0]
    expect(ev.metric).toBe('Purchases')
    expect(ev.current).toBe(GADS_MIN_RESULTS_FOR_SIGNAL * 4)
    expect(ev.prior).toBe(GADS_MIN_RESULTS_FOR_SIGNAL * 2)
  })
})

describe('buildMaterialSignals — Meta anomaly reuse', () => {
  it('creates a meta_paid candidate for each PaidAnomalySignal in signals.paid_anomalies', () => {
    const anomaly = {
      campaign_name: 'Summer Sale',
      metric_label: 'spend',
      change_pct: 45.0,
      direction: 'increase' as const,
      yesterday_value: 2000,
      baseline_value: 1379,
    }

    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: 1,
        paid_anomalies: [anomaly],
      }),
    })

    const signals = buildMaterialSignals(data)
    const metaSignal = signals.find((s) => s.source === 'meta_paid')
    expect(metaSignal).toBeDefined()
    expect(metaSignal!.category).toBe('commercial_consequence')
    const ev = metaSignal!.evidence[0]
    expect(ev.metric).toBe('spend')
    // change_pct stored in anomaly is 45.0 (percentage points) → fractional = 0.45
    expect(ev.change_pct).toBeCloseTo(0.45)
  })
})

describe('buildMaterialSignals — IG post outperformance', () => {
  it('creates a creative_learning candidate for significantly outperforming posts', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig_top_posts: [
          {
            caption_truncated: 'Great post content here',
            published_at: '2026-09-18',
            media_type: 'IMAGE',
            reach: 2000,
            plays: null,
            likes: 150,
            comments_count: 20,
            shares: 5,
            total_interactions: 175,
            performance_vs_avg_pct: 90, // 90% above avg — exceeds IG_POST_OUTPERFORMANCE_PCT * 100 = 50
          },
        ],
      },
    })

    const signals = buildMaterialSignals(data)
    const postSignal = signals.find((s) => s.source === 'organic_ig' && s.category === 'creative_learning')
    expect(postSignal).toBeDefined()
    expect(postSignal!.creatively_relevant).toBe(true)
    expect(postSignal!.observation).toContain('DATA:')
  })

  it('does not create a creative_learning candidate for low-reach posts even with high % above avg', () => {
    const data = makeData({
      organic: {
        ...minimalOrganic(),
        ig_top_posts: [
          {
            caption_truncated: 'Small post',
            published_at: '2026-09-18',
            media_type: 'IMAGE',
            reach: 50, // below IG_POST_OUTPERFORMANCE_MIN_REACH = 100
            plays: null,
            likes: 10,
            comments_count: 2,
            shares: 0,
            total_interactions: 12,
            performance_vs_avg_pct: 200, // very high % but tiny volume
          },
        ],
      },
    })

    const signals = buildMaterialSignals(data)
    const postSignal = signals.find((s) => s.source === 'organic_ig' && s.category === 'creative_learning')
    expect(postSignal).toBeUndefined()
  })
})

describe('buildMaterialSignals — ranking', () => {
  it('ranks candidates by materiality_score descending', () => {
    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: 1,
        paid_anomalies: [
          {
            campaign_name: 'Test',
            metric_label: 'spend',
            change_pct: 60.0,
            direction: 'increase',
            yesterday_value: 5000,
            baseline_value: 3125,
          },
        ],
      }),
      searchConsole: {
        clicks_7d:             GSC_MIN_CLICKS_FOR_SIGNAL * 3,
        clicks_prior_7d:       GSC_MIN_CLICKS_FOR_SIGNAL * 1.5,
        impressions_7d:        GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d:  GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.04,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [],
        top_pages: [],
      },
    })

    const signals = buildMaterialSignals(data)
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i - 1].materiality_score).toBeGreaterThanOrEqual(signals[i].materiality_score)
    }
  })
})

describe('buildMaterialSignals — deduplication', () => {
  it('does not produce duplicate candidates with the same id', () => {
    // Two anomalies for the same campaign+metric would share an id after slugify
    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: 2,
        paid_anomalies: [
          {
            campaign_name: 'Camp A',
            metric_label: 'spend',
            change_pct: 50,
            direction: 'increase',
            yesterday_value: 3000,
            baseline_value: 2000,
          },
          {
            campaign_name: 'Camp A',
            metric_label: 'spend',
            change_pct: 50,
            direction: 'increase',
            yesterday_value: 3000,
            baseline_value: 2000,
          },
        ],
      }),
    })

    const signals = buildMaterialSignals(data)
    const ids = signals.map((s) => s.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })
})

describe('buildMaterialSignals — output cap', () => {
  it('returns at most MAX_SIGNAL_CANDIDATES candidates even when many qualify', () => {
    // Create 20 anomalies with distinct campaign names so they all get unique ids
    const anomalies = Array.from({ length: 20 }, (_, i) => ({
      campaign_name: `Campaign ${String(i).padStart(3, '0')}`,
      metric_label: 'spend',
      change_pct: 50 + i,
      direction: 'increase' as const,
      yesterday_value: 2000 + i * 100,
      baseline_value: 1000,
    }))

    const data = makeData({
      signals: minimalSignals({
        paid_anomaly_count: anomalies.length,
        paid_anomalies: anomalies,
      }),
    })

    const signals = buildMaterialSignals(data)
    expect(signals.length).toBeLessThanOrEqual(MAX_SIGNAL_CANDIDATES)
  })
})

describe('buildMaterialSignals — no forced candidate', () => {
  it('returns an empty array when nothing is material', () => {
    // All data at stable values well within thresholds
    const data = makeData({
      googleAds: {
        currency: 'DKK',
        total_spend_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2,
        total_spend_prior_7d: GADS_MIN_SPEND_7D_FOR_SIGNAL * 2, // 0% change
        total_impressions_7d: 1000,
        total_impressions_prior_7d: 1000,
        total_clicks_7d: 50,
        total_clicks_prior_7d: 50,
        active_campaigns: [],
        paused_campaigns: [],
      },
      searchConsole: {
        clicks_7d: GSC_MIN_CLICKS_FOR_SIGNAL * 2,
        clicks_prior_7d: GSC_MIN_CLICKS_FOR_SIGNAL * 2, // 0% change
        impressions_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        impressions_prior_7d: GSC_MIN_IMPRESSIONS_FOR_SIGNAL * 2,
        ctr_7d: 0.05, ctr_prior_7d: 0.05,
        avg_position_7d: 5, avg_position_prior_7d: 5,
        top_queries: [],
        top_pages: [],
      },
    })

    const signals = buildMaterialSignals(data)
    expect(signals.length).toBe(0)
  })
})

describe('buildMaterialSignals — data health', () => {
  it('creates a data_health candidate when critical source is stale', () => {
    const data = makeData({
      signals: minimalSignals({
        has_stale_critical_source: true,
        stale_sources: ['meta_ads_daily', 'meta_ig_account_daily'],
      }),
    })

    const signals = buildMaterialSignals(data)
    const healthSignal = signals.find((s) => s.source === 'data_health')
    expect(healthSignal).toBeDefined()
    expect(healthSignal!.category).toBe('data_health')
    expect(healthSignal!.observation).toContain('meta_ads_daily')
    expect(healthSignal!.observation).toContain('meta_ig_account_daily')
  })

  it('does not create a data_health candidate when all sources are healthy', () => {
    const data = makeData()

    const signals = buildMaterialSignals(data)
    expect(signals.find((s) => s.source === 'data_health')).toBeUndefined()
  })
})
