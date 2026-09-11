/**
 * lib/kkc/delivery.ts
 *
 * Automated KQC SSP/CPH report delivery service.
 *
 * Channels are fully decoupled: email failure does not block Kockpit
 * notifications and vice-versa. Each channel has its own idempotency record
 * in report_deliveries.
 *
 * Idempotency:
 *   - 'sent' and 'skipped' rows are terminal: a unique partial index on
 *     (report_type, submission_key, recipient) WHERE status IN ('sent', 'skipped')
 *     prevents duplicate terminal records.
 *   - 'failed' rows are not unique-constrained — each retry creates a new row.
 *   - Delivered sets are pre-fetched per recipient so submissions already
 *     handled are skipped without touching Resend or the RPC.
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { fetchSSPCphDataDirect } from '@/lib/kkc/ssp-cph'
import { buildSubmissionDetail } from '@/lib/kkc/detail'
import { sendKKCReportEmail } from '@/lib/reports/send-email'
import { KKC_SSP_CPH_DELIVERY } from '@/lib/reports/delivery-config'
import { resolveUsersByEmail, createSystemNotificationIdempotent } from '@/lib/reports/notify-users'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeliveryOutcome {
  submissionKey: string
  /** Email address, or 'notification:<userId>' for notification channels */
  recipient:     string
  action:        'sent' | 'failed' | 'skipped'
  resendId?:     string
  error?:        string
}

export interface DeliveryRunResult {
  totalSubmissions: number
  outcomes:         DeliveryOutcome[]
  sent:             number
  failed:           number
  skipped:          number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the set of submission keys already terminally delivered to a recipient. */
async function getDeliveredKeys(
  reportType: string,
  recipient:  string,
): Promise<Set<string>> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('report_deliveries')
    .select('submission_key')
    .eq('report_type', reportType)
    .eq('recipient', recipient)
    .in('status', ['sent', 'skipped'])

  if (error) throw new Error(`DB read failed: ${error.message}`)
  return new Set((data ?? []).map((r) => r.submission_key as string))
}

