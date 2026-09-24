/**
 * lib/actions/marketing/organic-utils.ts
 *
 * Pure analytics functions for the Organic Performance dashboard.
 * No 'use server' — importable from tests and client code.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IgDailyRow {
  date: string
  reach: number | null
  followers_count: number | null
  accounts_engaged: number | null
  profile_views: number | null
}

export interface IgPostRow {
  id: string
  media_type: string
  caption: string | null
  permalink: string | null
  published_at: string | null
  media_url: string | null
  thumbnail_url: string | null
  reach: number | null
  plays: number | null
  saved: number | null
  likes: number | null
  comments_count: number | null
  shares: number | null
  total_interactions: number | null
}

export interface FbDailyRow {
  date: string
  views: number | null
  reach: number | null
  engaged_users: number | null
  fan_count: number | null
}

// ── Aggregated types ──────────────────────────────────────────────────────────

export interface IgOverview {
  reach:            number
  reachPrior:       number
  followerGrowth:   number | null
  followerGrowthPrior: number | null
  followers:        number | null
}

export interface FbOverview {
  views:            number
  viewsPrior:       number
  engagedUsers:     number
  engagedPrior:     number
  fanGrowth:        number | null
  fanGrowthPrior:   number | null
  fans:             number | null
}

export interface PostWithContext extends IgPostRow {
  /** Primary exposure metric value: plays for VIDEO, reach for IMAGE/CAROUSEL */
  exposure: number
  /** Label for the exposure metric */
  exposureLabel: string
  /** Ratio vs median of compatible posts. null if baseline too small. */
  medianRatio: number | null
}

export interface Insight {
  text: string
}

// ── Period helpers ─────────────────────────────────────────────────────────────

export function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

function filterByDate<T extends { date: string }>(rows: T[], start: string, end: string): T[] {
  return rows.filter(r => r.date >= start && r.date <= end)
}

// ── Instagram overview ────────────────────────────────────────────────────────

export function computeIgOverview(
  daily: IgDailyRow[],
  curStart: string,
  curEnd: string,
  priStart: string,
  priEnd: string,
): IgOverview {
  const cur = filterByDate(daily, curStart, curEnd)
  const pri = filterByDate(daily, priStart, priEnd)

  const reach = cur.reduce((a, r) => a + (r.reach ?? 0), 0)
  const reachPrior = pri.reduce((a, r) => a + (r.reach ?? 0), 0)

  // Follower growth = last day followers - first day followers in the window
  const followerGrowth = computeFollowerGrowth(cur)
  const followerGrowthPrior = computeFollowerGrowth(pri)

  const sorted = [...cur].sort((a, b) => b.date.localeCompare(a.date))
  const followers = sorted[0]?.followers_count ?? null

  return { reach, reachPrior, followerGrowth, followerGrowthPrior, followers }
}

export function computeFollowerGrowth(rows: IgDailyRow[]): number | null {
  const withFollowers = rows.filter(r => r.followers_count != null).sort((a, b) => a.date.localeCompare(b.date))
  if (withFollowers.length < 2) return null
  return withFollowers[withFollowers.length - 1].followers_count! - withFollowers[0].followers_count!
}

// ── Facebook overview ─────────────────────────────────────────────────────────

export function computeFbOverview(
  daily: FbDailyRow[],
  curStart: string,
  curEnd: string,
  priStart: string,
  priEnd: string,
): FbOverview {
  const cur = filterByDate(daily, curStart, curEnd)
  const pri = filterByDate(daily, priStart, priEnd)

  const views = cur.reduce((a, r) => a + (r.views ?? 0), 0)
  const viewsPrior = pri.reduce((a, r) => a + (r.views ?? 0), 0)
  const engagedUsers = cur.reduce((a, r) => a + (r.engaged_users ?? 0), 0)
  const engagedPrior = pri.reduce((a, r) => a + (r.engaged_users ?? 0), 0)

  const fanGrowth = computeFanGrowth(cur)
  const fanGrowthPrior = computeFanGrowth(pri)

  const sorted = [...cur].sort((a, b) => b.date.localeCompare(a.date))
  const fans = sorted[0]?.fan_count ?? null

  return { views, viewsPrior, engagedUsers, engagedPrior, fanGrowth, fanGrowthPrior, fans }
}

function computeFanGrowth(rows: FbDailyRow[]): number | null {
  const withFans = rows.filter(r => r.fan_count != null).sort((a, b) => a.date.localeCompare(b.date))
  if (withFans.length < 2) return null
  return withFans[withFans.length - 1].fan_count! - withFans[0].fan_count!
}

// ── Post performance context ──────────────────────────────────────────────────

function getExposure(post: IgPostRow): { value: number; label: string } {
  const isVideo = post.media_type === 'VIDEO' || post.media_type === 'REEL'
  if (isVideo && post.plays != null) return { value: post.plays, label: 'Views' }
  if (post.reach != null) return { value: post.reach, label: 'Reach' }
  return { value: 0, label: isVideo ? 'Views' : 'Reach' }
}

function isVideoType(type: string): boolean {
  return type === 'VIDEO' || type === 'REEL'
}

export function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Add performance context to each post by comparing against compatible posts.
 * Videos/Reels compare against videos/reels. Static/carousels compare against static/carousels.
 * Minimum 3 compatible posts required for a meaningful median.
 */
