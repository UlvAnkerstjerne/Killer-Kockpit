import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { buildOAuth2Client, SEARCH_CONSOLE_SCOPE } from '@/lib/google/auth'
import { getAppOrigin } from '@/lib/app-url'

const STATE_COOKIE         = 'google_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

/**
 * GET /api/google/connect/search-console
 *
 * Initiates an incremental Google OAuth flow to add Google Search Console
 * access alongside any existing grants on this OAuth client.
 *
 * Scope requested:
 *   webmasters.readonly — read Search Console performance data (clicks,
 *   impressions, CTR, position) for verified properties.
 *
 * Uses include_granted_scopes=true so Google merges this scope with any
 * previously granted scopes on the same client. prompt=consent ensures a
 * new refresh_token is issued for the combined scope set.
 *
 * The shared /api/google/connect/callback route handles the token exchange.
 *
 * Pre-requisites before visiting this URL:
 *   1. Google Cloud Console: enable Google Search Console API.
 *   2. OAuth consent screen: declare the webmasters.readonly scope.
 *   3. Google Search Console: confirm the credential owner's Google account
 *      is a verified Owner or full User of each property to sync.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${getAppOrigin()}/login`)
  }

  const state = crypto.randomBytes(16).toString('hex')
  const cookieStore = await cookies()
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   STATE_COOKIE_MAX_AGE,
    path:     '/',
  })

  const client = buildOAuth2Client()
  const authUrl = client.generateAuthUrl({
    access_type:            'offline',
    prompt:                 'consent',
    scope:                  [SEARCH_CONSOLE_SCOPE],
    include_granted_scopes: true,
    state,
  })

  return NextResponse.redirect(authUrl)
}
