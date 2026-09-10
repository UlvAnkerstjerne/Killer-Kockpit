/**
 * POST /api/kkc/ssp-cph/deliver
 *
 * Cron endpoint: finds new SSP/CPH KQC submissions not yet delivered,
 * generates a PDF for each, and emails it to the configured recipients.
 *
 * Secured by CRON_SECRET — must be passed as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Idempotent: re-running when nothing is new returns 200 with sent=0.
 * Failed submissions remain retryable — re-run to retry.
 *
 * Intended to be called every ~5 minutes by Railway Cron or cron-job.org.
 *
 * Returns:
 *   200 — run complete (check body.sent / body.failed for details)
 *   401 — missing or invalid CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — unexpected error
 */

import { NextResponse, type NextRequest } from 'next/server'
import { runKKCSspCphDelivery } from '@/lib/kkc/delivery'

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/kkc/ssp-cph/deliver] CRON_SECRET is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Run delivery ───────────────────────────────────────────────────────────
  try {
    const result = await runKKCSspCphDelivery()
    const status = result.failed > 0 && result.sent === 0 ? 500 : 200
    return NextResponse.json(result, { status })
  } catch (err) {
    console.error('[api/kkc/ssp-cph/deliver] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Delivery run failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
