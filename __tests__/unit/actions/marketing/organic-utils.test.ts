import { describe, it, expect } from 'vitest'
import {
  computeIgOverview,
  computeFollowerGrowth,
  computeFbOverview,
  addPostContext,
  generateInsights,
  median,
  sortPosts,
} from '@/lib/actions/marketing/organic-utils'
import type { IgDailyRow, IgPostRow, PostWithContext, IgOverview, FbDailyRow } from '@/lib/actions/marketing/organic-utils'

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDaily(date: string, reach: number, followers: number): IgDailyRow {
  return { date, reach, followers_count: followers, accounts_engaged: null, profile_views: null }
}

function makeFbDaily(date: string, views: number, engaged: number, fans: number): FbDailyRow {
  return { date, views, reach: null, engaged_users: engaged, fan_count: fans }
}

function makePost(overrides: Partial<IgPostRow> = {}): IgPostRow {
  return {
    id: overrides.id ?? 'p1',
    media_type: overrides.media_type ?? 'IMAGE',
    caption: overrides.caption ?? null,
    permalink: null,
    published_at: overrides.published_at ?? '2026-09-10',
    media_url: null,
    thumbnail_url: null,
    reach: overrides.reach ?? 100,
    plays: overrides.plays ?? null,
    saved: overrides.saved ?? 5,
    likes: overrides.likes ?? 10,
    comments_count: overrides.comments_count ?? 2,
    shares: overrides.shares ?? 3,
    total_interactions: null,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeIgOverview', () => {
  it('sums reach for current and prior periods', () => {
    const daily = [
      makeDaily('2026-09-20', 100, 1000),
      makeDaily('2026-09-21', 200, 1010),
      makeDaily('2026-09-10', 150, 950),
      makeDaily('2026-09-11', 80, 960),
    ]
    const result = computeIgOverview(daily, '2026-09-20', '2026-09-21', '2026-09-10', '2026-09-11')
    expect(result.reach).toBe(300)
    expect(result.reachPrior).toBe(230)
  })

  it('computes follower growth as last - first in window', () => {
    const daily = [
      makeDaily('2026-09-20', 100, 1000),
      makeDaily('2026-09-23', 200, 1025),
    ]
    const result = computeIgOverview(daily, '2026-09-20', '2026-09-23', '2026-09-10', '2026-09-13')
    expect(result.followerGrowth).toBe(25) // 1025 - 1000
  })

  it('returns null follower growth with single day', () => {
    const daily = [makeDaily('2026-09-20', 100, 1000)]
    const result = computeIgOverview(daily, '2026-09-20', '2026-09-20', '2026-09-10', '2026-09-10')
    expect(result.followerGrowth).toBeNull()
  })
})

describe('computeFollowerGrowth', () => {
  it('returns difference between first and last day', () => {
    const rows = [
      makeDaily('2026-09-20', 0, 1000),
      makeDaily('2026-09-22', 0, 1015),
      makeDaily('2026-09-24', 0, 1030),
    ]
    expect(computeFollowerGrowth(rows)).toBe(30)
  })

  it('returns null with fewer than 2 rows', () => {
    expect(computeFollowerGrowth([makeDaily('2026-09-20', 0, 1000)])).toBeNull()
    expect(computeFollowerGrowth([])).toBeNull()
  })
})

describe('computeFbOverview', () => {
  it('sums views and engaged for both periods', () => {
    const daily = [
      makeFbDaily('2026-09-20', 50, 20, 500),
      makeFbDaily('2026-09-21', 60, 25, 505),
      makeFbDaily('2026-09-10', 40, 15, 490),
    ]
    const result = computeFbOverview(daily, '2026-09-20', '2026-09-21', '2026-09-10', '2026-09-11')
    expect(result.views).toBe(110)
    expect(result.engagedUsers).toBe(45)
    expect(result.viewsPrior).toBe(40)
  })
})

