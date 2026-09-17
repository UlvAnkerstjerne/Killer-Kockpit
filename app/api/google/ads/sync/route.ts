import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { runGoogleAdsSync } from '@/lib/google/ads-sync'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }

/** Cron uses the main app's existing CRON_SECRET. */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500, headers })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401, headers })
  }
  return runAndRespond()
}

/** Matches the existing GA4/GSC SUPER_ADMIN manual trigger. No UI change. */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401, headers })
  if (user.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'SUPER_ADMIN required.' }, { status: 403, headers })
  return runAndRespond()
}

async function runAndRespond() {
  try {
    const result = await runGoogleAdsSync()
    return NextResponse.json(result, { status: result.ok ? 200 : 502, headers })
  } catch {
    // Never log a raw OAuth/Gaxios error or its request headers.
    return NextResponse.json({ error: 'Google Ads sync failed unexpectedly.' }, { status: 500, headers })
  }
}
