import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { runGbpSync } from '@/lib/gbp/sync'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }

/** Railway references the main app's CRON_SECRET; never a copied secret. */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500, headers })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorised.' }, { status: 401, headers })
  return runAndRespond()
}
/** Existing GA4/GSC/Ads manual-trigger convention. */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401, headers })
  if (user.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'SUPER_ADMIN required.' }, { status: 403, headers })
  return runAndRespond()
}
async function runAndRespond() {
  try {
    const result = await runGbpSync()
    return NextResponse.json(result, { status: result.ok ? 200 : 502, headers })
  } catch { return NextResponse.json({ error: 'GBP sync failed unexpectedly.' }, { status: 500, headers }) }
}