describe('median', () => {
  it('returns median of odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('returns median of even-length array', () => {
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })

  it('returns 0 for empty array', () => {
    expect(median([])).toBe(0)
  })

  it('viral outlier does not distort median', () => {
    // 9 normal posts + 1 viral outlier
    const values = [100, 120, 90, 110, 105, 95, 115, 108, 103, 500000]
    const m = median(values)
    expect(m).toBeLessThan(200) // median should be ~107, not pulled up by 500K
    expect(m).toBeGreaterThan(100)
  })
})

describe('addPostContext', () => {
  it('compares video posts against video median', () => {
    const videos = [
      makePost({ id: 'v1', media_type: 'VIDEO', plays: 100, reach: 80 }),
      makePost({ id: 'v2', media_type: 'VIDEO', plays: 200, reach: 150 }),
      makePost({ id: 'v3', media_type: 'VIDEO', plays: 300, reach: 250 }),
      makePost({ id: 'v4', media_type: 'VIDEO', plays: 600, reach: 500 }),
    ]
    const result = addPostContext([videos[3]], videos)
    expect(result[0].exposure).toBe(600) // uses plays for video
    expect(result[0].exposureLabel).toBe('Views')
    expect(result[0].medianRatio).toBeCloseTo(600 / median([100, 200, 300, 600]), 1)
  })

  it('compares static posts against static median', () => {
    const statics = [
      makePost({ id: 's1', media_type: 'IMAGE', reach: 100 }),
      makePost({ id: 's2', media_type: 'IMAGE', reach: 200 }),
      makePost({ id: 's3', media_type: 'IMAGE', reach: 300 }),
      makePost({ id: 's4', media_type: 'CAROUSEL_ALBUM', reach: 400 }),
    ]
    const result = addPostContext([statics[3]], statics)
    expect(result[0].exposure).toBe(400) // uses reach for carousel
    expect(result[0].exposureLabel).toBe('Reach')
    expect(result[0].medianRatio).toBeCloseTo(400 / median([100, 200, 300, 400]), 1)
  })

  it('returns null medianRatio with fewer than 3 compatible posts', () => {
    const posts = [
      makePost({ id: 'v1', media_type: 'VIDEO', plays: 100 }),
      makePost({ id: 'v2', media_type: 'VIDEO', plays: 200 }),
    ]
    const result = addPostContext(posts, posts)
    expect(result[0].medianRatio).toBeNull()
  })
})

