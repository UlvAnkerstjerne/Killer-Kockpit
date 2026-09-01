/**
 * Tests for the OAuth callback route handler at app/auth/callback/route.ts.
 *
 * Covers every branch:
 *   1. No code in URL            → /login?error=no_code
 *   2. exchangeCodeForSession fails → /login?error=session_error
 *   3. Missing google subject ID → /login?error=missing_identity (after signOut)
 *   4. User not in app_users     → /login?error=access_denied   (after signOut)
 *   5. User inactive             → /login?error=inactive        (after signOut)
 *   6. UPDATE fails (regression) → /login?error=provisioning_failed (after signOut)
 *   7. Happy path                → auth_user_id written, redirect to /
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Hoisted mock state -------------------------------------------------------
// vi.mock factories are hoisted before imports, so shared state must also be
// hoisted via vi.hoisted().

const mocks = vi.hoisted(() => {
  const mockSignOut = vi.fn().mockResolvedValue({})
  const mockExchangeCodeForSession = vi.fn()

  // Service client operations on app_users
  const mockLookupSingle = vi.fn()
  const mockUpdateEq = vi.fn()

  const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null })

  const mockServiceClient = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'app_users') throw new Error(`Unexpected table: ${table}`)
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockLookupSingle }),
        }),
        update: vi.fn().mockReturnValue({ eq: mockUpdateEq }),
      }
    }),
    rpc: mockRpc,
  }

  return {
    mockSignOut,
    mockExchangeCodeForSession,
    mockLookupSingle,
    mockUpdateEq,
    mockRpc,
    mockServiceClient,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      exchangeCodeForSession: mocks.mockExchangeCodeForSession,
      signOut: mocks.mockSignOut,
    },
  }),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: vi.fn().mockImplementation((url: string | URL) => ({
      status: 307,
      headers: new Map([['location', url.toString()]]),
      _location: url.toString(),
    })),
  },
}))

// ---- Helpers -----------------------------------------------------------------

function makeRequest(path: string) {
  return new Request(`http://localhost:3000${path}`)
}

function getRedirectLocation(response: unknown): string {
  return (response as { _location: string })._location
}

// ---- Tests -------------------------------------------------------------------

describe('GET /auth/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
    // Default: session error will be overridden per test
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: null,
    })
    mocks.mockLookupSingle.mockResolvedValue({ data: null, error: null })
    mocks.mockUpdateEq.mockResolvedValue({ data: null, error: null })
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('redirects to /login?error=no_code when no code param is present', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback'))
    expect(getRedirectLocation(response)).toContain('/login?error=no_code')
  })

  it('redirects to /login?error=session_error when exchangeCodeForSession returns an error', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid code' },
    })
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=bad-code'))
    expect(getRedirectLocation(response)).toContain('/login?error=session_error')
  })

  it('signs out and redirects to /login?error=missing_identity when google sub is absent', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: 'auth-uuid',
          email: 'test@example.com',
          user_metadata: {}, // no 'sub' field
        },
      },
      error: null,
    })
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=abc'))
    expect(mocks.mockSignOut).toHaveBeenCalledOnce()
    expect(getRedirectLocation(response)).toContain('/login?error=missing_identity')
  })

  it('signs out and redirects to /login?error=access_denied when user is not in app_users', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: 'auth-uuid',
          email: 'unknown@example.com',
          user_metadata: { sub: '999000999', full_name: 'Unknown User' },
        },
      },
      error: null,
    })
    // Lookup returns no row
    mocks.mockLookupSingle.mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'No rows returned' },
    })

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=abc'))
    expect(mocks.mockSignOut).toHaveBeenCalledOnce()
    expect(getRedirectLocation(response)).toContain('/login?error=access_denied')
  })

  it('signs out and redirects to /login?error=inactive when user.active is false', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: 'auth-uuid',
          email: 'deactivated@example.com',
          user_metadata: { sub: '123456789', full_name: 'Deactivated User' },
        },
      },
      error: null,
    })
    mocks.mockLookupSingle.mockResolvedValue({
      data: { id: 'app-user-uuid', active: false, display_name: 'Deactivated User' },
      error: null,
    })

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=abc'))
    expect(mocks.mockSignOut).toHaveBeenCalledOnce()
    expect(getRedirectLocation(response)).toContain('/login?error=inactive')
  })

  /**
   * REGRESSION: When the service client UPDATE fails, the callback must sign
   * the user out and redirect to /login?error=provisioning_failed rather than
   * silently redirecting to / and causing an infinite redirect loop.
   *
   * This was the exact failure mode: UPDATE was blocked by RLS (because the
   * service client was behaving as the session user, and get_my_role() returned
   * null due to auth_user_id still being null), auth_user_id stayed null,
   * getCurrentUser() returned null in the app layout → /login, login page saw
   * an active session → /, and the loop repeated indefinitely.
   */
  it('REGRESSION: signs out and redirects to /login?error=provisioning_failed when UPDATE fails', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: 'auth-uuid',
          email: 'admin@killerkebab.com',
          user_metadata: { sub: '100000000001', full_name: 'Admin User' },
        },
      },
      error: null,
    })
    // google_subject_id matches the sub in user_metadata → returning-user branch → UPDATE
    mocks.mockLookupSingle.mockResolvedValue({
      data: { id: 'app-user-uuid', active: true, display_name: 'Admin User', google_subject_id: '100000000001' },
      error: null,
    })
    // UPDATE fails — simulates the RLS block that caused the original bug
    mocks.mockUpdateEq.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    })

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=abc'))
    expect(mocks.mockSignOut).toHaveBeenCalledOnce()
    expect(getRedirectLocation(response)).toContain('/login?error=provisioning_failed')
  })

  it('happy path: writes auth_user_id and redirects to /', async () => {
    const authUserId = 'supabase-auth-uuid-123'
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: authUserId,
          email: 'admin@killerkebab.com',
          user_metadata: { sub: '100000000001', full_name: 'Admin User' },
        },
      },
      error: null,
    })
    // Returning user — google_subject_id matches sub → UPDATE branch
    mocks.mockLookupSingle.mockResolvedValue({
      data: { id: 'app-user-uuid', active: true, display_name: 'Admin User', google_subject_id: '100000000001' },
      error: null,
    })
    mocks.mockUpdateEq.mockResolvedValue({ data: null, error: null })

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=abc'))

    // Must not sign out on success
    expect(mocks.mockSignOut).not.toHaveBeenCalled()

    // Must attempt the UPDATE (writing auth_user_id)
    expect(mocks.mockUpdateEq).toHaveBeenCalledOnce()

    // Must redirect to / (the default next value)
    const location = getRedirectLocation(response)
    expect(location).toMatch(/\/$/)
    expect(location).not.toContain('error')
  })

  it('happy path: respects the ?next param for deep-link redirects', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: 'auth-uuid',
          email: 'admin@killerkebab.com',
          user_metadata: { sub: '100000000001', full_name: 'Admin' },
        },
      },
      error: null,
    })
    // Returning user — google_subject_id matches sub → UPDATE branch
    mocks.mockLookupSingle.mockResolvedValue({
      data: { id: 'app-user-uuid', active: true, display_name: 'Admin', google_subject_id: '100000000001' },
      error: null,
    })
    mocks.mockUpdateEq.mockResolvedValue({ data: null, error: null })

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeRequest('/auth/callback?code=abc&next=/projects'))
    expect(getRedirectLocation(response)).toContain('/projects')
  })
})

