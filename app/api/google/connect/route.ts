import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { buildOAuth2Client } from '@/lib/google/auth'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const STATE_COOKIE = 'google_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

/**
 * GET /api/google/connect
 *
 * Initiates the Google OAuth flow for Calendar integration.
 * Generates a CSRF state token, stores it in a short-lived httpOnly cookie,
 * and redirects the user to Google's consent screen.
 *
 * Scope: calendar.events only — narrowest scope for creating/updating/deleting
 * events on calendars the user already has write access to.
 * We do NOT request Gmail or Drive scopes here.
 *
 * prompt=consent ensures Google issues a refresh_token even if this scope
 * was previously authorised.  access_type=offline is required for the
 * refresh_token to be included in the response.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Generate CSRF state token
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
    access_type: 'offline',
    prompt:      'consent',
    scope:       [CALENDAR_SCOPE],
    state,
  })

  return NextResponse.redirect(authUrl)
}
