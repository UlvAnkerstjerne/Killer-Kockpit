import { createServerClient } from '@supabase/ssr'
import { createClient as createBaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

// Server-side Supabase client — use in server components and server actions.
// Reads the user's session from cookies automatically.
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll called from a Server Component — cookies can't be set
            // in that context but the session is still readable.
          }
        },
      },
    }
  )
}

// Secret-key client — bypasses RLS. Use only for privileged server-side
// operations such as writing audit events or provisioning users.
// NEVER expose the secret key to the browser (no NEXT_PUBLIC_ prefix).
//
// Uses the base @supabase/supabase-js client intentionally — NOT the SSR
// client. The SSR client reads cookies and can pick up the user's session,
// which would make it run as the user (subject to RLS) rather than as the
// service role. The base client has no cookie awareness and always sends
// the service role key, which bypasses RLS unconditionally.
export function createServiceClient() {
  return createBaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
