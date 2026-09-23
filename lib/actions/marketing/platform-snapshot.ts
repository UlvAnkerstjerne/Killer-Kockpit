'use server'

/**
 * lib/actions/marketing/platform-snapshot.ts
 *
 * Fetches a lightweight platform snapshot for the Morning Brief page cards.
 * Queries raw data tables directly so the snapshot is always current,
 * independent of when the last Morning Brief was generated.
 *
 * Auth: getCurrentUser() required. Data is read via service_role (aggregate
 * marketing data, not per-user) — user identity is verified before access.
 *
 * Windows:
 *   Instagram / Facebook / Meta Paid / GA4 — 7d vs prior 7d
 *   GBP — 28d vs prior 28d (matches existing signal pattern)
 */

import { getCurrentUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlatformSnapshotData {
  ig: {
    reach_7d: number
    reach_change_pct: number | null
    engaged_7d: number
    engaged_change_pct: number | null
    followers: number | null
    followers_delta: number | null
  }
  fb: {
    page_views_7d: number
    page_views_change_pct: number | null
    engaged_users_7d: number
    engaged_change_pct: number | null
    fans: number | null
    fans_delta: number | null
  }
  meta_paid: {
    impressions_7d: number
    impressions_change_pct: number | null
    spend_7d: number
    spend_change_pct: number | null
    clicks_7d: number
    clicks_change_pct: number | null
  }
  gbp: {
    impressions_7d: number
    impressions_change_pct: number | null
    directions_7d: number
    directions_change_pct: number | null
    website_clicks_7d: number
  }
  ga4: {
    sessions_7d: number
    sessions_change_pct: number | null
    new_users_7d: number
    new_users_change_pct: number | null
    page_views_7d: number
    page_views_change_pct: number | null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function changePct(current: number, prior: number): number | null {
  if (prior === 0) return null
  return (current - prior) / prior
}

function sumCol(rows: Record<string, unknown>[], key: string): number {
  return rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getPlatformSnapshot(): Promise<PlatformSnapshotData | null> {
  try {
    const user = await getCurrentUser()
    if (!user) return null

    const db = createServiceClient()
    const d7  = daysAgo(7)
    const d14 = daysAgo(14)
    const d28 = daysAgo(28)
    const d56 = daysAgo(56)

    const [ga4Res, igRes, fbRes, paidRes, gbpRes] = await Promise.all([
      db.from('ga4_daily')
        .select('date, sessions, new_users, page_views')
        .gte('date', d14),
      db.from('meta_ig_account_daily')
        .select('date, reach, accounts_engaged, followers_count')
        .gte('date', d14)
        .order('date', { ascending: true }),
      db.from('meta_fb_page_insights')
        .select('date, views, engaged_users, fan_count')
        .gte('date', d14)
        .order('date', { ascending: true }),
      db.from('meta_campaign_insights')
        .select('date_start, impressions, spend, clicks')
        .gte('date_start', d14),
      db.from('gbp_location_metrics')
        .select('date, total_impressions, direction_requests, website_clicks')
        .gte('date', d14),
    ])

    // ── GA4 ──────────────────────────────────────────────────────────────────
    const ga4 = (ga4Res.data ?? []) as Record<string, unknown>[]
    const ga4Cur  = ga4.filter(r => (r.date as string) >= d7)
    const ga4Prev = ga4.filter(r => (r.date as string) < d7)
    const sessions_7d    = sumCol(ga4Cur,  'sessions')
    const sessions_prior = sumCol(ga4Prev, 'sessions')
    const new_users_7d    = sumCol(ga4Cur,  'new_users')
    const new_users_prior = sumCol(ga4Prev, 'new_users')
    const page_views_7d    = sumCol(ga4Cur,  'page_views')
    const page_views_prior = sumCol(ga4Prev, 'page_views')

    // ── Instagram ─────────────────────────────────────────────────────────────
    const ig    = (igRes.data ?? []) as Record<string, unknown>[]
    const igCur = ig.filter(r => (r.date as string) >= d7)
    const igPrev = ig.filter(r => (r.date as string) < d7)
    const reach_7d    = sumCol(igCur,  'reach')
    const reach_prior = sumCol(igPrev, 'reach')
    const ig_engaged_7d    = sumCol(igCur,  'accounts_engaged')
    const ig_engaged_prior = sumCol(igPrev, 'accounts_engaged')
    const igFollowers    = igCur.map(r => Number(r.followers_count) || 0).filter(v => v > 0)
    const followers      = igFollowers.length ? igFollowers[igFollowers.length - 1] : null
    const followersStart = igFollowers.length ? igFollowers[0] : null
    const followers_delta = followers !== null && followersStart !== null
      ? followers - followersStart
      : null

    // ── Facebook ──────────────────────────────────────────────────────────────
    const fb    = (fbRes.data ?? []) as Record<string, unknown>[]
    const fbCur = fb.filter(r => (r.date as string) >= d7)
    const fbPrev = fb.filter(r => (r.date as string) < d7)
    const views_7d    = sumCol(fbCur,  'views')
    const views_prior = sumCol(fbPrev, 'views')
    const engaged_7d    = sumCol(fbCur,  'engaged_users')
    const engaged_prior = sumCol(fbPrev, 'engaged_users')
    const fbFans    = fbCur.map(r => Number(r.fan_count) || 0).filter(v => v > 0)
    const fans      = fbFans.length ? fbFans[fbFans.length - 1] : null
    const fansStart = fbFans.length ? fbFans[0] : null
    const fans_delta = fans !== null && fansStart !== null ? fans - fansStart : null

    // ── Meta Paid ─────────────────────────────────────────────────────────────
    const paid     = (paidRes.data ?? []) as Record<string, unknown>[]
    const paidCur  = paid.filter(r => (r.date_start as string) >= d7)
    const paidPrev = paid.filter(r => (r.date_start as string) < d7)
    const impressions_7d         = sumCol(paidCur,  'impressions')
    const paid_impressions_prior = sumCol(paidPrev, 'impressions')
    const spend_7d               = sumCol(paidCur,  'spend')
    const spend_prior            = sumCol(paidPrev, 'spend')
    const clicks_7d              = sumCol(paidCur,  'clicks')
    const clicks_prior           = sumCol(paidPrev, 'clicks')

    // ── GBP ───────────────────────────────────────────────────────────────────
    const gbp    = (gbpRes.data ?? []) as Record<string, unknown>[]
    const gbpCur = gbp.filter(r => (r.date as string) >= d7)
    const gbpPrev = gbp.filter(r => (r.date as string) < d7)
    const gbp_impressions_7d    = sumCol(gbpCur,  'total_impressions')
    const gbp_impressions_prior = sumCol(gbpPrev, 'total_impressions')
    const directions_7d         = sumCol(gbpCur,  'direction_requests')
    const directions_prior      = sumCol(gbpPrev, 'direction_requests')
    const website_clicks_7d     = sumCol(gbpCur, 'website_clicks')

    return {
      ig: {
        reach_7d,
        reach_change_pct: changePct(reach_7d, reach_prior),
        engaged_7d: ig_engaged_7d,
        engaged_change_pct: changePct(ig_engaged_7d, ig_engaged_prior),
        followers,
        followers_delta,
      },
      fb: {
        page_views_7d: views_7d,
        page_views_change_pct: changePct(views_7d, views_prior),
        engaged_users_7d: engaged_7d,
        engaged_change_pct: changePct(engaged_7d, engaged_prior),
        fans,
        fans_delta,
      },
      meta_paid: {
        impressions_7d,
        impressions_change_pct: changePct(impressions_7d, paid_impressions_prior),
        spend_7d,
        spend_change_pct: changePct(spend_7d, spend_prior),
        clicks_7d,
        clicks_change_pct: changePct(clicks_7d, clicks_prior),
      },
      gbp: {
        impressions_7d: gbp_impressions_7d,
        impressions_change_pct: changePct(gbp_impressions_7d, gbp_impressions_prior),
        directions_7d,
        directions_change_pct: changePct(directions_7d, directions_prior),
        website_clicks_7d,
      },
      ga4: {
        sessions_7d,
        sessions_change_pct: changePct(sessions_7d, sessions_prior),
        new_users_7d,
        new_users_change_pct: changePct(new_users_7d, new_users_prior),
        page_views_7d,
        page_views_change_pct: changePct(page_views_7d, page_views_prior),
      },
    }
  } catch (err) {
    console.error('[platform-snapshot]', (err as Error).message)
    return null
  }
}
