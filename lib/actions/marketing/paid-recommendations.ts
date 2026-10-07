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
// Approves and executes a paid recommendation's trusted plan.
// Idempotent: double-click cannot create duplicate side effects.
// Requires paid_approve permission.
//
// Execution status semantics:
//   Status toggles (pause/resume) → completed immediately after verified read-back
//   Budget changes → in_motion (5-day monitoring window)
//   Diagnostics → completed (with or without Task depending on classification)
//   Monitor-only → in_motion for monitoring window
//   Create-task → completed once Task exists

/** Log an execution event. Never throws — event logging must not break the execution path. */
async function logExecEvent(
  db: ReturnType<typeof createServiceClient>,
  recId: string, actorId: string, phase: string, detail?: Record<string, unknown>,
) {
  try {
    await db.from('paid_recommendation_execution_events').insert({
      recommendation_id: recId, actor_user_id: actorId, phase,
      ...(detail ? { detail } : {}),
    })
  } catch (err) {
    console.error('[paid-recs] execution event insert failed:', (err as Error).message)
  }
}

/** Log an audit event. Never throws. */
async function logAuditEvent(
  db: ReturnType<typeof createServiceClient>,
  actorId: string, recId: string, afterJson: Record<string, unknown>,
) {
  try {
    await db.from('audit_events').insert({
      actor_user_id: actorId,
      actor_type: 'human',
      action: 'marketing.paid_recommendation.approved_and_executed',
      entity_type: 'paid_recommendation',
      entity_id: recId,
      after_json: afterJson,
    })
  } catch (err) {
    console.error('[paid-recs] audit event insert failed:', (err as Error).message)
  }
}

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
      execution_status:     'executing',
      execution_started_at: now,
    })
    .eq('id', id)
    .eq('status', 'needs_review')
    .eq('execution_status', 'pending_approval')
    .select('id, execution_type, execution_plan, signal_type, platform, campaign_id, campaign_name, what_changed, evidence, interpretation, recommended_action, urgency, spend_7d, result_count_7d, cpr_7d, currency')
    .maybeSingle()

  if (claimError) {
    console.error('[paid-recs] claim failed:', claimError)
    return { ok: false, error: 'Failed to approve recommendation.' }
  }
  if (!claimed) {
    return { ok: true }
  }

  const executionType = claimed.execution_type as string | null
  const executionResult: Record<string, unknown> = {}
  let linkedTaskId: string | null = null

  await logExecEvent(db, id, user.id, 'claimed')

  // ── Platform action (pause / resume / budget change) ──────────────────
  if (executionType === 'platform_action') {
    const { executeTrustedPlan } = await import('@/lib/marketing/paid-recs/executor')
    const { PaidRecExecutionPlanSchema } = await import('@/lib/marketing/paid-recs/types')
    const plan = PaidRecExecutionPlanSchema.safeParse(claimed.execution_plan)
    if (!plan.success) {
      await db.from('paid_recommendations').update({ execution_status: 'needs_attention', execution_result: { error: 'Trusted execution plan is missing or invalid.' } }).eq('id', id)
      await logExecEvent(db, id, user.id, 'needs_attention', { reason: 'Invalid execution plan.' })
      return { ok: false, error: 'This recommendation requires manual review.' }
    }

    let adapter
    if (plan.data.platform === 'meta') {
      const { metaMutationAdapter } = await import('@/lib/marketing/paid-recs/platform-adapters')
      adapter = metaMutationAdapter(String(claimed.currency ?? 'DKK'))
    } else {
      const { getGoogleOAuth2Client } = await import('@/lib/google/auth')
      const client = await getGoogleOAuth2Client(user.id)
      if (!client) {
        await db.from('paid_recommendations').update({ execution_status: 'needs_attention', execution_result: { error: 'Google Ads authorization is unavailable.' } }).eq('id', id)
        await logExecEvent(db, id, user.id, 'needs_attention', { reason: 'Google OAuth unavailable.' })
        return { ok: false, error: 'Google Ads authorization is unavailable.' }
      }
      const { googleMutationAdapter } = await import('@/lib/marketing/paid-recs/platform-adapters')
      adapter = googleMutationAdapter(client, String(claimed.currency ?? 'DKK'))
    }

    await logExecEvent(db, id, user.id, 'prepared')
    const result = await executeTrustedPlan(plan.data, adapter)

    if (!result.ok) {
      await db.from('paid_recommendations').update({
        execution_status: result.status,
        execution_result: { error: result.reason, before: result.before, after: result.after, recovery: result.uncertain ? { mutation_may_have_succeeded: true, verify_before_retry: true } : undefined },
      }).eq('id', id)
      await logExecEvent(db, id, user.id, result.status, { reason: result.reason, uncertain: !!result.uncertain })
      return { ok: false, error: result.reason }
    }

    await logExecEvent(db, id, user.id, 'verified', { before: result.before, after: result.after })

    // Status semantics: status toggles complete immediately; budget changes enter monitoring.
    const isStatusToggle = plan.data.action_type.includes('pause_campaign') || plan.data.action_type.includes('resume_campaign')
    const directResult: Record<string, unknown> = { before: result.before, after: result.after, platform_request_id: result.requestId }

    if (isStatusToggle) {
      directResult.action_label = plan.data.action_type.includes('pause') ? 'Paused' : 'Resumed'
      await db.from('paid_recommendations').update({ execution_status: 'completed', execution_completed_at: new Date().toISOString(), execution_result: directResult }).eq('id', id)
      await logExecEvent(db, id, user.id, 'completed')
    } else {
      // Budget change: enter 5-day monitoring window
      const monitorEnd = new Date(Date.now() + 5 * 86400000).toISOString()
      directResult.monitoring = { monitor_start: now, monitor_end: monitorEnd, campaign_id: claimed.campaign_id, platform: claimed.platform, baseline: { spend_7d: claimed.spend_7d, result_count_7d: claimed.result_count_7d, cpr_7d: claimed.cpr_7d } }
      await db.from('paid_recommendations').update({ execution_status: 'in_motion', execution_result: directResult }).eq('id', id)
      await logExecEvent(db, id, user.id, 'completed', { monitoring: true })
    }

    await logAuditEvent(db, user.id, id, {
      execution_type: executionType, action_type: plan.data.action_type,
      platform: plan.data.platform, campaign_id: claimed.campaign_id,
      before: result.before, after: result.after,
    })
    return { ok: true }
  }

  // ── Tracking diagnostic ───────────────────────────────────────────────
  const planObj = claimed.execution_plan as Record<string, unknown> | null
  const isDiagnostic = planObj?.action_type === 'run_tracking_diagnostic'

  type DiagOutput = Awaited<ReturnType<typeof import('@/lib/marketing/paid-recs/tracking-diagnostic').runTrackingDiagnostic>>
  let diagnosticResult: DiagOutput | null = null
  if (isDiagnostic) {
    try {
      const { runTrackingDiagnostic } = await import('@/lib/marketing/paid-recs/tracking-diagnostic')
      diagnosticResult = await runTrackingDiagnostic({
        platform: claimed.platform as 'meta' | 'google',
        campaignId: claimed.campaign_id as string,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[paid-recs] Tracking diagnostic failed:', msg)
      diagnosticResult = { diagnosed: false, fixed: false, reason: `Diagnostic error: ${msg}` }
    }
    executionResult.tracking_diagnostic = diagnosticResult
  }

  // Diagnostic task-creation decision
  const diagnosticRequiresTask = diagnosticResult?.diagnosed === true
    && ['traffic_with_ga4_activity', 'traffic_no_platform_conversion', 'conversion_exists_outside_platform'].includes(diagnosticResult.likely_break)

  const shouldCreateTask = isDiagnostic
    ? diagnosticRequiresTask
    : (executionType === 'create_task' || executionType === 'create_task_and_monitor')

  // ── Create Task if needed ─────────────────────────────────────────────
  if (shouldCreateTask) {
    try {
      const platformLabel = claimed.platform === 'meta' ? 'Meta' : 'Google Ads'
      const signalVerbs: Record<string, string> = {
        spend_no_results: 'Verify tracking', cpr_worsening: 'Investigate performance',
        cpr_improving: 'Review and optimise', strong_performance: 'Review scaling opportunity',
      }
      const verb = signalVerbs[claimed.signal_type as string] ?? 'Review'
      const shortCampaign = (claimed.campaign_name as string).length > 50
        ? (claimed.campaign_name as string).slice(0, 47) + '...' : claimed.campaign_name as string
      const taskTitle = `${verb} — ${shortCampaign}`
      const descParts = [
        `**${platformLabel} · ${claimed.campaign_name}**`, '',
        `**What changed:** ${claimed.what_changed}`, '',
        `**Evidence:** ${claimed.evidence}`, '',
        `**Interpretation:** ${claimed.interpretation}`, '',
        `**Recommended action:** ${claimed.recommended_action}`,
      ]
      if (diagnosticResult?.diagnosed) {
        descParts.push('', '---', '', '**Automated tracking diagnostic (read-only — not a fix)**', '',
          `**Likely break:** ${diagnosticResult.likely_break.replace(/_/g, ' ')}`, '',
          `**Explanation:** ${diagnosticResult.explanation}`, '',
          '**Evidence gathered:**',
          `- Platform clicks: ${diagnosticResult.evidence.platformClicks ?? 'N/A'}`,
          `- Platform spend: ${diagnosticResult.evidence.platformSpend ?? 'N/A'}`,
          `- Platform conversions: ${diagnosticResult.evidence.platformConversions ?? 'N/A'}`,
          `- GA4 paid sessions: ${diagnosticResult.evidence.ga4PaidSessions ?? 'N/A'}`,
          `- GA4 total sessions: ${diagnosticResult.evidence.ga4TotalSessions ?? 'N/A'}`, '',
          '**Recommended next steps:**', ...diagnosticResult.next_steps.map(s => `- ${s}`), '',
          '_This is an automated diagnosis based on synced data. Manual investigation and fix is required._',
        )
      } else if (diagnosticResult && !diagnosticResult.diagnosed) {
        descParts.push('', '---', '', `**Tracking diagnostic unavailable:** ${diagnosticResult.reason}`)
      }
      descParts.push('', `_Created automatically from a paid recommendation._`)

      const urgencyDays: Record<string, number> = { high: 0, medium: 1, low: 3 }
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + (urgencyDays[claimed.urgency as string] ?? 1))
      const priorityMap: Record<string, 1 | 2 | 3> = { high: 1, medium: 2, low: 3 }

      const { normalizeTaskCreateInput, insertTaskWithAudit } = await import('@/lib/domain/task-creation')
      const normalized = normalizeTaskCreateInput({ title: taskTitle, description: descParts.join('\n'), owner_user_id: user.id, priority: priorityMap[claimed.urgency as string] ?? 2, due_at: dueDate.toISOString() }, user.id)
      if (!normalized.ok) throw new Error(normalized.error)
      const taskResult = await insertTaskWithAudit(db, user.id, normalized.data)
      if (taskResult.error || !taskResult.id) throw new Error('Task creation failed')
      linkedTaskId = taskResult.id
      executionResult.task_title = taskTitle
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[paid-recs] Task creation failed:', msg)
      await db.from('paid_recommendations').update({ execution_status: 'failed', execution_result: { error: `Task creation failed: ${msg}` } }).eq('id', id)
      await logExecEvent(db, id, user.id, 'failed', { reason: msg })
      return { ok: false, error: 'Recommendation approved but task creation failed.' }
    }
  }

  // ── Start monitoring if needed ────────────────────────────────────────
  if (executionType === 'monitor' || executionType === 'create_task_and_monitor') {
    const monitorEnd = new Date()
    monitorEnd.setDate(monitorEnd.getDate() + 5)
    executionResult.monitoring = {
      monitor_start: now, monitor_end: monitorEnd.toISOString(),
      campaign_id: claimed.campaign_id, platform: claimed.platform,
      baseline: { spend_7d: claimed.spend_7d, result_count_7d: claimed.result_count_7d, cpr_7d: claimed.cpr_7d },
    }
  }

  // ── Final status ──────────────────────────────────────────────────────
  if (executionType === 'monitor' || executionType === 'create_task_and_monitor') {
    await db.from('paid_recommendations').update({ execution_status: 'in_motion', execution_result: executionResult, linked_task_id: linkedTaskId }).eq('id', id)
  } else if (isDiagnostic && !diagnosticRequiresTask) {
    const diagStatus = diagnosticResult?.diagnosed ? 'completed' : 'needs_attention'
    await db.from('paid_recommendations').update({ execution_status: diagStatus, execution_completed_at: new Date().toISOString(), execution_result: executionResult, linked_task_id: linkedTaskId }).eq('id', id)
  } else {
    await db.from('paid_recommendations').update({ execution_status: 'completed', execution_completed_at: new Date().toISOString(), execution_result: executionResult, linked_task_id: linkedTaskId }).eq('id', id)
  }

  await logExecEvent(db, id, user.id, 'completed')
  await logAuditEvent(db, user.id, id, {
    execution_type: executionType, linked_task_id: linkedTaskId,
    monitoring: executionResult.monitoring ?? null,
    tracking_diagnostic: executionResult.tracking_diagnostic ?? null,
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
    .select('id,platform,campaign_name,signal_type,urgency,recommended_action,created_at,execution_plan,execution_type,remediation_plan')
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

    // Derive action-aware button label
    const plan = row.execution_plan as Record<string, unknown> | null
    let btnLabel = 'Review'
    if (plan?.action_type === 'manual_action_required') btnLabel = 'Manual action required'
    else if (row.execution_type === 'platform_action') btnLabel = 'Approve & fix'
    else if (plan?.action_type === 'run_tracking_diagnostic') btnLabel = 'Run diagnostic'
    else if (plan?.action_type === 'monitor_only') btnLabel = 'Start monitoring'
    else if (plan?.action_type === 'create_task') btnLabel = 'Create task'

    return {
      id:                  row.id as string,
      kind:                'paid_recommendation' as const,
      title:               `${platformLabel} · ${signalLabel}`,
      description:         (row.recommended_action as string | null)?.slice(0, 120) ?? null,
      created_at:          row.created_at as string,
      requires_permission: 'paid_approve' as MarketingPermission,
      action_label:        btnLabel,
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
