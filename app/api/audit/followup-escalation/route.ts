/**
 * POST /api/audit/followup-escalation
 *
 * Cron endpoint: scans all overdue, unresolved audit follow-ups and sends
 * escalation emails + Kockpit notifications to Kasper, the Regional Manager,
 * and Ulv for each affected follow-up.
 *
 * Secured by CRON_SECRET — must be passed as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Idempotent — re-running after all channels are delivered returns 200 with
 * sent=0.  Failed channels are non-terminal and auto-retry on the next run.
 *
 * Intended to be called every 5 minutes by the Railway Cron service.
 *
 * Returns:
 *   200 — run complete; body contains { totalFollowups, sent, failed, skipped, outcomes }
 *         failed > 0 means some channels bounced — check logs for details;
 *         retries are automatic on the next cron run (failed rows are
 *         non-terminal in report_deliveries)
 *   401 — missing or invalid CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — unexpected / unhandled error only (not email or notification failures)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { runAuditFollowupEscalationJob } from '@/lib/reports/dispatch-audit-followup-escalation'

export async function POST(request: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/audit/followup-escalation] CRON_SECRET is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Run escalation job ───────────────────────────────────────────────────────
  try {
    const result = await runAuditFollowupEscalationJob()
    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    console.error('[api/audit/followup-escalation] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Escalation job failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
