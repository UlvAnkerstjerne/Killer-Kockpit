import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { runPlandaySyncCore } from '@/lib/planday/sync-runner'

/**
 * POST /api/planday/sync
 *
 * Cron endpoint for daily Planday roster sync.
 * Secured by CRON_SECRET — must be present in Authorization header.
 *
 * Fetches all active + deactivated employees from Planday, then calls
 * planday_sync_roster via the service client (system actor).
 * Updates name and employment_status for mapped employees only;
 * unmapped employees are counted but not created.
 *
 * Called once daily by an external cron (cron-job.org or Railway cron).
 * Also callable from the SUPER_ADMIN "Sync now" button in Settings
 * (via lib/actions/planday-sync.ts, which uses the user-JWT client).
 *
 * Returns:
 *   200 — sync complete
 *   401 — missing or incorrect CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — sync threw (e.g. credentials not configured, Planday API error)
 */
export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/planday/sync] CRON_SECRET environment variable is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Run sync ──────────────────────────────────────────────────────────────
  try {
    const serviceClient = createServiceClient()
    const result        = await runPlandaySyncCore(serviceClient)

    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/planday/sync] Sync failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}
