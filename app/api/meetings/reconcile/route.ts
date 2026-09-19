/**
 * POST /api/meetings/reconcile
 *
 * Cron endpoint: checks meetings with a Google Meet space for ended conference
 * records and automatically transitions them to draft with actual start/end times.
 * Also attempts to retrieve and store transcripts when available.
 *
 * Secured by CRON_SECRET — must be passed as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Intended to be called hourly by Railway Cron.
 *
 * Returns:
 *   200 — run complete; body contains { checked, resolved, transcripts, errors, skipped }
 *   401 — missing or invalid CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — unexpected / unhandled error
 */

import { NextResponse, type NextRequest } from 'next/server'
import { runMeetingReconcileJob } from '@/lib/google/reconcile'

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/meetings/reconcile] CRON_SECRET is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  try {
    const result = await runMeetingReconcileJob()
    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    console.error('[api/meetings/reconcile] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reconcile job failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
