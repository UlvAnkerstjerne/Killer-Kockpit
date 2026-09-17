import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const ADS = 'https://www.googleapis.com/auth/adwords'
const GA4 = 'https://www.googleapis.com/auth/analytics.readonly'
const GSC = 'https://www.googleapis.com/auth/webmasters.readonly'
const mocks = vi.hoisted(() => ({
  user: vi.fn(), status: vi.fn(), generate: vi.fn(), setCookie: vi.fn(), getCookie: vi.fn(),
  getAuthUser: vi.fn(), lookup: vi.fn(), getToken: vi.fn(), userInfo: vi.fn(), store: vi.fn(), patch: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue({ set: mocks.setCookie, get: mocks.getCookie, delete: vi.fn() }) }))
vi.mock('@/lib/google/auth', () => ({
  GOOGLE_ADS_SCOPE: 'https://www.googleapis.com/auth/adwords',
  hasGoogleAdsScope: (scopes: string[]) => scopes.includes('https://www.googleapis.com/auth/adwords'),
  getGoogleConnectionStatus: mocks.status,
  buildOAuth2Client: () => ({ generateAuthUrl: mocks.generate, getToken: mocks.getToken, setCredentials: vi.fn() }),
  storeGoogleTokens: mocks.store,
  patchGoogleTokensPreservingRefresh: mocks.patch,
}))
vi.mock('googleapis', () => ({ google: { oauth2: () => ({ userinfo: { get: mocks.userInfo } }) } }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getAuthUser } }),
  createServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: mocks.lookup }) }) }) }) }),
}))

import { GET as connect } from '@/app/api/google/connect/ads/route'
import { GET as callback } from '@/app/api/google/connect/callback/route'

function callbackRequest() {
  return new Request('http://localhost:8080/api/google/connect/callback?code=test-code&state=ads:nonce') as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://kockpit.killerkebab.com')
  mocks.user.mockResolvedValue({ id: 'admin', role: 'SUPER_ADMIN', email: 'ulv@killerkebab.com' })
  mocks.status.mockResolvedValue({ connected: true, scopes: [GA4, GSC], googleAccountEmail: 'ulv@killerkebab.com' })
  mocks.generate.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth')
  mocks.getCookie.mockReturnValue({ value: 'ads:nonce' })
  mocks.getAuthUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } } })
  mocks.lookup.mockResolvedValue({ data: { id: 'admin', role: 'SUPER_ADMIN' } })
  mocks.getToken.mockResolvedValue({ tokens: { access_token: 'test-access', refresh_token: 'test-refresh', scope: [GA4, GSC, ADS].join(' ') } })
  mocks.userInfo.mockResolvedValue({ data: { email: 'ulv@killerkebab.com' } })
})
afterEach(() => vi.unstubAllEnvs())

describe('Ads incremental authorization', () => {
  it('redirects unauthenticated users to the canonical login page', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await connect()).headers.get('location')).toBe('https://kockpit.killerkebab.com/login')
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('rejects non-admin users', async () => {
    mocks.user.mockResolvedValue({ id: 'member', role: 'MEMBER' })
    expect((await connect()).status).toBe(403)
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('requests Ads while preserving current grants, account and CSRF protection', async () => {
    await connect()
    expect(mocks.status).toHaveBeenCalledWith('admin')
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      include_granted_scopes: true, prompt: 'consent', access_type: 'offline',
      scope: expect.arrayContaining([ADS, GA4, GSC]), login_hint: 'ulv@killerkebab.com',
      state: expect.stringMatching(/^ads:[0-9a-f]{48}$/),
    }))
    expect(mocks.setCookie).toHaveBeenCalledWith('google_oauth_state', mocks.generate.mock.calls[0][0].state,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 600 }))
  })

  it('rejects a mismatched CSRF state before exchanging credentials', async () => {
    mocks.getCookie.mockReturnValue({ value: 'another-state' })
    expect((await callback(callbackRequest())).headers.get('location')).toContain('state_mismatch')
    expect(mocks.getToken).not.toHaveBeenCalled()
  })

  it('preserves existing tokens when a different Google account is chosen', async () => {
    mocks.userInfo.mockResolvedValue({ data: { email: 'another@example.com' } })
    expect((await callback(callbackRequest())).headers.get('location')).toContain('ads_account_mismatch')
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('preserves existing tokens when Ads permission is declined', async () => {
    mocks.getToken.mockResolvedValue({ tokens: { access_token: 'new-access', scope: `${GA4} ${GSC}` } })
    expect((await callback(callbackRequest())).headers.get('location')).toContain('ads_permissions_missing')
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('preserves existing tokens if a previous grant is absent from the new token', async () => {
    mocks.getToken.mockResolvedValue({ tokens: { access_token: 'new-access', scope: `${GA4} ${ADS}` } })
    expect((await callback(callbackRequest())).headers.get('location')).toContain('ads_permissions_missing')
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('stores a valid combined grant for the same authenticated user', async () => {
    expect((await callback(callbackRequest())).headers.get('location')).toBe('https://kockpit.killerkebab.com/settings?connected=true')
    expect(mocks.store).toHaveBeenCalledWith('admin', expect.objectContaining({ scope: `${GA4} ${GSC} ${ADS}` }), 'ulv@killerkebab.com')
  })

  it('retains the existing refresh token when Google omits a new one', async () => {
    mocks.getToken.mockResolvedValue({ tokens: { access_token: 'new-access', scope: `${GA4} ${GSC} ${ADS}` } })
    await callback(callbackRequest())
    expect(mocks.patch).toHaveBeenCalledWith('admin', expect.any(Object), 'ulv@killerkebab.com')
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('rechecks administrator authority at the callback', async () => {
    mocks.lookup.mockResolvedValue({ data: { id: 'admin', role: 'MEMBER' } })
    expect((await callback(callbackRequest())).headers.get('location')).toContain('ads_admin_required')
    expect(mocks.getToken).not.toHaveBeenCalled()
  })
})