describe('generateInsights', () => {
  function makeContextPost(overrides: Partial<PostWithContext>): PostWithContext {
    return {
      ...makePost(),
      exposure: overrides.exposure ?? 100,
      exposureLabel: overrides.exposureLabel ?? 'Reach',
      medianRatio: overrides.medianRatio ?? null,
      ...overrides,
    }
  }

  const defaultOverview: IgOverview = {
    reach: 1000, reachPrior: 1000,
    engagedUsers: null, engagedPrior: null,
    followerGrowth: 10, followerGrowthPrior: 10,
    followers: 5000,
  }

  it('returns empty when too few posts', () => {
    const posts = [makeContextPost({ id: 'p1' }), makeContextPost({ id: 'p2' })]
    expect(generateInsights(posts, defaultOverview)).toEqual([])
  })

  it('generates reel vs static insight when reels dominate', () => {
    const posts = [
      makeContextPost({ id: 'v1', media_type: 'VIDEO', exposure: 1000 }),
      makeContextPost({ id: 'v2', media_type: 'VIDEO', exposure: 800 }),
      makeContextPost({ id: 's1', media_type: 'IMAGE', exposure: 200 }),
      makeContextPost({ id: 's2', media_type: 'IMAGE', exposure: 300 }),
    ]
    const insights = generateInsights(posts, defaultOverview)
    expect(insights.some(i => i.text.includes('Reels'))).toBe(true)
  })

  it('generates reach-up-growth-down insight', () => {
    const overview: IgOverview = {
      reach: 2000, reachPrior: 1000,
      engagedUsers: null, engagedPrior: null,
      followerGrowth: 5, followerGrowthPrior: 15,
      followers: 5000,
    }
    const posts = [
      makeContextPost({ id: 'p1' }),
      makeContextPost({ id: 'p2' }),
      makeContextPost({ id: 'p3' }),
    ]
    const insights = generateInsights(posts, overview)
    expect(insights.some(i => i.text.includes('Reach is up'))).toBe(true)
  })

  it('3 posts cannot trigger share concentration (tautological)', () => {
    const posts = [
      makeContextPost({ id: 'p1', shares: 50 }),
      makeContextPost({ id: 'p2', shares: 30 }),
      makeContextPost({ id: 'p3', shares: 20 }),
    ]
    const insights = generateInsights(posts, defaultOverview)
    expect(insights.every(i => !i.text.includes('shares'))).toBe(true)
  })

  it('5+ posts can trigger share concentration when genuinely high', () => {
    const posts = [
      makeContextPost({ id: 'p1', shares: 50 }),
      makeContextPost({ id: 'p2', shares: 30 }),
      makeContextPost({ id: 'p3', shares: 10 }),
      makeContextPost({ id: 'p4', shares: 5 }),
      makeContextPost({ id: 'p5', shares: 5 }),
    ]
    const insights = generateInsights(posts, defaultOverview)
    expect(insights.some(i => i.text.includes('shares'))).toBe(true)
  })

  it('2 video + 1 static does NOT trigger format comparison', () => {
    const posts = [
      makeContextPost({ id: 'v1', media_type: 'VIDEO', exposure: 5000 }),
      makeContextPost({ id: 'v2', media_type: 'VIDEO', exposure: 4000 }),
      makeContextPost({ id: 's1', media_type: 'CAROUSEL_ALBUM', exposure: 100 }),
    ]
    const insights = generateInsights(posts, defaultOverview)
    expect(insights.every(i => !i.text.includes('Reels') && !i.text.includes('Static'))).toBe(true)
  })

  it('2 video + 2 static triggers format comparison when medians differ enough', () => {
    const posts = [
      makeContextPost({ id: 'v1', media_type: 'VIDEO', exposure: 5000 }),
      makeContextPost({ id: 'v2', media_type: 'VIDEO', exposure: 4000 }),
      makeContextPost({ id: 's1', media_type: 'IMAGE', exposure: 500 }),
      makeContextPost({ id: 's2', media_type: 'IMAGE', exposure: 600 }),
    ]
    const insights = generateInsights(posts, defaultOverview)
    expect(insights.some(i => i.text.includes('Reels'))).toBe(true)
  })

  it('sparse data produces no false insight', () => {
    const posts = [
      makeContextPost({ id: 'p1', shares: 1, saved: 1, media_type: 'IMAGE', exposure: 100 }),
      makeContextPost({ id: 'p2', shares: 1, saved: 1, media_type: 'IMAGE', exposure: 110 }),
      makeContextPost({ id: 'p3', shares: 1, saved: 1, media_type: 'IMAGE', exposure: 105 }),
    ]
    const overview: IgOverview = {
      reach: 1000, reachPrior: 1000,
      engagedUsers: null, engagedPrior: null,
      followerGrowth: 10, followerGrowthPrior: 10,
      followers: 5000,
    }
    const insights = generateInsights(posts, overview)
    expect(insights).toEqual([])
  })

  it('insight threshold: no reel-vs-static when ratio is close to 1', () => {
    const posts = [
      makeContextPost({ id: 'v1', media_type: 'VIDEO', exposure: 100 }),
      makeContextPost({ id: 'v2', media_type: 'VIDEO', exposure: 110 }),
      makeContextPost({ id: 's1', media_type: 'IMAGE', exposure: 90 }),
      makeContextPost({ id: 's2', media_type: 'IMAGE', exposure: 100 }),
    ]
    const insights = generateInsights(posts, defaultOverview)
    expect(insights.every(i => !i.text.includes('Reels') && !i.text.includes('Static'))).toBe(true)
  })
})

