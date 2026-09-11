/**
 * lib/reports/dispatch-diner.ts
 *
 * Mystery Diner result delivery — email + Kockpit notifications.
 *
 * Channels are fully decoupled: email failure does not block notifications
 * and vice-versa. Each channel has its own idempotency record in report_deliveries.
 *
 * Entry points:
 *   dispatchDinerResult(submissionId) — fire-and-forget, called from POST /api/diner/submit
 *   runDinerDeliveryJob()             — cron/retry; scans all submitted diner_submissions
 *                                       and retries any channel without a terminal row.
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { sendDinerResultEmail } from './send-diner-result-email'
import { resolveUsersByEmail, createSystemNotificationIdempotent } from './notify-users'
import { DINER_RESULT_DELIVERY } from './delivery-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DinerDeliveryOutcome {
  submissionId: string
  /** Email address, or 'notification:<userId>' for notification channels */
  recipient:    string
  action:       'sent' | 'failed' | 'skipped'
  resendId?:    string
  error?:       string
}

export interface DinerDeliveryRunResult {
  totalSubmissions: number
  outcomes:         DinerDeliveryOutcome[]
  sent:             number
  failed:           number
  skipped:          number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Records a terminal or failed delivery to report_deliveries. */
async function recordDelivery(
  submissionId: string,
  recipient:    string,
  outcome:      { status: 'sent'; resendId: string } | { status: 'failed'; error: string },
): Promise<void> {
  const db = createServiceClient()
  const { error } = await db.from('report_deliveries').insert({
    report_type:    DINER_RESULT_DELIVERY.reportType,
    submission_key: submissionId,
    recipient,
    status:         outcome.status,
    resend_id:      outcome.status === 'sent' ? outcome.resendId : null,
    sent_at:        outcome.status === 'sent' ? new Date().toISOString() : null,
    error:          outcome.status === 'failed' ? outcome.error : null,
  })
  if (error && error.code !== '23505') {
    // 23505 = unique violation on terminal status — concurrent duplicate, safe to ignore
    console.error('[diner/dispatch] Failed to record delivery:', error.message)
  }
}

/** Returns true when a terminal 'sent' record exists for this channel. */
async function isTerminallyDelivered(submissionId: string, recipient: string): Promise<boolean> {
  const db = createServiceClient()
  const { data } = await db
    .from('report_deliveries')
    .select('id')
    .eq('report_type',    DINER_RESULT_DELIVERY.reportType)
    .eq('submission_key', submissionId)
    .eq('recipient',      recipient)
    .in('status',         ['sent', 'skipped'])
    .maybeSingle()
  return !!data
}

// ─── Core: process all channels for one submission ────────────────────────────

/**
 * Fetches the submission and dispatches all channels independently.
 *
 * Channels:
 *   1. Email → each configured address (DINER_RESULT_DELIVERY.emailRecipients)
 *   2. Kockpit notification → each configured user (DINER_RESULT_DELIVERY.notifyUserEmails)
 *
 * Email and notification channels do NOT depend on each other — failed email
 * does not block notifications and vice-versa.
 *
 * Only processes submissions with status = 'submitted'.
 * Returns [] if not found or not submitted.
 *
 * Never throws — all errors are captured in the returned outcomes.
 */
export async function processDinerDelivery(
  submissionId: string,
): Promise<DinerDeliveryOutcome[]> {
  const outcomes: DinerDeliveryOutcome[] = []
  const db = createServiceClient()

  // ── Fetch submission ───────────────────────────────────────────────────
  const { data: sub, error: subErr } = await db
    .from('diner_submissions')
    .select('id, invitation_id, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status, submitted_at')
    .eq('id', submissionId)
    .eq('status', 'submitted')
    .maybeSingle()

  if (subErr) {
    console.error(`[diner/dispatch] DB error fetching submission ${submissionId}:`, subErr.message)
    return outcomes
  }
  if (!sub) {
    console.warn(`[diner/dispatch] Submission ${submissionId} not found or not submitted — skipping`)
    return outcomes
  }

  // ── Fetch invitation + location ────────────────────────────────────────
  const { data: inv } = await db
    .from('diner_invitations')
    .select('diner_name, locations ( name )')
    .eq('id', sub.invitation_id as string)
    .maybeSingle()

  const locationName = (inv?.locations as unknown as { name: string } | null)?.name ?? '—'
  const dinerName    = (inv?.diner_name as string | null) ?? '—'

  // ── Fetch critical failure checkpoint labels ────────────────────────────
  const { data: critResponses } = await db
    .from('diner_responses')
    .select('checkpoint_id, diner_checkpoints ( label, is_critical, type )')
    .eq('submission_id', submissionId)
    .eq('result', 'fail')

  const criticalFailLabels: string[] = (critResponses ?? [])
    .filter((r: any) => {
      const cp = r.diner_checkpoints
      return cp?.type === 'scored' && cp?.is_critical === true
    })
    .map((r: any) => (r.diner_checkpoints as any)?.label as string)
    .filter(Boolean)

  // ── Derived values ─────────────────────────────────────────────────────
  const scorePct          = sub.score_pct          as number | null
  const criticalFailCount = (sub.critical_fail_count as number | null) ?? 0
  const goldStarCount     = (sub.gold_star_count    as number | null) ?? 0
  const waitingTimeBand   = sub.waiting_time_band   as string | null
  const finalStatus       = sub.final_status        as string | null

  const dateStr = sub.submitted_at
    ? new Date(sub.submitted_at as string).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '—'

  const metadata = {
    location:            locationName,
    score_pct:           scorePct,
    final_status:        finalStatus,
    critical_fail_count: criticalFailCount,
    gold_star_count:     goldStarCount,
    waiting_time_band:   waitingTimeBand,
  }

  // ── Email channels ─────────────────────────────────────────────────────
  for (const emailRecipient of DINER_RESULT_DELIVERY.emailRecipients) {
    const alreadyDone = await isTerminallyDelivered(submissionId, emailRecipient)
    if (alreadyDone) {
      outcomes.push({ submissionId, recipient: emailRecipient, action: 'skipped' })
      continue
    }

    const result = await sendDinerResultEmail({
      submissionId,
      locationName,
      dinerName,
      date:               dateStr,
      scorePct,
      finalStatus,
      criticalFailCount,
      goldStarCount,
      waitingTimeBand,
      criticalFailLabels,
      recipientEmail:     emailRecipient,
    })

    if (result.ok) {
      await recordDelivery(submissionId, emailRecipient, { status: 'sent', resendId: result.id })
      console.log(`[diner/dispatch] Email → ${emailRecipient} (${result.id})`)
      outcomes.push({ submissionId, recipient: emailRecipient, action: 'sent', resendId: result.id })
    } else {
      await recordDelivery(submissionId, emailRecipient, { status: 'failed', error: result.error })
      console.error(`[diner/dispatch] Email → ${emailRecipient} failed:`, result.error)
      outcomes.push({ submissionId, recipient: emailRecipient, action: 'failed', error: result.error })
    }
  }

  // ── Notification channels ──────────────────────────────────────────────
  // Independent of email outcomes — runs even when email fails.
  let userMap: Map<string, string>
  try {
    userMap = await resolveUsersByEmail(DINER_RESULT_DELIVERY.notifyUserEmails)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[diner/dispatch] User resolution failed:', msg)
    return outcomes
  }

  for (const [userEmail, userId] of userMap) {
    const result = await createSystemNotificationIdempotent({
      reportType:    DINER_RESULT_DELIVERY.reportType,
      submissionKey: submissionId,
      userId,
      type:          'diner.result',
      entityType:    'diner_submission',
      entityId:      submissionId,
      metadata,
    }).catch(err => {
      console.error(`[diner/dispatch] Notification for ${userEmail} threw:`, err)
      return 'failed' as const
    })

    console.log(`[diner/dispatch] Notification → ${userEmail} (${userId}): ${result}`)
    outcomes.push({ submissionId, recipient: `notification:${userId}`, action: result })
  }

  return outcomes
}

// ─── Fire-and-forget entry point ──────────────────────────────────────────────

/**
 * Calls processDinerDelivery for a single submission, discarding errors.
 * Called from POST /api/diner/submit — the submission response is not blocked.
 */
export async function dispatchDinerResult(submissionId: string): Promise<void> {
  await processDinerDelivery(submissionId).catch(err => {
    console.error('[diner/dispatch] processDinerDelivery threw:', err)
  })
}

// ─── Delivery job (cron / retry) ──────────────────────────────────────────────

/**
 * Scans all submitted diner_submissions and retries any channel without a
 * terminal report_deliveries row. Already-complete channels are skipped.
 *
 * Calling this repeatedly is safe — idempotency layer ensures no duplicates.
 * Never throws.
 */
export async function runDinerDeliveryJob(): Promise<DinerDeliveryRunResult> {
  const db = createServiceClient()

  const { data: rows, error } = await db
    .from('diner_submissions')
    .select('id')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('[diner/delivery-job] Failed to fetch submissions:', error.message)
    return { totalSubmissions: 0, outcomes: [], sent: 0, failed: 0, skipped: 0 }
  }

  const allOutcomes: DinerDeliveryOutcome[] = []

  for (const { id } of rows ?? []) {
    const outcomes = await processDinerDelivery(id).catch(err => {
      console.error(`[diner/delivery-job] processDinerDelivery(${id}) threw:`, err)
      return [] as DinerDeliveryOutcome[]
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
