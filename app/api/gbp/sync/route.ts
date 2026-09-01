import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hasGbpScope } from '@/lib/google/auth'
import { runGbpSync } from '@/lib/gbp/sync'

/**
 * POST /api/gbp/sync
 *
 * Cron endpoint for daily GBP sync.
 * Secured by CRON_SECRET — must be present in Authorization header.
 *
 * Finds the sync user (first active SUPER_ADMIN with a GBP-scoped token),
 * then runs the full sync across all active GBP locations.
 *
 * Called once daily by an external cron (cron-job.org or Railway cron).
 * Also callable manually from the SUPER_ADMIN server action triggerGbpSync().
 *
 * Returns:
 *   200 — sync complete (some locations may have failed; check body for details)
 *   400 — no sync user found (GBP OAuth not yet connected)
 *   401 — missing or incorrect CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — all locations failed or unexpected error
 */
export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/gbp/sync] CRON_SECRET environment variable is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Find sync user ────────────────────────────────────────────────────────
  // The sync user is any active SUPER_ADMIN whose stored Google token includes
  // the business.manage scope. We use the service client to query tokens.
  const db = createServiceClient()
  const { data: tokenRows } = await db
    .from('google_oauth_tokens')
    .select('user_id, scopes')

  const syncUserId = tokenRows?.find(
    (row) => hasGbpScope((row.scopes as string[]) ?? [])
  )?.user_id as string | undefined

  if (!syncUserId) {
    console.error('[api/gbp/sync] No user with business.manage scope found. Connect GBP OAuth first.')
    return NextResponse.json(
      { error: 'No GBP-connected user found. Visit /api/google/connect/gbp to connect.' },
      { status: 400 },
    )
  }

  // ── Run sync ──────────────────────────────────────────────────────────────
  try {
    const result = await runGbpSync(syncUserId)

    const status = result.totalFail > 0 && result.totalOk === 0 ? 500 : 200

    return NextResponse.json(
      {
        totalOk:   result.totalOk,
        totalFail: result.totalFail,
        locations: result.locations.map((l) => ({
          storeName:       l.storeName,
          ok:              l.ok,
          reviewsUpserted: l.reviewsUpserted,
          draftsGenerated: l.draftsGenerated,
          metricsUpserted: l.metricsUpserted,
          ...(l.error ? { error: l.error } : {}),
        })),
      },
      { status },
    )
  } catch (err) {
    console.error('[api/gbp/sync] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Sync failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