/** Records a delivery outcome in report_deliveries. */
async function recordOutcome(
  reportType:    string,
  submissionKey: string,
  recipient:     string,
  outcome:       { status: 'sent'; resendId: string } | { status: 'failed'; error: string },
): Promise<void> {
  const db = createServiceClient()
  const row: Record<string, string | null> = {
    report_type:    reportType,
    submission_key: submissionKey,
    recipient,
    status:         outcome.status,
    resend_id:      outcome.status === 'sent' ? outcome.resendId : null,
    sent_at:        outcome.status === 'sent' ? new Date().toISOString() : null,
    error:          outcome.status === 'failed' ? outcome.error : null,
  }

  const { error } = await db.from('report_deliveries').insert(row)
  if (error) {
    // Unique violation on 'sent' = another concurrent run already delivered — safe to ignore.
    if (error.code !== '23505') {
      console.error('[kkc/delivery] Failed to record outcome:', error.message)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Runs one delivery cycle for the KKC SSP/CPH report.
 *
 * For each submission:
 *   Email channels   — each recipient independently; skips if already sent.
 *   Notification channels — each user independently; NOT conditioned on email
 *                          success. Runs even when email fails or is skipped.
 *
 * Never throws — all errors are captured in the returned outcomes.
 */
export async function runKKCSspCphDelivery(): Promise<DeliveryRunResult> {
  const { reportType, locationLabel, recipients, notifyUserEmails } = KKC_SSP_CPH_DELIVERY
  const outcomes: DeliveryOutcome[] = []

  // ── Fetch submissions ──────────────────────────────────────────────────────
  let data: Awaited<ReturnType<typeof fetchSSPCphDataDirect>>
  try {
    data = await fetchSSPCphDataDirect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[kkc/delivery] Failed to fetch SSP/CPH data:', msg)
    return { totalSubmissions: 0, outcomes: [], sent: 0, failed: 0, skipped: 0 }
  }

  const totalSubmissions = data.scores.length
  if (totalSubmissions === 0) {
    return { totalSubmissions: 0, outcomes: [], sent: 0, failed: 0, skipped: 0 }
  }

  // ── Pre-fetch delivered keys for all channels (avoids per-submission queries) ─

  // Email channels
  const emailDeliveredKeys = new Map<string, Set<string>>()
  for (const emailRecipient of recipients) {
    try {
      emailDeliveredKeys.set(emailRecipient, await getDeliveredKeys(reportType, emailRecipient))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[kkc/delivery] Delivered-keys lookup failed for ${emailRecipient}:`, msg)
      emailDeliveredKeys.set(emailRecipient, new Set()) // proceed, may re-send — idempotency record will dedupe
    }
  }

  // Notification channels — resolve users by email, then fetch delivered keys per user
  let notifyUserMap = new Map<string, string>() // email → userId
  try {
    notifyUserMap = await resolveUsersByEmail(notifyUserEmails)
  } catch (err) {
    console.error('[kkc/delivery] Failed to resolve notification users:', err)
    // Continue — email delivery still runs independently
  }

  const notifDeliveredKeys = new Map<string, Set<string>>() // userId → Set<submissionKey>
  for (const [, userId] of notifyUserMap) {
    try {
      notifDeliveredKeys.set(userId, await getDeliveredKeys(reportType, `notification:${userId}`))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[kkc/delivery] Delivered-keys lookup failed for notification:${userId}:`, msg)
      notifDeliveredKeys.set(userId, new Set())
    }
  }

  // ── Process each submission ────────────────────────────────────────────────
  for (const score of data.scores) {
    const submissionKey = score.timestamp

    // Build submission detail (needed for email + notification metadata)
    const detail = buildSubmissionDetail(data, submissionKey)
    if (!detail) {
      console.warn(`[kkc/delivery] No form row for submission ${submissionKey}`)
      for (const emailRecipient of recipients) {
        outcomes.push({ submissionKey, recipient: emailRecipient, action: 'skipped' })
      }
      continue
    }

    const notifMetadata = {
      overall_score:     detail.overallScore,
      critical_score:    detail.criticalScore,
      critical_failures: detail.criticalFailures,
      submission_key:    submissionKey,
    }

    // ── Email channels (each independent) ─────────────────────────────────
    for (const emailRecipient of recipients) {
      if (emailDeliveredKeys.get(emailRecipient)?.has(submissionKey)) {
        outcomes.push({ submissionKey, recipient: emailRecipient, action: 'skipped' })
        continue
      }

      const emailResult = await sendKKCReportEmail({ detail, recipientEmail: emailRecipient, locationLabel })

      if (emailResult.ok) {
        await recordOutcome(reportType, submissionKey, emailRecipient, {
          status:   'sent',
          resendId: emailResult.id,
        })
        outcomes.push({ submissionKey, recipient: emailRecipient, action: 'sent', resendId: emailResult.id })
        console.log(`[kkc/delivery] Email sent ${submissionKey} → ${emailRecipient} (${emailResult.id})`)
      } else {
        await recordOutcome(reportType, submissionKey, emailRecipient, {
          status: 'failed',
          error:  emailResult.error,
        })
        outcomes.push({ submissionKey, recipient: emailRecipient, action: 'failed', error: emailResult.error })
        console.error(`[kkc/delivery] Email failed ${submissionKey} → ${emailRecipient}: ${emailResult.error}`)
      }
    }

    // ── Notification channels (each independent, NOT conditioned on email) ─
    for (const [userEmail, userId] of notifyUserMap) {
      const recipientKey = `notification:${userId}`

      if (notifDeliveredKeys.get(userId)?.has(submissionKey)) {
        outcomes.push({ submissionKey, recipient: recipientKey, action: 'skipped' })
        continue
      }

      // entity_id for kkc_submission is a generated UUID;
      // routing in NotificationBell uses entity_type, not entity_id.
      const entityId = crypto.randomUUID()

      const result = await createSystemNotificationIdempotent({
        reportType,
        submissionKey,
        userId,
        type:       'kkc.result',
        entityType: 'kkc_submission',
        entityId,
        metadata:   notifMetadata,
      }).catch(err => {
        console.error(`[kkc/delivery] Notification for ${userEmail} threw:`, err)
        return 'failed' as const
      })

      console.log(`[kkc/delivery] Notification → ${userEmail} (${userId}): ${result} (${submissionKey})`)
      outcomes.push({ submissionKey, recipient: recipientKey, action: result })
    }
  }

  return {
    totalSubmissions,
    outcomes,
    sent:    outcomes.filter((o) => o.action === 'sent').length,
    failed:  outcomes.filter((o) => o.action === 'failed').length,
    skipped: outcomes.filter((o) => o.action === 'skipped').length,
  }
}
