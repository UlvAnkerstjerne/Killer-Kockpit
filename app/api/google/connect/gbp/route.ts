import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { buildOAuth2Client, GBP_SCOPE } from '@/lib/google/auth'
import { getAppOrigin } from '@/lib/app-url'

const STATE_COOKIE         = 'google_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

/**
 * GET /api/google/connect/gbp
 *
 * Initiates an incremental Google OAuth flow to add Google Business Profile
 * access alongside any existing Calendar, Gmail, Drive, and Meet grants.
 *
 * Scope requested:
 *   business.manage — read GBP accounts/locations/reviews, post review replies
 *
 * Uses include_granted_scopes=true so Google merges this scope with any
 * previously granted scopes on the same client. prompt=consent ensures a new
 * refresh_token is issued for the combined scope set.
 *
 * The same /api/google/connect/callback route handles the response.
 *
 * IMPORTANT: This route cannot be validated end-to-end until Google approves
 * the Cloud project's Business Profile API access (currently pending).
 * The route itself is structurally correct — it will function once API access
 * is granted and the credential holder visits this URL.
 *
 * Pre-requisites before visiting this URL:
 *   1. Google Cloud Console: enable My Business Account Management API,
 *      My Business Business Information API, Google My Business API,
 *      Business Profile Performance API.
 *   2. OAuth consent screen: declare business.manage scope.
 *   3. Google Business Profile Manager: confirm the account is Owner/Manager
 *      of all Killer Kebab locations.
 *   4. Google API access quota: confirm 300 QPM (approved), not 0 QPM.
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
    scope:                  [GBP_SCOPE],
    include_granted_scopes: true,
    state,
  })

  return NextResponse.redirect(authUrl)
}
