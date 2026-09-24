'use server'

/**
 * lib/actions/marketing/organic-performance.ts
 *
 * Server action for the Organic Performance dashboard.
 * Fetches IG daily + media + FB insights and delegates to organic-utils for aggregation.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import {
  computeIgOverview,
  computeFbOverview,
  addPostContext,
  generateInsights,
  daysAgoStr,
} from './organic-utils'
import type {
  IgOverview,
  FbOverview,
  PostWithContext,
  Insight,
  IgDailyRow,
  IgPostRow,
  FbDailyRow,
} from './organic-utils'

export type { IgOverview, FbOverview, PostWithContext, Insight, IgDailyRow, FbDailyRow }

export interface OrganicData {
  igOverview7:   IgOverview
  igOverview28:  IgOverview
  igDaily:       IgDailyRow[]
  posts7:        PostWithContext[]
  posts28:       PostWithContext[]
  insights7:     Insight[]
  insights28:    Insight[]
  fbOverview7:   FbOverview
  fbOverview28:  FbOverview
  fbDaily:       FbDailyRow[]
  hasData:       boolean
}

// ── Pagination helper ─────────────────────────────────────────────────────────

const PAGE_SIZE = 1000

async function fetchAllPages<T>(
  fetcher: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  for (;;) {
    const { data } = await fetcher(from, from + PAGE_SIZE - 1)
    const page = data ?? []
    all.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

// ── Main action ───────────────────────────────────────────────────────────────

export async function getOrganicPerformance(): Promise<OrganicData> {
  const EMPTY: OrganicData = {
    igOverview7: { reach: 0, reachPrior: 0, engagedUsers: null, engagedPrior: null, followerGrowth: null, followerGrowthPrior: null, followers: null },
    igOverview28: { reach: 0, reachPrior: 0, engagedUsers: null, engagedPrior: null, followerGrowth: null, followerGrowthPrior: null, followers: null },
    igDaily: [], posts7: [], posts28: [], insights7: [], insights28: [],
    fbOverview7: { reach: null, reachPrior: null, views: 0, viewsPrior: 0, engagedUsers: 0, engagedPrior: 0, fanGrowth: null, fanGrowthPrior: null, fans: null },
    fbOverview28: { reach: null, reachPrior: null, views: 0, viewsPrior: 0, engagedUsers: 0, engagedPrior: 0, fanGrowth: null, fanGrowthPrior: null, fans: null },
    fbDaily: [], hasData: false,
  }

  const user = await getCurrentUser()
  if (!user) return EMPTY
  if (!canAccessMarketing(user.role, user.marketing_access)) return EMPTY
  const db = createServiceClient()
  const { data: permRows } = await db.from('user_marketing_permissions').select('permission').eq('user_id', user.id)
  const permissions = (permRows ?? []).map(r => r.permission as string)
  if (user.role !== 'SUPER_ADMIN' && !permissions.includes('paid_manage')) return EMPTY

  // Date windows: need 56 days back (28d current + 28d prior)
  const since = daysAgoStr(60)
  const curEnd = daysAgoStr(1)

  const [igDailyData, igMediaData, fbDailyData] = await Promise.all([
    db.from('meta_ig_account_daily')
      .select('date, reach, followers_count, accounts_engaged, profile_views')
      .gte('date', since)
      .order('date', { ascending: true }),
    fetchAllPages<IgPostRow>(
      (from, to) => db.from('meta_ig_media')
        .select('id, media_type, caption, permalink, published_at, media_url, thumbnail_url, reach, plays, saved, likes, comments_count, shares, total_interactions')
        .order('published_at', { ascending: false })
        .range(from, to),
    ),
    db.from('meta_fb_page_insights')
      .select('date, views, reach, engaged_users, fan_count')
      .gte('date', since)
      .order('date', { ascending: true }),
  ])

  const igDaily = (igDailyData.data ?? []) as IgDailyRow[]
  const allPosts = igMediaData as IgPostRow[]
  const fbDaily = (fbDailyData.data ?? []) as FbDailyRow[]

  if (igDaily.length === 0 && allPosts.length === 0) return EMPTY

  // Period boundaries
  const cur7Start  = daysAgoStr(7)
  const pri7Start  = daysAgoStr(14)
  const pri7End    = daysAgoStr(8)
  const cur28Start = daysAgoStr(28)
  const pri28Start = daysAgoStr(56)
  const pri28End   = daysAgoStr(29)

  // IG overviews
  const igOverview7  = computeIgOverview(igDaily, cur7Start, curEnd, pri7Start, pri7End)
  const igOverview28 = computeIgOverview(igDaily, cur28Start, curEnd, pri28Start, pri28End)

  // Posts for each period
  const postsInPeriod = (start: string) =>
    allPosts.filter(p => p.published_at && p.published_at.slice(0, 10) >= start && p.published_at.slice(0, 10) <= curEnd)

  const posts7  = addPostContext(postsInPeriod(cur7Start), allPosts)
  const posts28 = addPostContext(postsInPeriod(cur28Start), allPosts)

  // Insights
  const insights7  = generateInsights(posts7, igOverview7)
  const insights28 = generateInsights(posts28, igOverview28)

  // FB overviews
  const fbOverview7  = computeFbOverview(fbDaily, cur7Start, curEnd, pri7Start, pri7End)
  const fbOverview28 = computeFbOverview(fbDaily, cur28Start, curEnd, pri28Start, pri28End)

  return {
    igOverview7, igOverview28,
    igDaily, posts7, posts28, insights7, insights28,
    fbOverview7, fbOverview28, fbDaily,
    hasData: true,
  }
}
