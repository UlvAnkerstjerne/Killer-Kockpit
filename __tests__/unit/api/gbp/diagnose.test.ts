/**
 * Tests for GET /api/google/gbp/diagnose
 *
 * Verifies: auth gate, credential resolution, response shape, secret safety.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser        = vi.fn()
  const mockHasGbpScope           = vi.fn()
  const mockGetGoogleOAuth2Client = vi.fn()
  const mockFetchGbpAccounts      = vi.fn()
  const mockFetchGbpLocations     = vi.fn()
  const mockFetchGbpLocationsWildcard = vi.fn()
  const mockFrom                  = vi.fn()

  return {
    mockGetCurrentUser,
    mockHasGbpScope,
    mockGetGoogleOAuth2Client,
    mockFetchGbpAccounts,
    mockFetchGbpLocations,
    mockFetchGbpLocationsWildcard,
    mockFrom,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/google/auth', () => ({
  hasGbpScope: mocks.mockHasGbpScope,
  getGoogleOAuth2Client: mocks.mockGetGoogleOAuth2Client,
}))
vi.mock('@/lib/google/gbp-client', () => ({
  fetchGbpAccounts: mocks.mockFetchGbpAccounts,
  fetchGbpLocations: mocks.mockFetchGbpLocations,
  fetchGbpLocationsWildcard: mocks.mockFetchGbpLocationsWildcard,
  safeGbpError: () => 'GBP sync operation failed. No credentials were logged.',
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: mocks.mockFrom }),
}))
vi.mock('@/lib/gbp/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gbp/data')>()
  return actual
})

// ── Helpers ────────────────────────────────────────────────────────────────────

const SUPER_ADMIN = { id: 'admin-1', role: 'SUPER_ADMIN', email: 'admin@test.com' }
const fakeClient  = {}

/** Set up db.from() to handle token and user table queries. */
function setupDb(opts: { tokens?: { user_id: string; scopes: string[] }[]; admins?: { id: string; email: string }[] } = {}) {
  const { tokens = [{ user_id: 'admin-1', scopes: ['https://www.googleapis.com/auth/business.manage'] }], admins = [{ id: 'admin-1', email: 'admin@test.com' }] } = opts
  mocks.mockFrom.mockImplementation((table: string) => ({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
      if (table === 'google_oauth_tokens') return Promise.resolve(resolve({ data: tokens, error: null }))
      if (table === 'app_users') return Promise.resolve(resolve({ data: admins, error: null }))
      return Promise.resolve(resolve({ data: [], error: null }))
    },
  }))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/google/gbp/diagnose — auth gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.status).toBe(401)
    expect(mocks.mockFetchGbpAccounts).not.toHaveBeenCalled()
  })

  it('returns 403 for non-SUPER_ADMIN users', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue({ id: 'u1', role: 'MEMBER' })
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.status).toBe(403)
    expect(mocks.mockFetchGbpAccounts).not.toHaveBeenCalled()
  })

  it('returns 400 when no GBP-scoped credential exists', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(false)
    setupDb({ tokens: [{ user_id: 'admin-1', scopes: ['other-scope'] }] })
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/No GBP-scoped credential/)
    expect(mocks.mockFetchGbpAccounts).not.toHaveBeenCalled()
  })
})

describe('GET /api/google/gbp/diagnose — response', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(true)
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue(fakeClient)
    setupDb()
    mocks.mockFetchGbpAccounts.mockResolvedValue([
      { name: 'accounts/123', accountName: 'Killer Kebab', type: 'LOCATION_GROUP', role: 'OWNER', permissionLevel: 'OWNER_LEVEL' },
    ])
    mocks.mockFetchGbpLocations.mockResolvedValue([
      { name: 'locations/77', title: 'Nørreport', storeCode: 'CPH' },
    ])
    mocks.mockFetchGbpLocationsWildcard.mockResolvedValue([
      { name: 'locations/77', title: 'Nørreport' },
      { name: 'locations/88', title: 'Aarhus' },
    ])
  })

  it('returns 200 with user email, accounts, directLocations, and wildcardLocations', async () => {
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.user).toBe('admin@test.com')
    expect(body.accounts).toHaveLength(1)

    const account = body.accounts[0]
    expect(account.name).toBe('accounts/123')
    expect(account.accountName).toBe('Killer Kebab')
    expect(account.type).toBe('LOCATION_GROUP')
    expect(account.role).toBe('OWNER')
    expect(account.permissionLevel).toBe('OWNER_LEVEL')
    expect(account.directLocations).toEqual([{ name: 'locations/77', title: 'Nørreport' }])

    expect(body.wildcardLocations).toHaveLength(2)
    expect(body.wildcardLocations[1]).toEqual({ name: 'locations/88', title: 'Aarhus' })
  })

  it('never exposes token, secret, or credential fields in the response', async () => {
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    const raw = await res.text()
    for (const forbidden of ['access_token', 'refresh_token', 'client_secret', 'encryption', 'private_key']) {
      expect(raw).not.toContain(forbidden)
    }
  })

  it('includes directError on per-account fetch failure without aborting other accounts', async () => {
    mocks.mockFetchGbpAccounts.mockResolvedValue([
      { name: 'accounts/123', accountName: 'Killer Kebab', type: 'LOCATION_GROUP' },
      { name: 'accounts/456', accountName: 'Personal', type: 'PERSONAL' },
    ])
    mocks.mockFetchGbpLocations
      .mockRejectedValueOnce(new Error('secret-token-error'))
      .mockResolvedValueOnce([{ name: 'locations/99', title: 'Other Store' }])

    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.accounts[0].directError).toBeDefined()
    // Error message must be sanitised — raw secret must not leak
    expect(JSON.stringify(body)).not.toContain('secret-token-error')
    expect(body.accounts[1].directLocations).toHaveLength(1)
  })

  it('includes wildcardError without failing the whole response', async () => {
    mocks.mockFetchGbpLocationsWildcard.mockRejectedValue(new Error('wildcard-failure'))
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.wildcardLocations).toHaveLength(0)
    expect(body.wildcardError).toBeDefined()
  })

  it('sets Cache-Control: private, no-store', async () => {
    const { GET } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await GET()
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('POST /api/google/gbp/diagnose', () => {
  it('returns 405', async () => {
    const { POST } = await import('@/app/api/google/gbp/diagnose/route')
    const res = await POST()
    expect(res.status).toBe(405)
  })
})
