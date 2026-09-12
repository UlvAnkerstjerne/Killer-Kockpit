/**
 * POST /api/tasks/overdue-reminders
 *
 * Cron endpoint: scans all overdue tasks and sends any missing staged reminder
 * emails to the current assignee.
 *
 * Secured by CRON_SECRET — must be passed as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Stages: 0h, 24h, 48h, 72h after deadline.  Each stage is idempotent —
 * re-running when all stages are already sent returns 200 with sent=0.
 *
 * Intended to be called hourly by Railway Cron or cron-job.org.
 *
 * Returns:
 *   200 — run complete; body contains { totalTasks, sent, failed, skipped }
 *         failed > 0 means some emails bounced — check logs for details;
 *         retries are automatic on the next cron run (failed rows are
 *         non-terminal in report_deliveries)
 *   401 — missing or invalid CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — unexpected / unhandled error only (not email delivery failures)
 */

import { NextResponse, type NextRequest } from 'next/server'
import { runTaskOverdueReminderJob } from '@/lib/reports/dispatch-task-overdue'

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/tasks/overdue-reminders] CRON_SECRET is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Run reminder job ───────────────────────────────────────────────────────
  try {
    const result = await runTaskOverdueReminderJob()
    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    console.error('[api/tasks/overdue-reminders] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reminder job failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
