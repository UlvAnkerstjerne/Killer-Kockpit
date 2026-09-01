import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { buildOAuth2Client, DRIVE_SCOPE } from '@/lib/google/auth'
import { getAppOrigin } from '@/lib/app-url'

const STATE_COOKIE         = 'google_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

/**
 * GET /api/google/connect/drive
 *
 * Initiates an incremental Google OAuth flow to add Drive metadata read access
 * alongside any existing Calendar and Gmail grants.
 *
 * Scope: drive.metadata.readonly — reads file metadata (name, MIME type,
 * webViewLink, modifiedTime, owners) for files the user can access.
 * Never requests content read, write, or listing scopes.
 *
 * Uses include_granted_scopes=true so Google merges this scope with any
 * previously granted scopes (Calendar, Gmail) on the same client.
 * prompt=consent ensures a new refresh_token is issued for the combined scope.
 *
 * The same /api/google/connect/callback route handles the response.
 * Calendar and Gmail capabilities are preserved after this grant.
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
    scope:                  [DRIVE_SCOPE],
    include_granted_scopes: true, // merge with existing Calendar + Gmail scopes
    state,
  })

  return NextResponse.redirect(authUrl)
}
