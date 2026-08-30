import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { buildOAuth2Client, MEET_READONLY_SCOPE, MEET_SETTINGS_SCOPE } from '@/lib/google/auth'

const STATE_COOKIE         = 'google_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

/**
 * GET /api/google/connect/meet
 *
 * Initiates an incremental Google OAuth flow to add Google Meet read and
 * settings access alongside any existing Calendar, Gmail, and Drive grants.
 *
 * Scopes requested:
 *   meetings.space.readonly  — read conference records, transcripts, entries
 *   meetings.space.settings  — configure auto-transcription on Meet spaces
 *
 * Uses include_granted_scopes=true so Google merges these scopes with any
 * previously granted scopes (Calendar, Gmail, Drive) on the same client.
 * prompt=consent ensures a new refresh_token is issued for the combined scope.
 *
 * The same /api/google/connect/callback route handles the response.
 * All previously granted capabilities are preserved after this grant.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
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
    scope:                  [MEET_READONLY_SCOPE, MEET_SETTINGS_SCOPE],
    include_granted_scopes: true, // merge with existing Calendar / Gmail / Drive scopes
    state,
  })

  return NextResponse.redirect(authUrl)
}
