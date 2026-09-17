import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { searchGoogleAds } from '@/lib/google/ads-client'
type Client = Parameters<typeof searchGoogleAds>[0]
describe('Google Ads read-only client', () => {
  it('fetches every result page with identical GAQL and no developer token', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { results: [{ id: '1' }], nextPageToken: 'page-2' } })
      .mockResolvedValueOnce({ data: { results: [{ id: '2' }] } })
    expect(await searchGoogleAds({ request } as unknown as Client, '8582465933', 'SELECT campaign.id FROM campaign')).toEqual([{ id: '1' }, { id: '2' }])
    expect(request.mock.calls[1][0]).toMatchObject({ method: 'POST', data: { query: 'SELECT campaign.id FROM campaign', pageToken: 'page-2' } })
    expect(request.mock.calls[0][0]).not.toHaveProperty('headers')
  })
  it('fails closed on repeated page tokens or malformed rows', async () => {
    const request = vi.fn().mockResolvedValue({ data: { results: [], nextPageToken: 'same' } })
    await expect(searchGoogleAds({ request } as unknown as Client, '8582465933', 'query')).rejects.toThrow('INVALID_PAGINATION')
    request.mockResolvedValue({ data: { results: 'bad' } })
    await expect(searchGoogleAds({ request } as unknown as Client, '8582465933', 'query')).rejects.toThrow('INVALID_RESPONSE')
  })
  it('reports production-access denial without leaking OAuth error details', async () => {
    const request = vi.fn().mockRejectedValue({ message: 'token-secret', config: { headers: { Authorization: 'token-secret' } },
      response: { status: 403, data: { error: { details: [{ errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' } }] }] } } } })
    const error = await searchGoogleAds({ request } as unknown as Client, '8582465933', 'query').catch(e => e)
    expect(error.message).toContain('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION')
    expect(String(error.stack)).not.toContain('token-secret')
    expect(error).not.toHaveProperty('response')
  })
})
