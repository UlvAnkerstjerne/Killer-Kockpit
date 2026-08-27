/**
 * Regression tests for the createServiceClient() fix.
 *
 * Bug fixed: createServiceClient() was using @supabase/ssr's createServerClient,
 * which reads the user's session from cookies. After exchangeCodeForSession set
 * the session cookie, the "service" client picked it up and sent requests as the
 * authenticated user instead of as service role. This caused the RLS UPDATE policy
 * on app_users to fail (get_my_role() returned null because auth_user_id was still
 * null), leaving auth_user_id unpopulated and triggering an infinite redirect loop.
 *
 * The fix: createServiceClient() uses the base @supabase/supabase-js createClient,
 * which has no cookie awareness and always sends the service role key.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'

// Mock next/headers so we can detect if cookies() is ever called.
// If createServiceClient() still used @supabase/ssr it would call cookies().
const cookiesSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error(
      'cookies() was called — createServiceClient must not use @supabase/ssr or next/headers'
    )
  })
)
vi.mock('next/headers', () => ({ cookies: cookiesSpy }))

// Provide dummy env vars so createClient() from @supabase/supabase-js can
// initialise without network access. No real credentials are used.
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test-project.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'
  process.env.SUPABASE_SECRET_KEY = 'test-service-role-key'
})

describe('createServiceClient — regression: must not read session cookies', () => {
  it('is synchronous — returns a client directly, not a Promise', async () => {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const result = createServiceClient()
    // A Promise would indicate async behaviour (i.e. awaiting cookies())
    expect(result).not.toBeInstanceOf(Promise)
  })

  it('does not call cookies() from next/headers', async () => {
    const { createServiceClient } = await import('@/lib/supabase/server')
    cookiesSpy.mockClear()
    expect(() => createServiceClient()).not.toThrow()
    expect(cookiesSpy).not.toHaveBeenCalled()
  })

  it('returns a Supabase client with a .from() method', async () => {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const client = createServiceClient()
    expect(typeof client.from).toBe('function')
  })

  it('createClient() (user session client) does call cookies() — confirming the mock works', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    cookiesSpy.mockImplementation(() => {
      throw new Error('cookies called')
    })
    // createClient is async and calls await cookies() — it must throw here.
    await expect(createClient()).rejects.toThrow('cookies called')
  })
})
