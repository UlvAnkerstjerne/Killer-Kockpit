import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { probeGoogleAds } from '@/lib/google/ads'

export const dynamic = 'force-dynamic'

/** Read-only, on-demand check; always uses the authenticated admin's own token. */
export async function GET() {
  const headers = { 'Cache-Control': 'private, no-store' }
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated.' }, { status: 401, headers })
  if (user.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ ok: false, error: 'Administrator access required.' }, { status: 403, headers })
  }
  const result = await probeGoogleAds(user.id)
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === 'MISSING_SCOPE' ? 400 : 502, headers })
}
