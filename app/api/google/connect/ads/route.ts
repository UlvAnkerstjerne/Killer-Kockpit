import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { getCurrentUser } from '@/lib/auth'
import { getAppOrigin } from '@/lib/app-url'
import { buildOAuth2Client, getGoogleConnectionStatus, GOOGLE_ADS_SCOPE } from '@/lib/google/auth'

/** Add Ads to the current user's Google connection without disconnecting it. */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(`${getAppOrigin()}/login`)
  if (user.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Administrator access required.' }, { status: 403 })
  }

  const existing = await getGoogleConnectionStatus(user.id)
  const state = `ads:${crypto.randomBytes(24).toString('hex')}`
  const cookieStore = await cookies()
  cookieStore.set('google_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })

  const client = buildOAuth2Client()
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...new Set([
      ...(existing.connected ? existing.scopes : []),
      'https://www.googleapis.com/auth/userinfo.email',
      GOOGLE_ADS_SCOPE,
    ])],
    login_hint: existing.connected ? existing.googleAccountEmail ?? user.email : user.email,
    state,
  })
  return NextResponse.redirect(authUrl)
}
