/**
 * Regression tests for the Google OAuth connect routes.
 *
 * Guarantees that when incoming request.url carries Railway's internal
 * localhost:8080 address, all redirects still use the configured canonical
 * public origin from NEXT_PUBLIC_APP_URL.
 *
 * Covers:
 *   - /api/google/connect/callback — success, every error branch
 *   - /api/google/connect          — unauthenticated → /login
 *   - /api/google/connect/gbp      — unauthenticated → /login
 *   - /api/google/connect/meet     — unauthenticated → /login
 *   - /api/google/connect/gmail    — unauthenticated → /login
 *   - /api/google/connect/drive    — unauthenticated → /login
 *   - local APP_URL (http://localhost:3001)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted mock state ─────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetUser        = vi.fn()
  const mockLookupSingle   = vi.fn()
  const mockGetToken       = vi.fn()
  const mockSetCredentials = vi.fn()
  const mockUserinfoGet    = vi.fn()
  const mockStoreTokens    = vi.fn()
  const mockPatchTokens    = vi.fn()
  const mockGetCookie      = vi.fn()
  const mockDeleteCookie   = vi.fn()
  const mockSetCookie      = vi.fn()

  const mockOAuth2Client = {
    getToken:        mockGetToken,
    setCredentials:  mockSetCredentials,
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/auth'),
  }

  const mockServiceClient = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: mockLookupSingle }),
        }),
      }),
    }),
  }

  return {
    mockGetUser,
    mockLookupSingle,
    mockGetToken,
    mockSetCredentials,
    mockUserinfoGet,
    mockStoreTokens,
    mockPatchTokens,
    mockGetCookie,
    mockDeleteCookie,
    mockSetCookie,
    mockOAuth2Client,
    mockServiceClient,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mocks.mockGetUser },
  }),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))

vi.mock('@/lib/google/auth', () => ({
  buildOAuth2Client:              vi.fn().mockReturnValue(mocks.mockOAuth2Client),
  storeGoogleTokens:              mocks.mockStoreTokens,
  patchGoogleTokensPreservingRefresh: mocks.mockPatchTokens,
  GBP_SCOPE:    'https://www.googleapis.com/auth/business.manage',
  GMAIL_SCOPE:  'https://www.googleapis.com/auth/gmail.readonly',
  DRIVE_SCOPE:  'https://www.googleapis.com/auth/drive.metadata.readonly',
  MEET_READONLY_SCOPE: 'https://www.googleapis.com/auth/meetings.space.readonly',
  MEET_SETTINGS_SCOPE: 'https://www.googleapis.com/auth/meetings.space.settings',
}))

vi.mock('googleapis', () => ({
  google: {
    oauth2: vi.fn().mockReturnValue({
      userinfo: { get: mocks.mockUserinfoGet },
    }),
  },
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get:    mocks.mockGetCookie,
    delete: mocks.mockDeleteCookie,
    set:    mocks.mockSetCookie,
  }),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: vi.fn().mockImplementation((url: string | URL) => ({
      status: 307,
      _location: url.toString(),
    })),
  },
}))

// ── Helpers ────────────────────────────────────────────────────────────────

const PROD_URL  = 'https://kockpit.killerkebab.com'
const LOCAL_URL = 'http://localhost:3001'

function makeInternalRequest(path: string): Request {
  return new Request(`https://localhost:8080${path}`)
}

function location(response: unknown): string {
  return (response as { _location: string })._location
}

// ── Google connect callback ────────────────────────────────────────────────

describe('GET /api/google/connect/callback — canonical origin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = PROD_URL

    // Default: authenticated user found in app_users
    mocks.mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-uuid' } } })
    mocks.mockLookupSingle.mockResolvedValue({ data: { id: 'app-user-id' }, error: null })
    mocks.mockGetToken.mockResolvedValue({ tokens: { refresh_token: 'rt', access_token: 'at' } })
    mocks.mockUserinfoGet.mockResolvedValue({ data: { email: 'user@google.com' } })
    mocks.mockStoreTokens.mockResolvedValue(undefined)
    mocks.mockGetCookie.mockReturnValue({ value: 'valid-state' })
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('redirects google_error param to public /settings, not localhost:8080', async () => {
    const { GET } = await import('@/app/api/google/connect/callback/route')
    const req = makeInternalRequest('/api/google/connect/callback?error=access_denied')
    const res = await GET(req as never)
    expect(location(res)).toBe(`${PROD_URL}/settings?google_error=access_denied`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('redirects missing_params to public /settings, not localhost:8080', async () => {
    const { GET } = await import('@/app/api/google/connect/callback/route')
    const req = makeInternalRequest('/api/google/connect/callback')
    const res = await GET(req as never)
    expect(location(res)).toBe(`${PROD_URL}/settings?google_error=missing_params`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('redirects state_mismatch to public /settings, not localhost:8080', async () => {
    mocks.mockGetCookie.mockReturnValue({ value: 'wrong-state' })
    const { GET } = await import('@/app/api/google/connect/callback/route')
    const req = makeInternalRequest('/api/google/connect/callback?code=abc&state=different-state')
    const res = await GET(req as never)
    expect(location(res)).toBe(`${PROD_URL}/settings?google_error=state_mismatch`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('redirects unauthenticated user to public /login, not localhost:8080', async () => {
    mocks.mockGetCookie.mockReturnValue({ value: 'match' })
    mocks.mockGetUser.mockResolvedValue({ data: { user: null } })
    const { GET } = await import('@/app/api/google/connect/callback/route')
    const req = makeInternalRequest('/api/google/connect/callback?code=abc&state=match')
    const res = await GET(req as never)
    expect(location(res)).toBe(`${PROD_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('redirects connected=true to public /settings on success, not localhost:8080', async () => {
    mocks.mockGetCookie.mockReturnValue({ value: 'match' })
    const { GET } = await import('@/app/api/google/connect/callback/route')
    const req = makeInternalRequest('/api/google/connect/callback?code=abc&state=match')
    const res = await GET(req as never)
    expect(location(res)).toBe(`${PROD_URL}/settings?connected=true`)
    expect(location(res)).not.toContain('localhost:8080')
  })
})

// ── Unauthenticated initiation routes ─────────────────────────────────────
//
// Each Google connect initiation route guards with a session check and
// redirects to /login when the user is not authenticated.  All five routes
// use the same pattern — one test per route proves the fix is present.

describe('Google connect initiation routes — unauthenticated → canonical /login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = PROD_URL
    mocks.mockGetUser.mockResolvedValue({ data: { user: null } })
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('/api/google/connect redirects to public /login', async () => {
    const { GET } = await import('@/app/api/google/connect/route')
    const res = await GET(makeInternalRequest('/api/google/connect') as never)
    expect(location(res)).toBe(`${PROD_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('/api/google/connect/gbp redirects to public /login', async () => {
    const { GET } = await import('@/app/api/google/connect/gbp/route')
    const res = await GET(makeInternalRequest('/api/google/connect/gbp') as never)
    expect(location(res)).toBe(`${PROD_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('/api/google/connect/meet redirects to public /login', async () => {
    const { GET } = await import('@/app/api/google/connect/meet/route')
    const res = await GET(makeInternalRequest('/api/google/connect/meet') as never)
    expect(location(res)).toBe(`${PROD_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('/api/google/connect/gmail redirects to public /login', async () => {
    const { GET } = await import('@/app/api/google/connect/gmail/route')
    const res = await GET(makeInternalRequest('/api/google/connect/gmail') as never)
    expect(location(res)).toBe(`${PROD_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('/api/google/connect/drive redirects to public /login', async () => {
    const { GET } = await import('@/app/api/google/connect/drive/route')
    const res = await GET(makeInternalRequest('/api/google/connect/drive') as never)
    expect(location(res)).toBe(`${PROD_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })

  it('local dev: redirects to localhost:3001/login when APP_URL is local', async () => {
    process.env.NEXT_PUBLIC_APP_URL = LOCAL_URL
    const { GET } = await import('@/app/api/google/connect/route')
    const res = await GET(makeInternalRequest('/api/google/connect') as never)
    expect(location(res)).toBe(`${LOCAL_URL}/login`)
    expect(location(res)).not.toContain('localhost:8080')
  })
})
