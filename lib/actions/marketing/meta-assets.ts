'use server'

/**
 * lib/actions/marketing/meta-assets.ts
 *
 * Self-authenticating server actions for reading Meta M3 data.
 *
 * Trust-boundary contract (identical to all Marketing server actions):
 *   - Actor identity ALWAYS comes from getCurrentUser() — never from the caller.
 *   - canAccessMarketing() and hasMarketingPermission() checked server-side.
 *   - Callers may supply only IDs and date ranges. No userId/role/permission context.
 *   - All DB access uses createServiceClient() (service_role, bypasses RLS).
 *
 * Permission: paid_manage gates all Meta read actions.
 * SUPER_ADMIN bypasses the permission check.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import type {
  MetaCampaignRow,
  MetaCampaignInsightRow,
  MetaIgMediaRow,
  MetaFbPageInsightRow,
  MetaSyncStatusRow,
} from '@/lib/marketing/types/meta'

// ── Internal auth helper ───────────────────────────────────────────────────────

async function assertPaidManage() {
  const user = await getCurrentUser()
  if (!user) return { user: null as null, error: 'Not authenticated.' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { user: null as null, error: 'Marketing access required.' }
  }
  const db = createServiceClient()
  const { data: permRows } = await db
    .from('user_marketing_permissions')
    .select('permission')
    .eq('user_id', user.id)
  const permissions = (permRows ?? []).map((r) => r.permission as import('@/lib/marketing/types').MarketingPermission)
  if (!hasMarketingPermission(user.role, permissions, 'paid_manage')) {
    return { user: null as null, error: 'paid_manage permission required.' }
  }
  return { user, error: undefined as undefined }
}

// ── getMetaCampaigns ───────────────────────────────────────────────────────────

export async function getMetaCampaigns(): Promise<MetaCampaignRow[]> {
  const { user, error } = await assertPaidManage()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('meta_ad_campaigns')
    .select('id, ad_account_id, name, status, objective, daily_budget, lifetime_budget, created_at_meta, synced_at')
    .order('name')

  return (data ?? []) as MetaCampaignRow[]
}

// ── getMetaCampaignInsights ────────────────────────────────────────────────────

export async function getMetaCampaignInsights(
  campaignId: string,
  startDate:  string,  // "YYYY-MM-DD"
  endDate:    string,
): Promise<MetaCampaignInsightRow[]> {
  const { user, error } = await assertPaidManage()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('meta_campaign_insights')
    .select(`
      campaign_id, date_start, impressions, reach, clicks, inline_link_clicks,
      spend, cpm, cpc, ctr, frequency,
      actions_json, cost_per_action_json, action_values_json
    `)
    .eq('campaign_id', campaignId)
    .gte('date_start', startDate)
    .lte('date_start', endDate)
    .order('date_start', { ascending: false })

  return (data ?? []) as MetaCampaignInsightRow[]
}

// ── getIgMediaFeed ─────────────────────────────────────────────────────────────

export async function getIgMediaFeed(limit = 50): Promise<MetaIgMediaRow[]> {
  const { user, error } = await assertPaidManage()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('meta_ig_media')
    .select(`
      id, ig_account_id, media_type, caption, permalink, published_at,
      reach, plays, saved, likes, comments_count, shares, total_interactions,
      other_metrics_json, synced_at
    `)
    .order('published_at', { ascending: false })
    .limit(limit)

  return (data ?? []) as MetaIgMediaRow[]
}

// ── getFbPageInsights ──────────────────────────────────────────────────────────

export async function getFbPageInsights(
  startDate: string,
  endDate:   string,
): Promise<MetaFbPageInsightRow[]> {
  const { user, error } = await assertPaidManage()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('meta_fb_page_insights')
    .select('page_id, date, views, reach, engaged_users, fan_count, other_metrics_json')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: false })

  return (data ?? []) as MetaFbPageInsightRow[]
}

// ── getMetaSyncStatus ──────────────────────────────────────────────────────────

export async function getMetaSyncStatus(): Promise<MetaSyncStatusRow[]> {
  const { user, error } = await assertPaidManage()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('integration_sync_state')
    .select('integration, status, cursor, last_success_at, last_attempt_at, last_error')
    .like('integration', 'meta_%')
    .is('user_id', null)
    .order('integration')

  return (data ?? []) as MetaSyncStatusRow[]
}
