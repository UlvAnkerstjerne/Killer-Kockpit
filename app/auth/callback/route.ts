import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getAppOrigin } from '@/lib/app-url'

// OAuth callback handler.
// After Google redirects back, we:
// 1. Exchange the code for a session.
// 2. Look up the user in app_users by email (supports pre-approved users who
//    have not yet logged in — their google_subject_id is still NULL).
// 3. If found with a NULL google_subject_id (first login), atomically bind
//    their Google identity via bind_user_identity_and_audit.
// 4. If found with a matching google_subject_id (returning user), keep
//    auth_user_id and display_name in sync.
// 5. If the email exists but the google_subject_id is a DIFFERENT value,
//    sign out — this would be a different Google account trying to claim the
//    same email slot, which we treat as a potential hijack attempt.
// 6. If no app_users row exists for the email, sign out (access denied).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  // Use the configured canonical origin — not request.url — so redirects work
  // correctly behind Railway's reverse proxy (see lib/app-url.ts).
  const origin = getAppOrigin()

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`)
  }

  const supabase = await createClient()
  const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code)

  if (sessionError || !sessionData.user) {
    return NextResponse.redirect(`${origin}/login?error=session_error`)
  }

  const authUser = sessionData.user
  const googleSubjectId = authUser.user_metadata?.sub as string | undefined
  const email = authUser.email

  if (!googleSubjectId || !email) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=missing_identity`)
  }

  // Use service role to query/update app_users — bypasses RLS for provisioning.
  const serviceClient = createServiceClient()

  const { data: appUser, error: lookupError } = await serviceClient
    .from('app_users')
    .select('id, active, display_name, google_subject_id')
    .eq('email', email)
    .single()

  if (lookupError || !appUser) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=access_denied`)
  }

  if (!appUser.active) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=inactive`)
  }

  const displayName = (authUser.user_metadata?.full_name as string) ||
    (authUser.user_metadata?.name as string) ||
    appUser.display_name

  if (appUser.google_subject_id === null) {
    // First login for a pre-approved user — bind Google identity atomically.
    const { error: bindError } = await serviceClient.rpc('bind_user_identity_and_audit', {
      p_user_id:           appUser.id,
      p_google_subject_id: googleSubjectId,
      p_auth_user_id:      authUser.id,
      p_display_name:      displayName,
    })

    if (bindError) {
      console.error('[auth/callback] Failed to bind user identity:', bindError)
      await supabase.auth.signOut()
      return NextResponse.redirect(`${origin}/login?error=provisioning_failed`)
    }
  } else if (appUser.google_subject_id !== googleSubjectId) {
    // A different Google account is trying to claim this email slot.
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=identity_mismatch`)
  } else {
    // Returning user — keep auth_user_id and display_name in sync.
    const { error: updateError } = await serviceClient
      .from('app_users')
      .update({ auth_user_id: authUser.id, display_name: displayName })
      .eq('id', appUser.id)

    if (updateError) {
      console.error('[auth/callback] Failed to write auth_user_id:', updateError)
      await supabase.auth.signOut()
      return NextResponse.redirect(`${origin}/login?error=provisioning_failed`)
    }
  }

  return NextResponse.redirect(`${origin}${next}`)
}
