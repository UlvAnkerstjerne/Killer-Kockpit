/**
 * lib/reports/dispatch-audit.ts
 *
 * Dispatches email + Kockpit notifications after a successful audit submission.
 *
 * Called fire-and-forget from submitAudit() — failures are logged but never
 * propagated to the client. All deliveries are idempotent via report_deliveries
 * so retries produce no duplicates.
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { sendAuditResultEmail } from './send-audit-email'
import { resolveUsersByDisplayName, createSystemNotificationIdempotent } from './notify-users'
import { AUDIT_DELIVERY } from './delivery-config'

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Fetches the submitted audit and dispatches email + notifications.
 * All errors are caught and logged — this function never throws.
 */
export async function dispatchAuditResult(submissionId: string): Promise<void> {
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
    .single()

  if (error || !submission) {
    console.error('[audit/dispatch] Failed to fetch submission:', error?.message)
    return
  }

  const locationName = (submission.locations as unknown as { name: string } | null)?.name ?? '—'
  const auditorName  = (submission.app_users as unknown as { display_name: string } | null)?.display_name ?? '—'
  const overallPct   = Math.round((submission.score_pct as number | null) ?? 0)
  const corePct      = Math.round((submission.core_score_pct as number | null) ?? 0)
  const redFlagCount = (submission.red_flag_count as number | null) ?? 0
  const auditStatus  = (submission.audit_status as string | null) ?? ''
  const dateStr      = submission.submitted_at
    ? new Date(submission.submitted_at as string).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '—'

  const metadata = {
    location:       locationName,
    overall_pct:    overallPct,
    core_pct:       corePct,
    red_flag_count: redFlagCount,
    audit_status:   auditStatus,
  }

  // ── Email recipients ───────────────────────────────────────────────────
  for (const emailRecipient of AUDIT_DELIVERY.emailRecipients) {
    // Idempotency: skip if already terminally delivered
    const { data: existing } = await db
      .from('report_deliveries')
      .select('id')
      .eq('report_type', AUDIT_DELIVERY.reportType)
      .eq('submission_key', submissionId)
      .eq('recipient', emailRecipient)
      .in('status', ['sent', 'skipped'])
      .maybeSingle()

    if (existing) {
      console.log(`[audit/dispatch] Email to ${emailRecipient} already sent — skipping`)
      continue
    }

    const result = await sendAuditResultEmail({
      submissionId,
      locationName,
      auditorName,
      date: dateStr,
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

    if (!result.ok) {
      console.error(`[audit/dispatch] Email to ${emailRecipient} failed:`, result.error)
    } else {
      console.log(`[audit/dispatch] Email sent to ${emailRecipient} (${result.id})`)
    }
  }

  // ── Kockpit notifications ──────────────────────────────────────────────
  let userMap: Map<string, string>
  try {
    userMap = await resolveUsersByDisplayName(AUDIT_DELIVERY.notifyUserDisplayNames)
  } catch (err) {
    console.error('[audit/dispatch] User lookup failed:', err)
    return
  }

  for (const [name, userId] of userMap) {
    const outcome = await createSystemNotificationIdempotent({
      reportType:    AUDIT_DELIVERY.reportType,
      submissionKey: submissionId,
      userId,
      type:          'audit.result',
      entityType:    'audit_submission',
      entityId:      submissionId,
      metadata,
    }).catch(err => {
      console.error(`[audit/dispatch] Notification for ${name} threw:`, err)
      return 'failed' as const
    })

    console.log(`[audit/dispatch] Notification for ${name} (${userId}): ${outcome}`)
  }
}
