/**
 * POST /api/audit/deliver
 *
 * Cron endpoint: finds all submitted Audits without complete delivery records
 * and retries any missing channel (email or Kockpit notification).
 *
 * Secured by CRON_SECRET — must be passed as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Idempotent: re-running when all channels are already complete returns 200
 * with sent=0, skipped=N. Failed channels are retried; already-sent channels
 * are skipped without re-sending.
 *
 * Intended to be called every ~5 minutes by Railway Cron or cron-job.org,
 * same schedule as /api/kkc/ssp-cph/deliver.
 *
 * Returns:
 *   200 — run complete (check body.sent / body.failed for details)
 *   401 — missing or invalid CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — unexpected error
 */

import { NextResponse, type NextRequest } from 'next/server'
import { runAuditDeliveryJob } from '@/lib/reports/dispatch-audit'

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/audit/deliver] CRON_SECRET is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Run delivery job ───────────────────────────────────────────────────────
  try {
    const result = await runAuditDeliveryJob()
    const status = result.failed > 0 && result.sent === 0 ? 500 : 200
    return NextResponse.json(result, { status })
  } catch (err) {
    console.error('[api/audit/deliver] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Delivery run failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
