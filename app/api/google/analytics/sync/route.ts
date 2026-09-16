import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { runGA4Sync } from '@/lib/ga4/sync'

/**
 * POST /api/google/analytics/sync
 *
 * Cron endpoint for daily GA4 sync.
 * Secured by CRON_SECRET — must be present in Authorization header.
 *
 * On first invocation: fetches 90-day backfill for ga4_daily,
 * ga4_traffic_sources, ga4_landing_pages.  On subsequent invocations:
 * refreshes the last 14-day rolling window to capture finalised data.
 *
 * Credential owner resolved at runtime from google_oauth_tokens (first user
 * with analytics.readonly scope).  Sync state is institutional (user_id IS NULL).
 *
 * GET /api/google/analytics/sync
 *
 * Authenticated trigger for local testing (SUPER_ADMIN session required).
 * Runs the same sync function — no CRON_SECRET needed.
 */

export const dynamic = 'force-dynamic'

// ── POST: cron-secured ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/ga4/sync] CRON_SECRET environment variable is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  return runAndRespond()
}

// ── GET: session-authenticated local trigger (SUPER_ADMIN only) ───────────────

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  if (user.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden — SUPER_ADMIN required.' }, { status: 403 })
  }

  return runAndRespond()
}

// ── Shared runner ─────────────────────────────────────────────────────────────

async function runAndRespond(): Promise<NextResponse> {
  try {
    const result = await runGA4Sync()

    const status = !result.ok && result.errors.some((e) =>
      e.includes('scope') || e.includes('OAuth')
    ) ? 400 : 200

    return NextResponse.json(result, { status })
  } catch (err) {
    console.error('[api/ga4/sync] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Sync failed unexpectedly.' }, { status: 500 })
  }
}
