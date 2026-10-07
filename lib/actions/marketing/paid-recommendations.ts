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
    .select('id, execution_type, execution_plan, execution_plan_version, signal_type, platform, campaign_id, campaign_name, what_changed, evidence, interpretation, recommended_action, urgency, spend_7d, result_count_7d, cpr_7d, currency')
    .maybeSingle()

  if (claimError) {
    console.error('[paid-recs] claim failed:', claimError)
    return { ok: false, error: 'Failed to approve recommendation.' }
  }
  if (!claimed) {
    return { ok: true }
  }

  const executionType = claimed.execution_type as string | null
  const planVersion = claimed.execution_plan_version as string | null
  const executionResult: Record<string, unknown> = {}

  await logExecEvent(db, id, user.id, 'claimed')

  // ══════════════════════════════════════════════════════════════════════
  // V2 REMEDIATION PLAN EXECUTION
  // ══════════════════════════════════════════════════════════════════════
  if (planVersion === 'v2' && executionType === 'platform_action') {
    const v2Plan = claimed.execution_plan as { version: string; actions: Array<Record<string, unknown>>; monitoring_days: number } | null
    if (!v2Plan || v2Plan.version !== 'v2' || !Array.isArray(v2Plan.actions)) {
      await db.from('paid_recommendations').update({ execution_status: 'needs_attention', execution_result: { error: 'V2 remediation plan is missing or malformed.' } }).eq('id', id)
      return { ok: false, error: 'This recommendation requires manual review.' }
    }

    // Reject if any action is manual_action_required — this should never reach approval
    if (v2Plan.actions.some((a: Record<string, unknown>) => a.action_type === 'manual_action_required')) {
      await db.from('paid_recommendations').update({ execution_status: 'needs_attention', execution_result: { error: 'Plan contains manual actions that cannot be automated.' } }).eq('id', id)
      return { ok: false, error: 'This recommendation requires manual action.' }
    }

    // Limit to 3 mutation actions
    const mutationActions = v2Plan.actions.filter((a: Record<string, unknown>) =>
      !['monitor_only', 'run_tracking_diagnostic', 'create_task'].includes(a.action_type as string)
    )
    if (mutationActions.length > 3) {
      await db.from('paid_recommendations').update({ execution_status: 'needs_attention', execution_result: { error: 'Plan exceeds maximum 3 mutation actions.' } }).eq('id', id)
      return { ok: false, error: 'Plan exceeds maximum mutation actions.' }
    }

    const { executeTrustedPlan } = await import('@/lib/marketing/paid-recs/executor')
    const { PaidRecExecutionPlanSchema } = await import('@/lib/marketing/paid-recs/types')
    const { metaMutationAdapter } = await import('@/lib/marketing/paid-recs/platform-adapters')
    const adapter = metaMutationAdapter(String(claimed.currency ?? 'DKK'))

    await logExecEvent(db, id, user.id, 'prepared', { action_count: mutationActions.length })

    // Execute each mutation action sequentially
    const actionResults: Array<{ action: Record<string, unknown>; before?: unknown; after?: unknown; requestId?: string }> = []
    for (const action of mutationActions) {
      const parsed = PaidRecExecutionPlanSchema.safeParse(action)
      if (!parsed.success) {
        await db.from('paid_recommendations').update({
          execution_status: 'needs_attention',
          execution_result: { error: 'One of the v2 plan actions failed validation.', completed_actions: actionResults },
        }).eq('id', id)
        await logExecEvent(db, id, user.id, 'needs_attention', { reason: 'Action validation failed', action })
        return { ok: false, error: 'Remediation plan contains an invalid action.' }
      }

      const result = await executeTrustedPlan(parsed.data, adapter)
      if (!result.ok) {
        await db.from('paid_recommendations').update({
          execution_status: result.status,
          execution_result: {
            error: result.reason,
            before: result.before, after: result.after,
            completed_actions: actionResults,
            recovery: result.uncertain ? { mutation_may_have_succeeded: true, verify_before_retry: true } : undefined,
          },
        }).eq('id', id)
        await logExecEvent(db, id, user.id, result.status, { reason: result.reason, completed_actions: actionResults.length })
        return { ok: false, error: result.reason }
      }

      actionResults.push({ action, before: result.before, after: result.after, requestId: result.requestId })
      await logExecEvent(db, id, user.id, 'action_verified', { action_type: action.action_type, before: result.before, after: result.after })
    }

    // All mutations succeeded → enter monitoring
    const monitoringDays = v2Plan.monitoring_days ?? 5
    const monitorEnd = new Date(Date.now() + monitoringDays * 86400000).toISOString()
    const v2Result: Record<string, unknown> = {
      completed_actions: actionResults,
      monitoring: {
        monitor_start: now, monitor_end: monitorEnd,
        campaign_id: claimed.campaign_id, platform: claimed.platform,
        baseline: { spend_7d: claimed.spend_7d, result_count_7d: claimed.result_count_7d, cpr_7d: claimed.cpr_7d },
      },
    }

    await db.from('paid_recommendations').update({ execution_status: 'in_motion', execution_result: v2Result }).eq('id', id)
    await logExecEvent(db, id, user.id, 'completed', { monitoring: true, actions_executed: actionResults.length })
    await logAuditEvent(db, user.id, id, {
      execution_type: 'platform_action', plan_version: 'v2',
      platform: claimed.platform, campaign_id: claimed.campaign_id,
      actions: actionResults,
    })
    return { ok: true }
  }

  // ══════════════════════════════════════════════════════════════════════
  // V1 EXECUTION (backward compatible)
  // ══════════════════════════════════════════════════════════════════════

  let linkedTaskId: string | null = null

  // ── V1 platform action (single plan) ──────────────────────────────────
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

    const isStatusToggle = plan.data.action_type.includes('pause_campaign') || plan.data.action_type.includes('resume_campaign')
    const directResult: Record<string, unknown> = { before: result.before, after: result.after, platform_request_id: result.requestId }

    if (isStatusToggle) {
      directResult.action_label = plan.data.action_type.includes('pause') ? 'Paused' : 'Resumed'
      await db.from('paid_recommendations').update({ execution_status: 'completed', execution_completed_at: new Date().toISOString(), execution_result: directResult }).eq('id', id)
      await logExecEvent(db, id, user.id, 'completed')
    } else {
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

  const diagnosticRequiresTask = diagnosticResult?.diagnosed === true
    && ['traffic_with_ga4_activity', 'traffic_no_platform_conversion', 'conversion_exists_outside_platform'].includes(diagnosticResult.likely_break)

  const shouldCreateTask = isDiagnostic
    ? diagnosticRequiresTask
    : (executionType === 'create_task' || executionType === 'create_task_and_monitor')

  if (shouldCreateTask) {
    linkedTaskId = await createLinkedTask(db, user.id, claimed, diagnosticResult)
    if (linkedTaskId) executionResult.task_title = `Follow-up for ${claimed.campaign_name}`
  }

  if (executionType === 'monitor' || executionType === 'create_task_and_monitor') {
    const monitorEnd = new Date()
    monitorEnd.setDate(monitorEnd.getDate() + 5)
    executionResult.monitoring = {
      monitor_start: now, monitor_end: monitorEnd.toISOString(),
      campaign_id: claimed.campaign_id, platform: claimed.platform,
      baseline: { spend_7d: claimed.spend_7d, result_count_7d: claimed.result_count_7d, cpr_7d: claimed.cpr_7d },
    }
  }

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

// ─── Helper: create linked task ──────────────────────────────────────────────

async function createLinkedTask(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
  claimed: Record<string, unknown>,
  diagnosticResult?: { diagnosed: boolean; fixed: false; likely_break?: string; explanation?: string; evidence?: Record<string, unknown>; next_steps?: string[] } | { diagnosed: false; fixed: false; reason: string } | null,
): Promise<string | null> {
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
      `**Recommended action:** ${claimed.recommended_action}`,
    ]
    if (diagnosticResult && 'likely_break' in diagnosticResult && diagnosticResult.diagnosed) {
      descParts.push('', '---', '', '**Tracking diagnostic**', '',
        `Likely break: ${diagnosticResult.likely_break?.replace(/_/g, ' ')}`, '',
        `${diagnosticResult.explanation}`,
      )
    }
    descParts.push('', `_Created from a paid recommendation._`)

    const urgencyDays: Record<string, number> = { high: 0, medium: 1, low: 3 }
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + (urgencyDays[claimed.urgency as string] ?? 1))
    const priorityMap: Record<string, 1 | 2 | 3> = { high: 1, medium: 2, low: 3 }

    const { normalizeTaskCreateInput, insertTaskWithAudit } = await import('@/lib/domain/task-creation')
    const normalized = normalizeTaskCreateInput({ title: taskTitle, description: descParts.join('\n'), owner_user_id: userId, priority: priorityMap[claimed.urgency as string] ?? 2, due_at: dueDate.toISOString() }, userId)
    if (!normalized.ok) return null
    const taskResult = await insertTaskWithAudit(db, userId, normalized.data)
    return taskResult.id ?? null
  } catch {
    return null
  }
}

// ─── createTaskForManualCase ────────────────────────────────────────────────
//
// Explicit task creation for manual-action-required recommendations.
// The user clicked "Create task" explicitly — this is NOT routed through approval.

export async function createTaskForManualCase(
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
  const { data: rec, error } = await db
    .from('paid_recommendations')
    .select('id, platform, campaign_id, campaign_name, signal_type, what_changed, evidence, recommended_action, urgency, execution_plan')
    .eq('id', id)
    .eq('status', 'needs_review')
    .maybeSingle()

  if (error || !rec) return { ok: false, error: 'Recommendation not found or already actioned.' }

  const taskId = await createLinkedTask(db, user.id, rec)
  if (!taskId) return { ok: false, error: 'Task creation failed.' }

  await db.from('paid_recommendations').update({
    status: 'approved',
    reviewed_at: new Date().toISOString(),
    reviewed_by_user_id: user.id,
    execution_status: 'completed',
    execution_completed_at: new Date().toISOString(),
    execution_result: { task_title: `Follow-up for ${rec.campaign_name}` },
    linked_task_id: taskId,
  }).eq('id', id).eq('status', 'needs_review')

  await logAuditEvent(db, user.id, id, {
    action: 'manual_task_created', linked_task_id: taskId,
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
