/**
 * POST /api/marketing/paid-recommendations/generate
 *
 * Triggers paid recommendation generation.
 * Protected by CRON_SECRET — same pattern as other cron-triggered routes.
 *
 * Called after Meta + Google Ads syncs complete (daily).
 * Returns a JSON result summary; never throws to the cron caller.
 */

import { NextResponse } from 'next/server'
import { generatePaidRecommendations } from '@/lib/marketing/paid-recs/generate'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  const secret = req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await generatePaidRecommendations()
    const status = result.ok ? 200 : 500
    return NextResponse.json(result, { status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/paid-recommendations/generate] Unhandled error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
