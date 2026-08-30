import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { google } from 'googleapis'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import {
  buildOAuth2Client,
  storeGoogleTokens,
  patchGoogleTokensPreservingRefresh,
} from '@/lib/google/auth'

const STATE_COOKIE = 'google_oauth_state'

/**
 * GET /api/google/connect/callback
 *
 * Handles the OAuth redirect from Google after the user consents.
 *
 * Steps:
 *  1. Verify the user is still authenticated in KK.
 *  2. Verify the state parameter matches the CSRF cookie (prevents CSRF).
 *  3. Exchange the authorisation code for access + refresh tokens.
 *  4. Fetch the connected Google account email via the userinfo endpoint.
 *  5. Store tokens:
 *     - If Google returned a refresh_token → full upsert (storeGoogleTokens).
 *     - If no refresh_token but user has an existing one → preserve existing
 *       refresh_token, update access_token + scopes (incremental auth).
 *     - If no refresh_token and no existing one → fail with actionable error.
 *  6. Redirect to /settings.
 *
 * Token values are NEVER logged, never returned in the response body,
 * and never appear in redirected URLs.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code  = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const redirectBase = `${origin}/settings`

  if (error) {
    return NextResponse.redirect(`${redirectBase}?google_error=${encodeURIComponent(error)}`)
  }

  if (!code || !state) {
    return NextResponse.redirect(`${redirectBase}?google_error=missing_params`)
  }

  // Verify CSRF state
  const cookieStore = await cookies()
  const storedState = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  if (!storedState || storedState !== state) {
    return NextResponse.redirect(`${redirectBase}?google_error=state_mismatch`)
  }

  // Verify KK session
  const supabase = await createClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.redirect(`${origin}/login`)
  }

  // Resolve app_user id from auth user
  const serviceClient = createServiceClient()
  const { data: appUser } = await serviceClient
    .from('app_users')
    .select('id')
    .eq('auth_user_id', authUser.id)
    .eq('active', true)
    .single()

  if (!appUser) {
    return NextResponse.redirect(`${redirectBase}?google_error=user_not_found`)
  }

  // Exchange code for tokens
  let credentials
  let client
  try {
    client = buildOAuth2Client()
    const { tokens } = await client.getToken(code)
    credentials = tokens
  } catch {
    return NextResponse.redirect(`${redirectBase}?google_error=token_exchange_failed`)
  }

  // Fetch the connected Google account email (best-effort; no sensitive data)
  let googleEmail: string | undefined
  try {
    client.setCredentials(credentials)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const { data: userInfo } = await oauth2.userinfo.get()
    googleEmail = userInfo.email ?? undefined
  } catch {
    // Non-fatal — email is used for UX (deep links) only, not for auth
  }

  // Store tokens — hardened: preserve existing refresh_token for incremental auth
  try {
    if (credentials.refresh_token) {
      // Full upsert: new refresh_token returned by Google
      await storeGoogleTokens(appUser.id, credentials, googleEmail)
    } else {
      // Incremental auth: Google did not issue a new refresh_token.
      // Preserve the existing one if it exists; fail with a clear error if not.
      try {
        await patchGoogleTokensPreservingRefresh(appUser.id, credentials, googleEmail)
      } catch {
        return NextResponse.redirect(`${redirectBase}?google_error=no_refresh_token`)
      }
    }
  } catch {
    return NextResponse.redirect(`${redirectBase}?google_error=storage_failed`)
  }

  return NextResponse.redirect(`${redirectBase}?connected=true`)
}
