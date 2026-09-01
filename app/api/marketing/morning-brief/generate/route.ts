import { NextResponse, type NextRequest } from 'next/server'
import { generateMorningBrief } from '@/lib/marketing/brief/generate-brief'

/**
 * POST /api/marketing/morning-brief/generate
 *
 * Cron endpoint for daily Morning Brief generation.
 * Secured by CRON_SECRET — must be present in Authorization header.
 *
 * Called at 07:00 UTC and 08:00 UTC by GitHub Actions.
 * The workflow checks the Copenhagen local hour and only triggers when it is 09:xx.
 * This ensures the brief is generated at approximately 09:00 Copenhagen time
 * year-round, correctly handling CET (UTC+1) and CEST (UTC+2) transitions.
 *
 * brief_date is computed as today in Europe/Copenhagen — not naive UTC.
 * This is DST-safe via Intl.DateTimeFormat.
 *
 * Returns:
 *   200 — generation complete (brief may be 'ready', 'already_ready', or 'skipped_generating')
 *   401 — missing or incorrect CRON_SECRET
 *   405 — wrong HTTP method
 *   500 — unexpected error or missing configuration
 */
export async function POST(request: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[api/morning-brief/generate] CRON_SECRET environment variable is not set.')
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  // ── Compute brief date in Europe/Copenhagen (DST-safe) ─────────────────────
  const briefDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' })
    .format(new Date())  // sv-SE locale produces 'YYYY-MM-DD'

  // ── Generate ────────────────────────────────────────────────────────────────
  try {
    const result = await generateMorningBrief(briefDate)

    const ok = result.outcome === 'generated' || result.outcome === 'already_ready'

    return NextResponse.json(
      {
        ok,
        outcome:   result.outcome,
        briefDate: result.briefDate,
        summary:   outcomeToSummary(result),
        ...('error' in result && result.error ? { error: result.error } : {}),
      },
      { status: ok || result.outcome === 'skipped_generating' ? 200 : 500 },
    )
  } catch (err) {
    console.error('[api/morning-brief/generate] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'Generation failed unexpectedly.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}

function outcomeToSummary(result: Awaited<ReturnType<typeof generateMorningBrief>>): string {
  switch (result.outcome) {
    case 'generated':           return `Morning Brief for ${result.briefDate} generated successfully.`
    case 'already_ready':       return `Morning Brief for ${result.briefDate} already ready — skipped.`
    case 'skipped_generating':  return `Morning Brief for ${result.briefDate} is currently generating — skipped. ${('reason' in result ? result.reason : '')}`
    case 'failed':              return `Morning Brief for ${result.briefDate} failed: ${('error' in result ? result.error : '')}`
    default:                    return 'Unknown outcome.'
  }
}
