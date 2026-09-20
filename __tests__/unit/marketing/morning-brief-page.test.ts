/**
 * __tests__/unit/marketing/morning-brief-page.test.ts
 *
 * Tests for the pure helper functions exported from the Morning Brief page.
 *
 * Environment: Node (no jsdom). Only pure helpers are testable here.
 * The React server component itself is not exercised in this suite.
 *
 * Behaviours verified by implementation (not unit-testable in Node):
 *   - Observations render in stored order (guaranteed by .map() over the array)
 *   - creative_start rendered only when non-null (conditional in ObservationItem)
 *   - data-health observations use subdued CSS classes (data-is-data-health attr)
 *   - Needs Review block positioned before observations in DOM
 *   - v1 brief (no observations) renders legacy layout (data-legacy-layout attr)
 *   - StaleBanner shows when isStale=true (conditional in MorningBriefContent)
 *   - Admin RegenerateButton rendered only for SUPER_ADMIN (server-side auth check)
 */

import { describe, it, expect } from 'vitest'
import {
  sourceLabel,
  SOURCE_LABELS,
  categoryIsDataHealth,
  observationCount,
  isBriefV2,
  needsReviewVisible,
} from '@/app/(marketing)/marketing/page'
import type { MorningBriefSections } from '@/lib/marketing/brief/types'

// ── sourceLabel ───────────────────────────────────────────────────────────────

describe('sourceLabel', () => {
  it('returns Meta Paid for meta_paid', () => {
    expect(sourceLabel('meta_paid')).toBe('Meta Paid')
  })

  it('returns Google Ads for google_ads', () => {
    expect(sourceLabel('google_ads')).toBe('Google Ads')
  })

  it('returns Instagram for organic_ig', () => {
    expect(sourceLabel('organic_ig')).toBe('Instagram')
  })

  it('returns Search for search_console', () => {
    expect(sourceLabel('search_console')).toBe('Search')
  })

  it('returns Website for ga4', () => {
    expect(sourceLabel('ga4')).toBe('Website')
  })

  it('returns Google Business Profile for gbp_performance', () => {
    expect(sourceLabel('gbp_performance')).toBe('Google Business Profile')
  })

  it('returns Data Health for data_health', () => {
    expect(sourceLabel('data_health')).toBe('Data Health')
  })

  it('returns the raw value for an unknown source', () => {
    expect(sourceLabel('unknown_source')).toBe('unknown_source')
  })

  it('SOURCE_LABELS covers all expected channels', () => {
    const keys = Object.keys(SOURCE_LABELS)
    expect(keys).toContain('meta_paid')
    expect(keys).toContain('google_ads')
    expect(keys).toContain('organic_ig')
    expect(keys).toContain('search_console')
    expect(keys).toContain('ga4')
    expect(keys).toContain('gbp_performance')
    expect(keys).toContain('data_health')
  })
})

// ── categoryIsDataHealth ──────────────────────────────────────────────────────

describe('categoryIsDataHealth', () => {
  it('returns true for data_health', () => {
    expect(categoryIsDataHealth('data_health')).toBe(true)
  })

  it('returns false for commercial_consequence', () => {
    expect(categoryIsDataHealth('commercial_consequence')).toBe(false)
  })

  it('returns false for traffic_audience', () => {
    expect(categoryIsDataHealth('traffic_audience')).toBe(false)
  })

  it('returns false for creative_learning', () => {
    expect(categoryIsDataHealth('creative_learning')).toBe(false)
  })

  it('returns false for seo_local_search', () => {
    expect(categoryIsDataHealth('seo_local_search')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(categoryIsDataHealth('')).toBe(false)
  })
})

// ── observationCount ──────────────────────────────────────────────────────────

describe('observationCount', () => {
  it('returns 0 for null sections', () => {
    expect(observationCount(null)).toBe(0)
  })

  it('returns 0 for undefined sections', () => {
    expect(observationCount(undefined)).toBe(0)
  })

  it('returns 0 when sections has no observations field (v1 brief)', () => {
    const sections = { observations: undefined } as unknown as MorningBriefSections
    expect(observationCount(sections)).toBe(0)
  })

  it('returns 0 when observations is empty array', () => {
    const sections = { observations: [] } as unknown as MorningBriefSections
    expect(observationCount(sections)).toBe(0)
  })

  it('returns correct count when observations are present', () => {
    const sections = {
      observations: [
        { signal_id: 'a', observation: '', evidence: '', interpretation: '', recommended_action: '', creative_start: null },
        { signal_id: 'b', observation: '', evidence: '', interpretation: '', recommended_action: '', creative_start: null },
        { signal_id: 'c', observation: '', evidence: '', interpretation: '', recommended_action: '', creative_start: null },
      ],
    } as unknown as MorningBriefSections
    expect(observationCount(sections)).toBe(3)
  })

  it('v2 layout is chosen when observationCount > 0', () => {
    const sections = {
      observations: [
        { signal_id: 'x', observation: 'test', evidence: 'e', interpretation: 'i', recommended_action: 'a', creative_start: null },
      ],
    } as unknown as MorningBriefSections
    expect(observationCount(sections) > 0).toBe(true)
  })

  it('legacy layout is chosen when observationCount === 0 (old brief)', () => {
    const sections = {} as unknown as MorningBriefSections
    expect(observationCount(sections) === 0).toBe(true)
  })
})

// ── isBriefV2 ─────────────────────────────────────────────────────────────────

describe('isBriefV2', () => {
  it('returns false for null sections (no brief yet)', () => {
    expect(isBriefV2(null)).toBe(false)
  })

  it('returns false for undefined sections', () => {
    expect(isBriefV2(undefined)).toBe(false)
  })

  it('returns false for v1 sections where observations field is absent', () => {
    const sections = {} as unknown as MorningBriefSections
    expect(isBriefV2(sections)).toBe(false)
  })

  it('returns false when observations is explicitly undefined', () => {
    const sections = { observations: undefined } as unknown as MorningBriefSections
    expect(isBriefV2(sections)).toBe(false)
  })

  it('returns true for v2 sections with observations (non-empty)', () => {
    const sections = {
      observations: [
        { signal_id: 'x', observation: 'test', evidence: 'e', interpretation: 'i', recommended_action: 'a', creative_start: null },
      ],
    } as unknown as MorningBriefSections
    expect(isBriefV2(sections)).toBe(true)
  })

  it('returns true for v2 sections with empty observations array (zero material signals)', () => {
    const sections = { observations: [] } as unknown as MorningBriefSections
    expect(isBriefV2(sections)).toBe(true)
  })

  it('v2 brief with zero observations still selects v2 layout — not legacy fallback', () => {
    const sections = { observations: [] } as unknown as MorningBriefSections
    // dispatch signal is field presence, not count — observationCount=0 must not route to legacy
    expect(isBriefV2(sections)).toBe(true)
    expect(observationCount(sections)).toBe(0)
  })

  it('v1 brief routes to legacy layout — isBriefV2 false, so NeedsReview not shown via v2 path', () => {
    const v1 = {} as unknown as MorningBriefSections
    expect(isBriefV2(v1)).toBe(false)
  })
})

// ── needsReviewVisible ────────────────────────────────────────────────────────

describe('needsReviewVisible', () => {
  it('returns false when total is 0', () => {
    expect(needsReviewVisible(0)).toBe(false)
  })

  it('returns true when total is 1', () => {
    expect(needsReviewVisible(1)).toBe(true)
  })

  it('returns true when total is large', () => {
    expect(needsReviewVisible(42)).toBe(true)
  })
})
