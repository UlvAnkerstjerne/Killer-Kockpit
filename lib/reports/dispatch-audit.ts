/**
 * lib/reports/dispatch-audit.ts
 *
 * Audit result delivery — email + Kockpit notifications.
 *
 * Channels are fully decoupled: email failure does not block notifications and
 * vice-versa. Each channel has its own idempotency record in report_deliveries.
 *
 * Entry points:
 *   dispatchAuditResult(submissionId) — fire-and-forget, called from submitAudit()
 *   runAuditDeliveryJob()             — cron/retry job; scans all submitted audits
 *                                       and retries any channel without a terminal
 *                                       report_deliveries row.
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { sendAuditResultEmail } from './send-audit-email'
import { resolveUsersByEmail, createSystemNotificationIdempotent } from './notify-users'
import { AUDIT_DELIVERY } from './delivery-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditDeliveryOutcome {
  submissionId: string
  /** Email address, or 'notification:<userId>' for notification channels */
  recipient:    string
  action:       'sent' | 'failed' | 'skipped'
  resendId?:    string
  error?:       string
}

export interface AuditDeliveryRunResult {
  totalSubmissions: number
  outcomes:         AuditDeliveryOutcome[]
  sent:             number
  failed:           number
  skipped:          number
}

// ─── Submission data shape ────────────────────────────────────────────────────

interface SubmissionData {
  id:                string
  score_pct:         unknown
  core_score_pct:    unknown
  red_flag_count:    unknown
  audit_status:      unknown
  submitted_at:      unknown
  locations:         unknown
  app_users:         unknown
}

function extractSubmissionFields(submission: SubmissionData) {
  const locationName = (submission.locations as { name: string } | null)?.name ?? '—'
  const auditorName  = (submission.app_users as { display_name: string } | null)?.display_name ?? '—'
  const overallPct   = Math.round((submission.score_pct as number | null) ?? 0)
  const corePct      = Math.round((submission.core_score_pct as number | null) ?? 0)
  const redFlagCount = (submission.red_flag_count as number | null) ?? 0
  const auditStatus  = (submission.audit_status as string | null) ?? ''
  const dateStr      = submission.submitted_at
    ? new Date(submission.submitted_at as string).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '—'

  return { locationName, auditorName, overallPct, corePct, redFlagCount, auditStatus, dateStr }
}

// ─── Core: process all channels for one submission ────────────────────────────

/**
 * Fetches the submission and dispatches all channels independently:
 *   1. Email to each configured address (idempotent via report_deliveries)
 *   2. Kockpit notification for each configured user (idempotent via report_deliveries)
 *
 * Email and notification channels do NOT depend on each other — a failed email
 * does not block notifications and vice-versa.
 *
 * Only processes submissions with status = 'submitted'. Returns [] if the
 * submission is not found or not yet submitted.
 *
 * Never throws — all errors are captured in the returned outcomes.
 */
