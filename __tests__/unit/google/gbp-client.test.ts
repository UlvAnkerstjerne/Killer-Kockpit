/**
 * Tests for lib/google/gbp-client.ts
 *
 * All tests mock fetch — no live GBP API calls are made.
 * Tests verify URL construction, pagination, star rating normalisation,
 * error handling, and the path builder contracts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetAccessToken = vi.fn().mockResolvedValue({ token: 'test-access-token' })
  const mockOAuthClient = { getAccessToken: mockGetAccessToken }
  return { mockGetAccessToken, mockOAuthClient }
})

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockOk(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: () => Promise.resolve(body),
  })
}

function mockError(status: number, message: string) {
  mockFetch.mockResolvedValueOnce({
    ok:         false,
    status,
    statusText: 'Error',
    json:       () => Promise.resolve({ error: { message, code: status } }),
  })
}

// ── Path builders ──────────────────────────────────────────────────────────────

describe('path builders', () => {
  it('accountPath returns accounts/{id}', async () => {
    const { accountPath } = await import('@/lib/google/gbp-client')
    expect(accountPath('123456789')).toBe('accounts/123456789')
  })

  it('locationInfoPath returns locations/{id}', async () => {
    const { locationInfoPath } = await import('@/lib/google/gbp-client')
    expect(locationInfoPath('987654321')).toBe('locations/987654321')
  })

  it('reviewsParentPath returns accounts/{a}/locations/{l}', async () => {
    const { reviewsParentPath } = await import('@/lib/google/gbp-client')
    expect(reviewsParentPath('123', '456')).toBe('accounts/123/locations/456')
  })

  it('gbpReviewsSyncKey encodes both IDs', async () => {
    const { gbpReviewsSyncKey } = await import('@/lib/google/gbp-client')
    expect(gbpReviewsSyncKey('123', '456')).toBe('gbp_reviews:123:456')
  })

  it('gbpMetricsSyncKey encodes both IDs', async () => {
    const { gbpMetricsSyncKey } = await import('@/lib/google/gbp-client')
    expect(gbpMetricsSyncKey('123', '456')).toBe('gbp_metrics:123:456')
  })
})

// ── Star rating normalisation ──────────────────────────────────────────────────

describe('normaliseStarRating', () => {
  it.each([
    ['ONE',  1],
    ['TWO',  2],
    ['THREE', 3],
    ['FOUR', 4],
    ['FIVE', 5],
  ])('%s -> %d', async (rating, expected) => {
    const { normaliseStarRating } = await import('@/lib/google/gbp-client')
    expect(normaliseStarRating(rating as 'ONE'|'TWO'|'THREE'|'FOUR'|'FIVE')).toBe(expected)
  })
})

// ── fetchGbpAccounts ───────────────────────────────────────────────────────────

describe('fetchGbpAccounts', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset() })

  it('calls account management API and returns accounts', async () => {
    const { fetchGbpAccounts } = await import('@/lib/google/gbp-client')
    mockOk({ accounts: [{ name: 'accounts/123', accountName: 'Killer Kebab', type: 'LOCATION_GROUP' }] })

    const result = await fetchGbpAccounts(mocks.mockOAuthClient as never)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('accounts/123')
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toContain('mybusinessaccountmanagement.googleapis.com')
    expect(url).toContain('/accounts')
    expect(options.headers['Authorization']).toBe('Bearer test-access-token')
  })

  it('returns empty array when accounts key is absent', async () => {
    const { fetchGbpAccounts } = await import('@/lib/google/gbp-client')
    mockOk({})
    const result = await fetchGbpAccounts(mocks.mockOAuthClient as never)
    expect(result).toEqual([])
  })

  it('throws GbpApiError on non-200 response', async () => {
    const { fetchGbpAccounts, GbpApiError } = await import('@/lib/google/gbp-client')
    mockError(403, 'Access denied')
    await expect(fetchGbpAccounts(mocks.mockOAuthClient as never)).rejects.toBeInstanceOf(GbpApiError)
  })

  it('throws when no access token available', async () => {
    const { fetchGbpAccounts } = await import('@/lib/google/gbp-client')
    mocks.mockGetAccessToken.mockResolvedValueOnce({ token: null })
    await expect(fetchGbpAccounts(mocks.mockOAuthClient as never)).rejects.toThrow('No access token')
  })
})

// ── fetchGbpLocations ──────────────────────────────────────────────────────────

describe('fetchGbpLocations', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset() })

  it('calls business information API with correct account path', async () => {
    const { fetchGbpLocations } = await import('@/lib/google/gbp-client')
    mockOk({ locations: [{ name: 'locations/987', title: 'Killer Kebab Copenhagen' }] })

    const result = await fetchGbpLocations(mocks.mockOAuthClient as never, '123456789')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('locations/987')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('mybusinessbusinessinformation.googleapis.com')
    expect(url).toContain('accounts/123456789/locations')
    expect(url).toContain('readMask')
  })

  it('returns empty array when locations key absent', async () => {
    const { fetchGbpLocations } = await import('@/lib/google/gbp-client')
    mockOk({})
    const result = await fetchGbpLocations(mocks.mockOAuthClient as never, '123')
    expect(result).toEqual([])
  })
})

// ── fetchGbpReviewsPage ────────────────────────────────────────────────────────

describe('fetchGbpReviewsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset() })

  it('calls v4 reviews API with correct parent path', async () => {
    const { fetchGbpReviewsPage } = await import('@/lib/google/gbp-client')
    mockOk({ reviews: [], totalReviewCount: 0 })

    await fetchGbpReviewsPage(mocks.mockOAuthClient as never, '111', '222')
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('mybusiness.googleapis.com/v4')
    expect(url).toContain('accounts/111/locations/222/reviews')
    expect(url).toContain('pageSize=50')
    expect(url).toContain('orderBy=updateTime+desc')
  })

  it('appends pageToken when provided', async () => {
    const { fetchGbpReviewsPage } = await import('@/lib/google/gbp-client')
    mockOk({ reviews: [] })

    await fetchGbpReviewsPage(mocks.mockOAuthClient as never, '111', '222', 'tok_abc')
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('pageToken=tok_abc')
  })

  it('returns nextPageToken when present', async () => {
    const { fetchGbpReviewsPage } = await import('@/lib/google/gbp-client')
    mockOk({ reviews: [], nextPageToken: 'tok_next' })

    const result = await fetchGbpReviewsPage(mocks.mockOAuthClient as never, '111', '222')
    expect(result.nextPageToken).toBe('tok_next')
  })
})

// ── fetchAllGbpReviews — pagination ───────────────────────────────────────────

describe('fetchAllGbpReviews', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset() })

  it('paginates until no nextPageToken', async () => {
    const { fetchAllGbpReviews } = await import('@/lib/google/gbp-client')
    const review1 = { name: 'accounts/1/locations/2/reviews/A', reviewer: {}, starRating: 'FIVE', createTime: '', updateTime: '' }
    const review2 = { name: 'accounts/1/locations/2/reviews/B', reviewer: {}, starRating: 'FOUR', createTime: '', updateTime: '' }

    mockOk({ reviews: [review1], nextPageToken: 'tok1' })
    mockOk({ reviews: [review2] }) // no nextPageToken

    const result = await fetchAllGbpReviews(mocks.mockOAuthClient as never, '1', '2')
    expect(result).toHaveLength(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns empty array when no reviews', async () => {
    const { fetchAllGbpReviews } = await import('@/lib/google/gbp-client')
    mockOk({ reviews: [] })
    const result = await fetchAllGbpReviews(mocks.mockOAuthClient as never, '1', '2')
    expect(result).toEqual([])
  })
})

// ── publishGbpReviewReply ──────────────────────────────────────────────────────

describe('publishGbpReviewReply', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset() })

  it('sends PUT to the review name path with comment body', async () => {
    const { publishGbpReviewReply } = await import('@/lib/google/gbp-client')
    mockOk({})

    const reviewName = 'accounts/111/locations/222/reviews/AbCdEf'
    const result = await publishGbpReviewReply(mocks.mockOAuthClient as never, reviewName, 'Thank you!')

    expect(result).toEqual({ ok: true })
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toContain(`mybusiness.googleapis.com/v4/${reviewName}/reply`)
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body)).toEqual({ comment: 'Thank you!' })
  })

  it('returns ok: false without throwing on API error', async () => {
    const { publishGbpReviewReply } = await import('@/lib/google/gbp-client')
    mockError(404, 'Review not found')

    const result = await publishGbpReviewReply(mocks.mockOAuthClient as never, 'accounts/1/locations/2/reviews/X', 'Hi')
    expect(result).toMatchObject({ ok: false })
    expect((result as { ok: false; error: string }).error).toContain('404')
  })
})
