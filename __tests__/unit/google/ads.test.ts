import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ status: vi.fn(), client: vi.fn(), request: vi.fn(), user: vi.fn() }))
vi.mock('@/lib/google/auth', () => ({ getGoogleConnectionStatus: mocks.status, getGoogleOAuth2Client: mocks.client }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))

import { probeGoogleAds } from '@/lib/google/ads'
import { GET } from '@/app/api/google/ads/probe/route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'current-admin', role: 'SUPER_ADMIN' })
  mocks.status.mockResolvedValue({ connected: true, googleAdsEnabled: true })
  mocks.client.mockResolvedValue({ request: mocks.request })
  mocks.request.mockResolvedValue({ data: { resourceNames: ['customers/1234567890'] } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('Google Ads read-only probe', () => {
  it('requires login before accessing credentials', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('rejects non-admin users before accessing credentials', async () => {
    mocks.user.mockResolvedValue({ id: 'member', role: 'MEMBER' })
    expect((await GET()).status).toBe(403)
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('uses only the caller’s credentials and prevents response caching', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.client).toHaveBeenCalledWith('current-admin')
    expect(await response.json()).toMatchObject({ ok: true, customerIds: ['1234567890'] })
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
      url: 'https://googleads.googleapis.com/v25/customers:listAccessibleCustomers',
      method: 'GET', timeout: 15_000, retry: false,
    })
  })

  it('does not call Google or decrypt tokens when the Ads grant is missing', async () => {
    mocks.status.mockResolvedValue({ connected: true, googleAdsEnabled: false })
    const response = await GET()
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, code: 'MISSING_SCOPE' })
    expect(mocks.client).not.toHaveBeenCalled()
  })

  it('accepts an empty account list as a successful API response', async () => {
    mocks.request.mockResolvedValue({ data: {} })
    expect(await probeGoogleAds('current-admin')).toMatchObject({ ok: true, customerIds: [] })
  })

  it('rejects malformed account data', async () => {
    mocks.request.mockResolvedValue({ data: { resourceNames: ['not-an-account'] } })
    expect(await probeGoogleAds('current-admin')).toMatchObject({ ok: false })
  })

  it('never exposes token values, raw messages, or request configuration on failure', async () => {
    const secret = 'ya29.synthetic-secret'
    mocks.request.mockRejectedValue({
      message: secret, config: { headers: { Authorization: `Bearer ${secret}` } },
      response: {
        status: 403, headers: new Headers({ 'request-id': 'safe-request-id' }),
        data: { error: { message: secret, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } },
      },
    })
    const result = await probeGoogleAds('current-admin')
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_DISABLED', requestId: 'safe-request-id' })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret)
  })

  it('identifies the project Google rejected without sending users through consent again', async () => {
    mocks.request.mockRejectedValue({ response: { status: 403, data: { error: {
      status: 'PERMISSION_DENIED', details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com',
        metadata: {
          consumer: 'projects/33963364660', service: 'googleads.googleapis.com',
          activationUrl: 'https://untrusted.example/should-not-be-forwarded',
        },
      }],
    } } } })
    const response = await GET()
    expect(response.status).toBe(502)
    const result = await response.json()
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_DISABLED', cloudProjectNumber: '33963364660', reconnectRequired: false })
    expect(result.error).toContain('Cloud project 33963364660')
    expect(JSON.stringify(result)).not.toContain('untrusted.example')
    expect(console.warn).toHaveBeenCalledWith('[google/ads] Service disabled', expect.objectContaining({ cloudProjectNumber: '33963364660' }))
  })

  it.each([
    { consumer: 'projects/ya29.synthetic-secret', service: 'googleads.googleapis.com' },
    { consumer: 'projects/33963364660?token=secret', service: 'googleads.googleapis.com' },
    { consumer: 'projects/33963364660', service: 'another.googleapis.com' },
    { consumer: { unexpected: 'secret' }, service: 'googleads.googleapis.com' },
  ])('omits invalid or unrelated project metadata: %j', async metadata => {
    mocks.request.mockRejectedValue({ response: { status: 403, data: { error: {
      details: [{ reason: 'SERVICE_DISABLED', metadata }],
    } } } })
    const result = await probeGoogleAds('current-admin')
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_DISABLED', reconnectRequired: false })
    expect(result).not.toHaveProperty('cloudProjectNumber', expect.any(String))
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret')
  })

  it.each([[401, true], [403, false], [429, false], [500, false]])('offers reconnection only for credential failures: HTTP %i', async (status, reconnectRequired) => {
    mocks.request.mockRejectedValue({ response: { status } })
    expect(await probeGoogleAds('current-admin')).toMatchObject({ ok: false, reconnectRequired })
  })
})
