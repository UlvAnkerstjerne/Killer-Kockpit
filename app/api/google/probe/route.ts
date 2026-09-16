/**
 * GET /api/google/probe
 *
 * Temporary connectivity probe for Search Console and GA4.
 * Requires an authenticated Kockpit session. Uses the caller's own stored
 * Google OAuth token — visit this URL as the user who completed the OAuth
 * consent for the relevant scopes.
 *
 * Returns JSON with sample metrics from both APIs. Remove once live sync
 * is built and connectivity is confirmed.
 *
 * Token values are never logged or returned.
 */

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listSearchConsoleSites, probeSearchConsole, probeGA4 } from '@/lib/google/probe'

const SC_PROPERTY    = 'https://killerkebab.com/'
const GA4_PROPERTY_ID = '333149501'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const [searchConsoleSites, searchConsole, ga4] = await Promise.all([
    listSearchConsoleSites(user.id),
    probeSearchConsole(user.id, SC_PROPERTY),
    probeGA4(user.id, GA4_PROPERTY_ID),
  ])

  return NextResponse.json({ userId: user.id, searchConsoleSites, searchConsole, ga4 })
}