// ── Railway reverse-proxy origin regression ────────────────────────────────
//
// When running behind Railway, request.url has an internal localhost:8080
// origin. These tests confirm that all redirects use the canonical public
// domain from NEXT_PUBLIC_APP_URL regardless of what request.url contains.

describe('GET /auth/callback — canonical origin from NEXT_PUBLIC_APP_URL', () => {
  const PROD_URL = 'https://kockpit.killerkebab.com'
  const LOCAL_URL = 'http://localhost:3001'

  // Use a request whose URL looks like what Railway forwards internally
  function makeInternalRequest(path: string) {
    return new Request(`https://localhost:8080${path}`)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = PROD_URL
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: null,
    })
    mocks.mockLookupSingle.mockResolvedValue({ data: null, error: null })
    mocks.mockUpdateEq.mockResolvedValue({ data: null, error: null })
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('redirects error paths to configured public origin, not localhost:8080', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeInternalRequest('/auth/callback'))
    const location = getRedirectLocation(response)
    // Must use the public origin
    expect(location).toBe(`${PROD_URL}/login?error=no_code`)
    // Must NOT contain the internal Railway address
    expect(location).not.toContain('localhost:8080')
  })

  it('redirects session_error to public origin login page', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: { message: 'expired code' },
    })
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeInternalRequest('/auth/callback?code=expired'))
    const location = getRedirectLocation(response)
    expect(location).toBe(`${PROD_URL}/login?error=session_error`)
    expect(location).not.toContain('localhost:8080')
  })

  it('redirects successful auth to public origin', async () => {
    mocks.mockExchangeCodeForSession.mockResolvedValue({
      data: {
        user: {
          id: 'auth-uuid',
          email: 'admin@killerkebab.com',
          user_metadata: { sub: '100000000001', full_name: 'Admin' },
        },
      },
      error: null,
    })
    mocks.mockLookupSingle.mockResolvedValue({
      data: { id: 'app-user-uuid', active: true, display_name: 'Admin', google_subject_id: '100000000001' },
      error: null,
    })
    mocks.mockUpdateEq.mockResolvedValue({ data: null, error: null })

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeInternalRequest('/auth/callback?code=valid'))
    const location = getRedirectLocation(response)
    expect(location).toBe(`${PROD_URL}/`)
    expect(location).not.toContain('localhost:8080')
  })

  it('uses local dev origin when NEXT_PUBLIC_APP_URL is http://localhost:3001', async () => {
    process.env.NEXT_PUBLIC_APP_URL = LOCAL_URL

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeInternalRequest('/auth/callback'))
    const location = getRedirectLocation(response)
    expect(location).toBe(`${LOCAL_URL}/login?error=no_code`)
    expect(location).not.toContain('localhost:8080')
  })

  it('strips trailing slash from NEXT_PUBLIC_APP_URL before constructing redirects', async () => {
    process.env.NEXT_PUBLIC_APP_URL = `${PROD_URL}/`

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeInternalRequest('/auth/callback'))
    const location = getRedirectLocation(response)
    // Must not produce double slash: .../login not ...//login
    expect(location).toBe(`${PROD_URL}/login?error=no_code`)
  })

  it('returns 500 when NEXT_PUBLIC_APP_URL is missing', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL

    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(makeInternalRequest('/auth/callback?code=abc'))
    // Must not redirect at all — Response status 500
    expect((response as Response).status).toBe(500)
  })
})
