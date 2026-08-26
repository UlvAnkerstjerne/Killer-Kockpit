import { createBrowserClient } from '@supabase/ssr'

// Browser-side Supabase client — safe for client components.
// Uses the publishable key, which is RLS-protected and safe to expose.
// Never use this for privileged operations; use the server client instead.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}
