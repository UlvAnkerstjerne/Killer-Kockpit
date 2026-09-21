'use server'

import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import type { MarketingPermission, MarketingReviewItem } from '@/lib/marketing/types'
import type { PaidRecommendationRow } from '@/lib/marketing/paid-recs/types'
import { generatePaidRecommendations } from '@/lib/marketing/paid-recs/generate'

// ─── generateAndSavePaidRecommendations ───────────────────────────────────────
//
// Server action called from the API route (CRON_SECRET-gated) and exposed here
// for manual triggering by SUPER_ADMIN.
//
// Authorization: requires paid_manage permission.
// Delegates to the orchestrator which uses createServiceClient internally.

export async function generateAndSavePaidRecommendations(): Promise<{
  ok: boolean
  signalCount?: number
  recommendationCount?: number
  skipped?: boolean
  error?: string
}> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { ok: false, error: 'No marketing access' }
  }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_manage')) {
    return { ok: false, error: 'paid_manage permission required' }
  }

  return generatePaidRecommendations()
}

// ─── approvePaidRecommendation ────────────────────────────────────────────────
//
// Transitions a needs_review recommendation to approved.
// Requires paid_approve permission.

export async function approvePaidRecommendation(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { ok: false, error: 'No marketing access' }
  }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_approve')) {
    return { ok: false, error: 'paid_approve permission required' }
  }

  const db = createServiceClient()
  const { error } = await db
    .from('paid_recommendations')
    .update({
      status:               'approved',
      reviewed_at:          new Date().toISOString(),
      reviewed_by_user_id:  user.id,
    })
    .eq('id', id)
    .eq('status', 'needs_review')  // only transition from needs_review

  if (error) {
    console.error('[paid-recs] approvePaidRecommendation failed:', error)
    return { ok: false, error: 'Failed to approve recommendation.' }
  }
  return { ok: true }
}

// ─── dismissPaidRecommendation ────────────────────────────────────────────────
//
// Transitions a needs_review recommendation to dismissed.
// Requires paid_approve permission.

export async function dismissPaidRecommendation(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { ok: false, error: 'No marketing access' }
  }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_approve')) {
    return { ok: false, error: 'paid_approve permission required' }
  }

  const db = createServiceClient()
  const { error } = await db
    .from('paid_recommendations')
    .update({
      status:               'dismissed',
      reviewed_at:          new Date().toISOString(),
      reviewed_by_user_id:  user.id,
    })
    .eq('id', id)
    .eq('status', 'needs_review')

  if (error) {
    console.error('[paid-recs] dismissPaidRecommendation failed:', error)
    return { ok: false, error: 'Failed to dismiss recommendation.' }
  }
  return { ok: true }
}

// ─── getPendingPaidRecommendations ────────────────────────────────────────────
//
// Returns MarketingReviewItem projections for all needs_review paid recommendations.
// Called from collectPendingReviews in review-items.ts.
// NOT exported as a server action — internal aggregation helper only.

export async function getPendingPaidRecommendations(): Promise<MarketingReviewItem[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('paid_recommendations')
    .select('id,platform,campaign_name,signal_type,urgency,recommended_action,created_at')
    .eq('status', 'needs_review')
    .order('created_at', { ascending: false })

  if (error || !data) return []

  return data.map(row => {
    const platformLabel = row.platform === 'meta' ? 'Meta' : 'Google Ads'
    const signalLabels: Record<string, string> = {
      spend_no_results:   'Spending with no results',
      cpr_worsening:      'Cost per result worsening',
      cpr_improving:      'Cost per result improving',
      strong_performance: 'Strong performance',
    }
    const signalLabel = signalLabels[row.signal_type as string] ?? row.signal_type

    return {
      id:                  row.id as string,
      kind:                'paid_recommendation' as const,
      title:               `${platformLabel} · ${signalLabel}`,
      description:         (row.recommended_action as string | null)?.slice(0, 120) ?? null,
      created_at:          row.created_at as string,
      requires_permission: 'paid_approve' as MarketingPermission,
    }
  })
}

// ─── getPaidRecommendations ───────────────────────────────────────────────────
//
// Returns all needs_review recommendations and recently approved ones (last 14 days).
// Used by the paid page to render the recommendations section.
// Caller must have paid_manage permission (verified by the page server component).

export async function getPaidRecommendations(): Promise<PaidRecommendationRow[]> {
  const user = await getCurrentUser()
  if (!user) return []
  if (!canAccessMarketing(user.role, user.marketing_access)) return []
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_manage')) return []

  const db = createServiceClient()
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await db
    .from('paid_recommendations')
    .select('*')
    .or(`status.eq.needs_review,and(status.eq.approved,reviewed_at.gte.${cutoff})`)
    .order('created_at', { ascending: false })

  if (error || !data) return []
  return data as PaidRecommendationRow[]
}
