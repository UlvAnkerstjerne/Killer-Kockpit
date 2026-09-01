import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { buildOAuth2Client, GMAIL_SCOPE } from '@/lib/google/auth'
import { getAppOrigin } from '@/lib/app-url'

const STATE_COOKIE     = 'google_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

/**
 * GET /api/google/connect/gmail
 *
 * Initiates an incremental Google OAuth flow to add Gmail read access
 * alongside the existing Calendar grant.
 *
 * Uses include_granted_scopes=true so Google merges this scope request
 * with any previously granted scopes on the same client.  prompt=consent
 * ensures a new refresh_token is issued for the combined scope set.
 *
 * The same /api/google/connect/callback route handles the response.
 * If Google returns a new refresh_token, it replaces the old one.
 * If it does not (rare — prompt=consent should always return one),
 * the callback preserves the existing stored refresh_token.
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
    scope:                  [GMAIL_SCOPE],
    include_granted_scopes: true, // merge with existing Calendar scope
    state,
  })

  return NextResponse.redirect(authUrl)
}
