import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'

// OAuth callback handler.
// After Google redirects back, we:
// 1. Exchange the code for a session.
// 2. Look up the user in app_users by their Google subject ID.
// 3. If they exist and are active, provision / update their record and allow access.
// 4. If not, sign them out and redirect to /login with an error.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

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
  const serviceClient = await createServiceClient()

  const { data: appUser, error: lookupError } = await serviceClient
    .from('app_users')
    .select('id, active, display_name')
    .eq('google_subject_id', googleSubjectId)
    .single()

  if (lookupError || !appUser) {
    // User has authenticated with Google but is not in app_users.
    // This is the intended gate — a Google account alone does not grant access.
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=access_denied`)
  }

  if (!appUser.active) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/login?error=inactive`)
  }

  // Keep auth_user_id and display_name in sync.
  const displayName = (authUser.user_metadata?.full_name as string) ||
    (authUser.user_metadata?.name as string) ||
    appUser.display_name

  await serviceClient
    .from('app_users')
    .update({
      auth_user_id: authUser.id,
      display_name: displayName,
    })
    .eq('id', appUser.id)

  return NextResponse.redirect(`${origin}${next}`)
}
