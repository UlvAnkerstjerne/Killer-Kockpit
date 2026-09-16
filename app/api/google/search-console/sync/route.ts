import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { runGscSync } from '@/lib/gsc/sync'

/**
 * POST /api/google/search-console/sync
 *
 * Cron endpoint for daily Search Console sync.
 * Secured by CRON_SECRET — must be present in Authorization header.
 *
 * On first invocation: fetches 90-day backfill for gsc_daily, gsc_queries,
 * gsc_pages.  On subsequent invocations: refreshes the last 14-day rolling
 * window to pick up finalised GSC data.
 *
 * Called once daily by an external cron. Credential owner resolved at runtime
 * from google_oauth_tokens (first user with webmasters.readonly scope).
 * Sync state is institutional (user_id IS NULL), data is company-wide.
 *
 * GET /api/google/search-console/sync
 *
 * Authenticated trigger for local testing (SUPER_ADMIN session required).
 * Runs the same sync function as the POST endpoint — no CRON_SECRET needed.
 * Remove or restrict this once a stable cron is in place.
 */

export const dynamic = 'force-dynamic'

// ── POST: cron-secured ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/gsc/sync] CRON_SECRET environment variable is not set.')
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
    const result = await runGscSync()

    const status = !result.ok && result.errors.some((e) =>
      e.includes('scope') || e.includes('OAuth')
    ) ? 400 : 200

    return NextResponse.json(result, { status })
  } catch (err) {
    console.error('[api/gsc/sync] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Sync failed unexpectedly.' }, { status: 500 })
  }
}
