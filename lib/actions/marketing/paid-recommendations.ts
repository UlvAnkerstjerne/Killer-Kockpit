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
// "Approve & start": atomically claims the recommendation, then executes
// its structured plan (create Task, start monitoring, or both).
// Idempotent: double-click cannot create duplicate tasks.
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
  const now = new Date().toISOString()

  // 1. Atomic claim: only transition from needs_review + pending_approval
  const { data: claimed, error: claimError } = await db
    .from('paid_recommendations')
    .update({
      status:               'approved',
      reviewed_at:          now,
      reviewed_by_user_id:  user.id,
      execution_status:     'in_motion',
      execution_started_at: now,
    })
    .eq('id', id)
    .eq('status', 'needs_review')
    .eq('execution_status', 'pending_approval')
    .select('id, execution_type, signal_type, platform, campaign_id, campaign_name, what_changed, evidence, interpretation, recommended_action, urgency, spend_7d, result_count_7d, cpr_7d')
    .maybeSingle()

  if (claimError) {
    console.error('[paid-recs] claim failed:', claimError)
    return { ok: false, error: 'Failed to approve recommendation.' }
  }
  if (!claimed) {
    // Already claimed by another request — idempotent success
    return { ok: true }
  }

  // 2. Execute the plan
  const executionType = claimed.execution_type as string | null
  const executionResult: Record<string, unknown> = {}
  let linkedTaskId: string | null = null

  // 2a. Create Task if needed
  if (executionType === 'create_task' || executionType === 'create_task_and_monitor') {
    try {
      const platformLabel = claimed.platform === 'meta' ? 'Meta' : 'Google Ads'
      const signalVerbs: Record<string, string> = {
        spend_no_results: 'Verify tracking',
        cpr_worsening: 'Investigate performance',
        cpr_improving: 'Review and optimise',
        strong_performance: 'Review scaling opportunity',
      }
      const verb = signalVerbs[claimed.signal_type as string] ?? 'Review'
      const shortCampaign = (claimed.campaign_name as string).length > 50
        ? (claimed.campaign_name as string).slice(0, 47) + '...'
        : claimed.campaign_name as string
      const taskTitle = `${verb} — ${shortCampaign}`
      const taskDescription = [
        `**${platformLabel} · ${claimed.campaign_name}**`,
        '',
        `**What changed:** ${claimed.what_changed}`,
        '',
        `**Evidence:** ${claimed.evidence}`,
        '',
        `**Interpretation:** ${claimed.interpretation}`,
        '',
        `**Recommended action:** ${claimed.recommended_action}`,
        '',
        `_Created automatically from a paid recommendation._`,
      ].join('\n')

      // Due date based on urgency
      const urgencyDays: Record<string, number> = { high: 0, medium: 1, low: 3 }
      const dueDays = urgencyDays[claimed.urgency as string] ?? 1
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + dueDays)
      const dueAt = dueDate.toISOString()

      // Priority: high=1, medium=2, low=3
      const priorityMap: Record<string, 1 | 2 | 3> = { high: 1, medium: 2, low: 3 }
      const priority = priorityMap[claimed.urgency as string] ?? 2

      const { normalizeTaskCreateInput, insertTaskWithAudit } = await import('@/lib/domain/task-creation')
      const normalized = normalizeTaskCreateInput({
        title: taskTitle,
        description: taskDescription,
        owner_user_id: user.id,
        priority,
        due_at: dueAt,
      }, user.id)

      if (!normalized.ok) throw new Error(normalized.error)
      const taskResult = await insertTaskWithAudit(db, user.id, normalized.data)
      if (taskResult.error || !taskResult.id) throw new Error('Task creation failed')

      linkedTaskId = taskResult.id
      executionResult.task_title = taskTitle
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[paid-recs] Task creation failed:', msg)
      await db.from('paid_recommendations').update({
        execution_status: 'failed',
        execution_result: { error: `Task creation failed: ${msg}` },
      }).eq('id', id)
      return { ok: false, error: 'Recommendation approved but task creation failed.' }
    }
  }

  // 2b. Start monitoring if needed
  if (executionType === 'monitor' || executionType === 'create_task_and_monitor') {
    const monitorStart = now
    const monitorEnd = new Date()
    monitorEnd.setDate(monitorEnd.getDate() + 5)

    executionResult.monitoring = {
      monitor_start: monitorStart,
      monitor_end: monitorEnd.toISOString(),
      campaign_id: claimed.campaign_id,
      platform: claimed.platform,
      baseline: {
        spend_7d: claimed.spend_7d,
        result_count_7d: claimed.result_count_7d,
        cpr_7d: claimed.cpr_7d,
      },
    }
  }

  // 3. Store execution result and linked task
  const { error: updateError } = await db
    .from('paid_recommendations')
    .update({
      execution_result: executionResult,
      linked_task_id: linkedTaskId,
    })
    .eq('id', id)

  if (updateError) {
    console.error('[paid-recs] execution result update failed:', updateError)
  }

  // 4. Audit event
  await db.from('audit_events').insert({
    actor_user_id: user.id,
    actor_type: 'human',
    action: 'marketing.paid_recommendation.approved_and_started',
    entity_type: 'paid_recommendation',
    entity_id: id,
    after_json: {
      execution_type: executionType,
      linked_task_id: linkedTaskId,
      monitoring: executionResult.monitoring ?? null,
    },
  })

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
    .or(`status.eq.needs_review,and(status.eq.approved,reviewed_at.gte.${cutoff}),and(status.eq.approved,execution_status.eq.in_motion)`)
    .order('created_at', { ascending: false })

  if (error || !data) return []
  return data as PaidRecommendationRow[]
}
