/**
 * lib/kkc/delivery.ts
 *
 * Automated KQC SSP/CPH report delivery service.
 *
 * Fetches current submissions, finds any not yet delivered to the configured
 * recipients, generates a PDF for each, and sends it via Resend.
 * Results are recorded in report_deliveries for idempotency and auditability.
 *
 * Idempotency:
 *   - 'sent' and 'skipped' rows are terminal: a unique partial index on
 *     (report_type, submission_key, recipient) WHERE status IN ('sent', 'skipped')
 *     prevents duplicate terminal records.
 *   - 'failed' rows are not unique-constrained — each retry creates a new row.
 *   - The delivery check reads for any terminal row before sending, so a
 *     concurrent run seeing the same submission will skip it.
 *
 * Server-only — never import from client components.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { fetchSSPCphDataDirect } from '@/lib/kkc/ssp-cph'
import { buildSubmissionDetail } from '@/lib/kkc/detail'
import { generateKKCPdf } from '@/lib/reports/generate-pdf'
import { sendKKCReportEmail } from '@/lib/reports/send-email'
import { KKC_SSP_CPH_DELIVERY } from '@/lib/reports/delivery-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeliveryOutcome {
  submissionKey: string
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
 * - Fetches all current SSP/CPH submissions fresh from Google Sheets.
 * - For each submission × recipient: skips if already terminally delivered,
 *   otherwise generates PDF and sends via Resend.
 * - Records every outcome in report_deliveries.
 *
 * Never throws — all errors are captured in the returned outcomes.
 */
export async function runKKCSspCphDelivery(): Promise<DeliveryRunResult> {
  const { reportType, locationLabel, recipients } = KKC_SSP_CPH_DELIVERY
  const outcomes: DeliveryOutcome[] = []

  // ── Fetch submissions ──────────────────────────────────────────────────────
  let data: Awaited<ReturnType<typeof fetchSSPCphDataDirect>>
  try {
    data = await fetchSSPCphDataDirect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[kkc/delivery] Failed to fetch SSP/CPH data:', msg)
    // Return early — no submissions to process
    return { totalSubmissions: 0, outcomes: [], sent: 0, failed: 0, skipped: 0 }
  }

  const totalSubmissions = data.scores.length

  // ── Process each recipient ─────────────────────────────────────────────────
  for (const recipient of recipients) {
    let delivered: Set<string>
    try {
      delivered = await getDeliveredKeys(reportType, recipient)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[kkc/delivery] DB lookup failed for ${recipient}:`, msg)
      continue
    }

    for (const score of data.scores) {
      const submissionKey = score.timestamp

      // Already terminally delivered — skip
      if (delivered.has(submissionKey)) {
        outcomes.push({ submissionKey, recipient, action: 'skipped' })
        continue
      }

      // Build submission detail
      const detail = buildSubmissionDetail(data, submissionKey)
      if (!detail) {
        // Score row exists but no matching form row — cannot generate PDF
        console.warn(`[kkc/delivery] No form row for submission ${submissionKey}`)
        outcomes.push({ submissionKey, recipient, action: 'skipped' })
        continue
      }

      // Generate PDF + send
      const emailResult = await sendKKCReportEmail({ detail, recipientEmail: recipient, locationLabel })

      if (emailResult.ok) {
        await recordOutcome(reportType, submissionKey, recipient, {
          status:   'sent',
          resendId: emailResult.id,
        })
        outcomes.push({ submissionKey, recipient, action: 'sent', resendId: emailResult.id })
        console.log(`[kkc/delivery] Sent ${submissionKey} → ${recipient} (${emailResult.id})`)
      } else {
        await recordOutcome(reportType, submissionKey, recipient, {
          status: 'failed',
          error:  emailResult.error,
        })
        outcomes.push({ submissionKey, recipient, action: 'failed', error: emailResult.error })
        console.error(`[kkc/delivery] Failed ${submissionKey} → ${recipient}: ${emailResult.error}`)
      }
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