export async function processAuditDelivery(
  submissionId: string,
): Promise<AuditDeliveryOutcome[]> {
  const outcomes: AuditDeliveryOutcome[] = []
  const db = createServiceClient()

  // ── Fetch submission ───────────────────────────────────────────────────
  const { data: submission, error } = await db
    .from('audit_submissions')
    .select(`
      id, score_pct, core_score_pct, red_flag_count, audit_status, submitted_at,
      locations!location_id ( name ),
      app_users!auditor_user_id ( display_name )
    `)
    .eq('id', submissionId)
    .eq('status', 'submitted')
    .maybeSingle()

  if (error) {
    console.error(`[audit/dispatch] DB error fetching ${submissionId}:`, error.message)
    return outcomes
  }
  if (!submission) {
    console.warn(`[audit/dispatch] Submission ${submissionId} not found or not submitted — skipping`)
    return outcomes
  }

  const { locationName, auditorName, overallPct, corePct, redFlagCount, auditStatus, dateStr } =
    extractSubmissionFields(submission as SubmissionData)

  const metadata = {
    location:       locationName,
    overall_pct:    overallPct,
    core_pct:       corePct,
    red_flag_count: redFlagCount,
    audit_status:   auditStatus,
  }

  // ── Email channels ─────────────────────────────────────────────────────
  // Each recipient is an independent channel with its own report_deliveries row.
  for (const emailRecipient of AUDIT_DELIVERY.emailRecipients) {
    const { data: existing } = await db
      .from('report_deliveries')
      .select('id')
      .eq('report_type', AUDIT_DELIVERY.reportType)
      .eq('submission_key', submissionId)
      .eq('recipient', emailRecipient)
      .in('status', ['sent', 'skipped'])
      .maybeSingle()

    if (existing) {
      outcomes.push({ submissionId, recipient: emailRecipient, action: 'skipped' })
      continue
    }

    const result = await sendAuditResultEmail({
      submissionId,
      locationName,
      auditorName,
      date:          dateStr,
      overallPct,
      corePct,
      redFlagCount,
      auditStatus,
      recipientEmail: emailRecipient,
    })

    const { error: insertError } = await db.from('report_deliveries').insert({
      report_type:    AUDIT_DELIVERY.reportType,
      submission_key: submissionId,
      recipient:      emailRecipient,
      status:         result.ok ? 'sent' : 'failed',
      resend_id:      result.ok ? result.id : null,
      error:          result.ok ? null : result.error,
      sent_at:        result.ok ? new Date().toISOString() : null,
    })

    if (insertError && insertError.code !== '23505') {
      console.error('[audit/dispatch] Failed to record email delivery:', insertError.message)
    }

    if (result.ok) {
      console.log(`[audit/dispatch] Email → ${emailRecipient} (${result.id})`)
      outcomes.push({ submissionId, recipient: emailRecipient, action: 'sent', resendId: result.id })
    } else {
      console.error(`[audit/dispatch] Email → ${emailRecipient} failed:`, result.error)
      outcomes.push({ submissionId, recipient: emailRecipient, action: 'failed', error: result.error })
    }
  }

  // ── Notification channels ──────────────────────────────────────────────
  // Independent of email outcomes — runs even when email fails.
  let userMap: Map<string, string>
  try {
    userMap = await resolveUsersByEmail(AUDIT_DELIVERY.notifyUserEmails)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[audit/dispatch] User resolution failed:', msg)
    // Return what we have — email outcomes already captured
    return outcomes
  }

  for (const [userEmail, userId] of userMap) {
    const recipientKey = `notification:${userId}`

    const result = await createSystemNotificationIdempotent({
      reportType:    AUDIT_DELIVERY.reportType,
      submissionKey: submissionId,
      userId,
      type:          'audit.result',
      entityType:    'audit_submission',
      entityId:      submissionId,
      metadata,
    }).catch(err => {
      console.error(`[audit/dispatch] Notification for ${userEmail} threw:`, err)
      return 'failed' as const
    })

    console.log(`[audit/dispatch] Notification → ${userEmail} (${userId}): ${result}`)
    outcomes.push({ submissionId, recipient: recipientKey, action: result })
  }

  return outcomes
}

// ─── Fire-and-forget entry point (called from submitAudit) ────────────────────

/**
 * Calls processAuditDelivery for a single submission, discarding errors.
 * The server action returns immediately; delivery runs in the background.
 */
export async function dispatchAuditResult(submissionId: string): Promise<void> {
  await processAuditDelivery(submissionId).catch(err => {
    console.error('[audit/dispatch] processAuditDelivery threw:', err)
  })
}

// ─── Delivery job (cron / retry) ──────────────────────────────────────────────

/**
 * Scans all submitted audits and retries any channel without a terminal
 * report_deliveries row. Already-complete channels are skipped via the
 * idempotency check inside processAuditDelivery / createSystemNotificationIdempotent.
 *
 * Calling this repeatedly is safe — the idempotency layer ensures no duplicate
 * emails or notifications regardless of how many times it runs.
 *
 * Never throws — all errors are captured in the returned result.
 */
export async function runAuditDeliveryJob(): Promise<AuditDeliveryRunResult> {
  const db = createServiceClient()

  const { data: rows, error } = await db
    .from('audit_submissions')
    .select('id')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('[audit/delivery-job] Failed to fetch submissions:', error.message)
    return { totalSubmissions: 0, outcomes: [], sent: 0, failed: 0, skipped: 0 }
  }

  const allOutcomes: AuditDeliveryOutcome[] = []

  for (const { id } of rows ?? []) {
    const outcomes = await processAuditDelivery(id).catch(err => {
      console.error(`[audit/delivery-job] processAuditDelivery(${id}) threw:`, err)
      return [] as AuditDeliveryOutcome[]
    })
    allOutcomes.push(...outcomes)
  }

  return {
    totalSubmissions: (rows ?? []).length,
    outcomes:         allOutcomes,
    sent:    allOutcomes.filter(o => o.action === 'sent').length,
    failed:  allOutcomes.filter(o => o.action === 'failed').length,
    skipped: allOutcomes.filter(o => o.action === 'skipped').length,
  }
}
