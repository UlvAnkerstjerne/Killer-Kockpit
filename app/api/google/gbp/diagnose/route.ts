/**
 * GET /api/google/gbp/diagnose
 *
 * Temporary SUPER_ADMIN-only diagnostic endpoint.
 * Returns safe metadata about the GBP accounts and locations visible to the
 * stored GBP-authorised credential, without modifying any sync state.
 *
 * Never exposes: access tokens, refresh tokens, OAuth secrets, or encryption
 * material.  Cache-Control: private, no-store prevents caching or proxying.
 */

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getGoogleOAuth2Client, hasGbpScope } from '@/lib/google/auth'
import { fetchGbpAccounts, fetchGbpLocations, fetchGbpLocationsWildcard, safeGbpError } from '@/lib/google/gbp-client'
import { createServiceClient } from '@/lib/supabase/server'
import { googleId } from '@/lib/gbp/data'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }

// The Account Management API returns role + permissionLevel; our shared
// GbpAccount type omits them as the sync layer does not use them.
interface GbpAccountFull {
  name: string
  accountName: string
  type: string
  role?: string
  permissionLevel?: string
}

export async function GET() {
  // ── Auth: SUPER_ADMIN only ────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401, headers })
  if (user.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'SUPER_ADMIN required.' }, { status: 403, headers })

  const db = createServiceClient()

  // ── Resolve GBP credential owner (mirrors credentialOwner() in sync) ─────
  const { data: tokenRows, error: tokenErr } = await db
    .from('google_oauth_tokens')
    .select('user_id,scopes')
    .order('user_id')

  if (tokenErr) {
    return NextResponse.json({ error: 'Could not read GBP connection metadata.' }, { status: 500, headers })
  }

  const gbpUserIds = (tokenRows ?? [])
    .filter((row: { user_id: string; scopes: string[] }) => hasGbpScope(row.scopes ?? []))
    .map((row: { user_id: string }) => row.user_id)

  if (!gbpUserIds.length) {
    return NextResponse.json(
      { error: 'No GBP-scoped credential found. Connect Google Business Profile at /api/google/connect/gbp.' },
      { status: 400, headers },
    )
  }

  const { data: adminRows, error: adminErr } = await db
    .from('app_users')
    .select('id,email')
    .in('id', gbpUserIds)
    .eq('role', 'SUPER_ADMIN')
    .eq('active', true)
    .order('id')

  if (adminErr || !adminRows?.length) {
    return NextResponse.json(
      { error: 'No active SUPER_ADMIN owns the GBP-authorised connection.' },
      { status: 400, headers },
    )
  }

  const credentialOwner = adminRows[0] as { id: string; email: string }

  const oauthClient = await getGoogleOAuth2Client(credentialOwner.id)
  if (!oauthClient) {
    return NextResponse.json({ error: 'GBP OAuth connection is unavailable.' }, { status: 400, headers })
  }

  // ── Fetch accounts ────────────────────────────────────────────────────────
  let accounts: GbpAccountFull[]
  try {
    accounts = (await fetchGbpAccounts(oauthClient)) as GbpAccountFull[]
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to list GBP accounts: ${safeGbpError(err)}` },
      { status: 502, headers },
    )
  }

  // ── Per-account direct location fetch ─────────────────────────────────────
  const accountsWithLocations = await Promise.all(
    accounts.map(async account => {
      let accountId: string
      try { accountId = googleId(account.name, 'accounts') }
      catch {
        return {
          name: account.name,
          accountName: account.accountName,
          type: account.type,
          role: account.role ?? null,
          permissionLevel: account.permissionLevel ?? null,
          directLocations: [] as { name: string; title: string }[],
          directError: 'Invalid account resource name.',
        }
      }
      try {
        const locs = await fetchGbpLocations(oauthClient, accountId)
        return {
          name: account.name,
          accountName: account.accountName,
          type: account.type,
          role: account.role ?? null,
          permissionLevel: account.permissionLevel ?? null,
          directLocations: locs.map(l => ({ name: l.name, title: l.title })),
        }
      } catch (err) {
        return {
          name: account.name,
          accountName: account.accountName,
          type: account.type,
          role: account.role ?? null,
          permissionLevel: account.permissionLevel ?? null,
          directLocations: [] as { name: string; title: string }[],
          directError: safeGbpError(err),
        }
      }
    }),
  )

  // ── Wildcard fetch ────────────────────────────────────────────────────────
  let wildcardLocations: { name: string; title: string }[] = []
  let wildcardError: string | undefined
  try {
    wildcardLocations = (await fetchGbpLocationsWildcard(oauthClient)).map(l => ({ name: l.name, title: l.title }))
  } catch (err) {
    wildcardError = safeGbpError(err)
  }

  return NextResponse.json(
    {
      user: credentialOwner.email,
      accounts: accountsWithLocations,
      wildcardLocations,
      ...(wildcardError ? { wildcardError } : {}),
    },
    { headers },
  )
}

export async function POST() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405, headers })
}