export function addPostContext(posts: IgPostRow[], allPosts: IgPostRow[]): PostWithContext[] {
  // Build median baselines from ALL posts (not just the period slice)
  const videoExposures = allPosts
    .filter(p => isVideoType(p.media_type) && p.plays != null && p.plays > 0)
    .map(p => p.plays!)
  const staticExposures = allPosts
    .filter(p => !isVideoType(p.media_type) && p.reach != null && p.reach > 0)
    .map(p => p.reach!)

  const videoMedian = videoExposures.length >= 3 ? median(videoExposures) : null
  const staticMedian = staticExposures.length >= 3 ? median(staticExposures) : null

  return posts.map(post => {
    const { value, label } = getExposure(post)
    const isVid = isVideoType(post.media_type)
    const baseline = isVid ? videoMedian : staticMedian
    const medianRatio = baseline != null && baseline > 0 && value > 0
      ? value / baseline
      : null

    return { ...post, exposure: value, exposureLabel: label, medianRatio }
  })
}

// ── "What's working" insights ─────────────────────────────────────────────────

const MIN_POSTS_FOR_INSIGHT = 3

export function generateInsights(
  posts: PostWithContext[],
  igOverview: IgOverview,
): Insight[] {
  const insights: Insight[] = []
  if (posts.length < MIN_POSTS_FOR_INSIGHT) return insights

  // 1. Reels vs static exposure comparison
  const videoPostsWithExposure = posts.filter(p => isVideoType(p.media_type) && p.exposure > 0)
  const staticPostsWithExposure = posts.filter(p => !isVideoType(p.media_type) && p.exposure > 0)

  if (videoPostsWithExposure.length >= 2 && staticPostsWithExposure.length >= 2) {
    const videoMedianExp = median(videoPostsWithExposure.map(p => p.exposure))
    const staticMedianExp = median(staticPostsWithExposure.map(p => p.exposure))
    if (staticMedianExp > 0) {
      const ratio = videoMedianExp / staticMedianExp
      if (ratio >= 1.5) {
        insights.push({
          text: `Reels are generating ${ratio.toFixed(1)}× the median exposure of static posts this period.`,
        })
      } else if (ratio <= 0.67) {
        insights.push({
          text: `Static posts are outperforming Reels on median exposure by ${(1 / ratio).toFixed(1)}× this period.`,
        })
      }
    }
  }

  // 2. Share concentration
  const totalShares = posts.reduce((a, p) => a + (p.shares ?? 0), 0)
  if (totalShares >= 5) {
    const sorted = [...posts].sort((a, b) => (b.shares ?? 0) - (a.shares ?? 0))
    const top3Shares = sorted.slice(0, 3).reduce((a, p) => a + (p.shares ?? 0), 0)
    const pct = (top3Shares / totalShares) * 100
    if (pct >= 50) {
      insights.push({
        text: `Your top 3 posts account for ${Math.round(pct)}% of shares this period.`,
      })
    }
  }

  // 3. Save concentration
  const totalSaves = posts.reduce((a, p) => a + (p.saved ?? 0), 0)
  if (totalSaves >= 5) {
    const sorted = [...posts].sort((a, b) => (b.saved ?? 0) - (a.saved ?? 0))
    const top3Saves = sorted.slice(0, 3).reduce((a, p) => a + (p.saved ?? 0), 0)
    const pct = (top3Saves / totalSaves) * 100
    if (pct >= 50) {
      insights.push({
        text: `Saves are concentrated: top 3 posts hold ${Math.round(pct)}% of all saves.`,
      })
    }
  }

  // 4. Follower growth vs reach direction
  if (igOverview.followerGrowth !== null && igOverview.followerGrowthPrior !== null && igOverview.reachPrior > 0) {
    const reachUp = igOverview.reach > igOverview.reachPrior
    const growthUp = igOverview.followerGrowth > igOverview.followerGrowthPrior
    if (reachUp && !growthUp) {
      insights.push({
        text: `Reach is up vs prior period but follower growth has slowed — content may be reaching non-followers who aren't converting.`,
      })
    } else if (!reachUp && growthUp) {
      insights.push({
        text: `Follower growth is up despite lower reach — recent content may be converting visitors more efficiently.`,
      })
    }
  }

  // 5. Carousel vs image comparison (if enough samples)
  const carousels = posts.filter(p => p.media_type === 'CAROUSEL_ALBUM' && p.exposure > 0)
  const images = posts.filter(p => p.media_type === 'IMAGE' && p.exposure > 0)
  if (carousels.length >= 2 && images.length >= 2) {
    const carouselMedian = median(carousels.map(p => p.exposure))
    const imageMedian = median(images.map(p => p.exposure))
    if (imageMedian > 0) {
      const ratio = carouselMedian / imageMedian
      if (ratio >= 1.5) {
        insights.push({
          text: `Carousel posts are reaching ${ratio.toFixed(1)}× the median of single images.`,
        })
      }
    }
  }

  return insights
}

// ── Sorting helpers ───────────────────────────────────────────────────────────

export type SortMode = 'recent' | 'exposure' | 'shares' | 'saves'

export function sortPosts(posts: PostWithContext[], mode: SortMode): PostWithContext[] {
  const sorted = [...posts]
  switch (mode) {
    case 'recent':
      return sorted.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
    case 'exposure':
      return sorted.sort((a, b) => b.exposure - a.exposure)
    case 'shares':
      return sorted.sort((a, b) => (b.shares ?? 0) - (a.shares ?? 0))
    case 'saves':
      return sorted.sort((a, b) => (b.saved ?? 0) - (a.saved ?? 0))
  }
}
