import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getAppOrigin } from '@/lib/app-url'
import { isKockpitMcpAllowedEmail } from '@/lib/mcp/access'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  const form = await request.formData()
  const authorizationId = form.get('authorization_id')
  const decision = form.get('decision')

  if (typeof authorizationId !== 'string' || !authorizationId || (decision !== 'approve' && decision !== 'deny')) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const appUser = await getCurrentUser()
  if (!appUser) {
    const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`
    return NextResponse.redirect(`${getAppOrigin()}/login?next=${encodeURIComponent(next)}`, 303)
  }
  if (!isKockpitMcpAllowedEmail(appUser.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const supabase = await createClient()
  const operation = decision === 'approve'
    ? supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
    : supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
  const { data, error } = await operation

  if (error || !data?.redirect_url) {
    return NextResponse.json({ error: 'authorization_failed' }, { status: 400 })
  }
  return NextResponse.redirect(data.redirect_url, 303)
}
