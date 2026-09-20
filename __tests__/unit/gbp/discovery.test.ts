/**
 * Tests for fetchGbpLocationsWildcard pagination.
 * Verifies the wildcard endpoint (accounts/-/locations) fetches all pages
 * and returns merged results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Auth } from 'googleapis'

describe('fetchGbpLocationsWildcard — pagination', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches all pages from accounts/-/locations and returns merged results', async () => {
    const { fetchGbpLocationsWildcard } = await vi.importActual<typeof import('@/lib/google/gbp-client')>('@/lib/google/gbp-client')

    const oauthClient = {
      getAccessToken: vi.fn().mockResolvedValue({ token: 'test-token' }),
    } as unknown as Auth.OAuth2Client

    const page1 = {
      locations: [{ name: 'locations/100', title: 'Loc A' }],
      nextPageToken: 'tok-xyz',
    }
    const page2 = {
      locations: [
        { name: 'locations/200', title: 'Loc B' },
        { name: 'locations/300', title: 'Loc C' },
      ],
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) })
    vi.stubGlobal('fetch', fetchMock)

    const results = await fetchGbpLocationsWildcard(oauthClient)

    expect(results).toHaveLength(3)
    expect(results.map(r => r.name)).toEqual(['locations/100', 'locations/200', 'locations/300'])

    // First request must use the wildcard path
    const firstUrl: string = fetchMock.mock.calls[0][0]
    expect(firstUrl).toContain('/accounts/-/locations')

    // Second request must include the nextPageToken from page 1
    const secondUrl: string = fetchMock.mock.calls[1][0]
    expect(secondUrl).toContain('pageToken=tok-xyz')
  })
})
