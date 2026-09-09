/**
 * GET /api/kkc/ssp-cph
 *
 * Refresh endpoint for the KKC SSP/CPH dashboard.
 *
 * ?force=true  — invalidates the Data Cache tag so the next server render
 *                fetches fresh data from Google Sheets.
 *
 * The endpoint does NOT return sheet data — data is loaded by the server
 * component on re-render (via router.refresh() from the client).
 *
 * Credential model: system/company credential, not per-user.
 * Any Kockpit user with management access may trigger a refresh.
 * They do NOT need personal Google Sheets access.
 *
 * Requires: authenticated KK user with management role (SUPER_ADMIN or UM).
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { invalidateKKCCache } from '@/lib/kkc/ssp-cph'

export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!canAccessQualityCheck(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const force = request.nextUrl.searchParams.get('force') === 'true'
  if (force) {
    invalidateKKCCache()
  }

  return NextResponse.json({ ok: true })
}
