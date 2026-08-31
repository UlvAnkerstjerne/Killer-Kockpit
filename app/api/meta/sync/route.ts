import { NextResponse, type NextRequest } from 'next/server'
import { runMetaSync } from '@/lib/meta/sync'

/**
 * POST /api/meta/sync
 *
 * Cron endpoint for daily Meta sync (paid + organic).
 * Secured by CRON_SECRET — must be present in Authorization header.
 *
 * Performs on each invocation:
 *   - Ad structure refresh (campaigns, ad sets, ads)
 *   - 7-day rolling paid insights window (ad + campaign level)
 *   - One 30-day historical backfill chunk (until complete)
 *   - IG account daily metrics
 *   - FB page daily metrics
 *   - IG + FB organic deep sync if due (weekly gate)
 *
 * Called once daily by an external cron (cron-job.org or Railway cron).
 * Also callable from the SUPER_ADMIN server action triggerMetaSync().
 *
 * Returns:
 *   200 — sync complete (some sections may have failed; check body)
 *   401 — missing or incorrect CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — sync threw unexpectedly or Meta credentials not configured
 */
export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/meta/sync] CRON_SECRET environment variable is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Run sync ──────────────────────────────────────────────────────────────
  try {
    const result = await runMetaSync()

    // Return 500 only if sync couldn't start (missing credentials/config).
    // Partial section failures return 200 with error details in the body.
    const status = !result.ok && result.errors.some((e) =>
      e.includes('not configured')
    ) ? 500 : 200

    return NextResponse.json(
      {
        ok:      result.ok,
        summary: result.summary,
        ...(result.errors.length > 0 ? { errors: result.errors } : {}),
      },
      { status },
    )
  } catch (err) {
    console.error('[api/meta/sync] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Sync failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