describe('sortPosts', () => {
  function makeCtxPost(id: string, published: string, exposure: number, shares: number, saves: number): PostWithContext {
    return {
      ...makePost({ id, published_at: published, shares, saved: saves }),
      exposure,
      exposureLabel: 'Reach',
      medianRatio: null,
    }
  }

  const posts = [
    makeCtxPost('a', '2026-09-20', 100, 5, 10),
    makeCtxPost('b', '2026-09-22', 300, 15, 3),
    makeCtxPost('c', '2026-09-21', 200, 8, 20),
  ]

  it('sorts by recent (newest first)', () => {
    const result = sortPosts(posts, 'recent')
    expect(result.map(p => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by exposure (highest first)', () => {
    const result = sortPosts(posts, 'exposure')
    expect(result.map(p => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by shares (highest first)', () => {
    const result = sortPosts(posts, 'shares')
    expect(result.map(p => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by saves (highest first)', () => {
    const result = sortPosts(posts, 'saves')
    expect(result.map(p => p.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('date boundary growth', () => {
  it('IG follower growth uses first and last date in window, not array index', () => {
    // Gap at Sep 14 should not affect growth calculation
    const daily = [
      makeDaily('2026-09-13', 100, 1000),
      // Sep 14 missing
      makeDaily('2026-09-15', 100, 1010),
      makeDaily('2026-09-16', 100, 1020),
    ]
    const result = computeIgOverview(daily, '2026-09-13', '2026-09-16', '2026-09-06', '2026-09-09')
    expect(result.followerGrowth).toBe(20) // 1020 - 1000, not shifted by missing day
  })

  it('FB fan growth uses first and last date in window', () => {
    const fb = [
      makeFbDaily('2026-09-17', 100, 50, 4178),
      makeFbDaily('2026-09-20', 100, 50, 4274),
      makeFbDaily('2026-09-23', 100, 50, 5220),
    ]
    const result = computeFbOverview(fb, '2026-09-17', '2026-09-23', '2026-09-10', '2026-09-16')
    expect(result.fanGrowth).toBe(1042) // 5220 - 4178
  })

  it('missing rows do not silently shift growth windows', () => {
    // Only rows for Sep 20 and Sep 22 — Sep 21 missing
    const daily = [
      makeDaily('2026-09-20', 100, 2000),
      makeDaily('2026-09-22', 100, 2010),
    ]
    const result = computeIgOverview(daily, '2026-09-20', '2026-09-23', '2026-09-13', '2026-09-16')
    // Growth uses Sep 20 and Sep 22 (the actual rows in the window)
    expect(result.followerGrowth).toBe(10)
  })
})

describe('IG engaged users null safety', () => {
  it('returns null when accounts_engaged is all null', () => {
    const daily = [
      makeDaily('2026-09-20', 100, 1000),
      makeDaily('2026-09-21', 200, 1010),
    ]
    const result = computeIgOverview(daily, '2026-09-20', '2026-09-21', '2026-09-10', '2026-09-11')
    expect(result.engagedUsers).toBeNull()
    expect(result.engagedPrior).toBeNull()
  })

  it('sums accounts_engaged when data is available', () => {
    const daily: IgDailyRow[] = [
      { date: '2026-09-20', reach: 100, followers_count: 1000, accounts_engaged: 50, profile_views: null },
      { date: '2026-09-21', reach: 100, followers_count: 1000, accounts_engaged: 60, profile_views: null },
    ]
    const result = computeIgOverview(daily, '2026-09-20', '2026-09-21', '2026-09-10', '2026-09-11')
    expect(result.engagedUsers).toBe(110)
  })
})

describe('FB reach vs views', () => {
  it('returns null reach when fb reach data is all null', () => {
    const fb = [
      makeFbDaily('2026-09-20', 500, 200, 5000),
      makeFbDaily('2026-09-21', 600, 250, 5010),
    ]
    const result = computeFbOverview(fb, '2026-09-20', '2026-09-21', '2026-09-10', '2026-09-11')
    expect(result.reach).toBeNull()
    expect(result.views).toBe(1100) // views still works
  })
})
