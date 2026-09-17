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

// Current Performance API contracts and error safety.
describe('GBP data foundation API contracts', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset() })
  it('uses the location-only path, repeated metric parameters and nested response envelope', async () => {
    const { fetchLocationMetrics } = await import('@/lib/google/gbp-client')
    const series = { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [] } }
    mockOk({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [series] }] })
    expect(await fetchLocationMetrics(mocks.mockOAuthClient as never, '1', '2', '2026-09-01', '2026-09-02')).toEqual([series])
    const url = new URL(mockFetch.mock.calls[0][0])
    expect(url.pathname).toBe('/v1/locations/2:fetchMultiDailyMetricsTimeSeries')
    expect(url.searchParams.getAll('dailyMetrics')).toHaveLength(11)
    expect(url.searchParams.getAll('dailyMetrics')).toContain('BUSINESS_FOOD_MENU_CLICKS')
    expect(url.searchParams.get('dailyRange.end_date.day')).toBe('2')
  })
  it('fails visibly on a malformed performance envelope', async () => {
    const { fetchLocationMetrics } = await import('@/lib/google/gbp-client')
    mockOk({}); await expect(fetchLocationMetrics(mocks.mockOAuthClient as never, '1', '2', '2026-09-01', '2026-09-02')).rejects.toThrow('MISSING_METRIC_SERIES')
  })
  it('paginates account and profile discovery and requests profile/status fields', async () => {
    const { fetchGbpAccounts, fetchGbpLocations } = await import('@/lib/google/gbp-client')
    mockOk({ accounts: [{ name: 'accounts/1' }], nextPageToken: 'two' }); mockOk({ accounts: [{ name: 'accounts/2' }] })
    expect(await fetchGbpAccounts(mocks.mockOAuthClient as never)).toHaveLength(2)
    mockOk({ locations: [{ name: 'locations/1' }], nextPageToken: 'next' }); mockOk({ locations: [{ name: 'locations/2' }] })
    expect(await fetchGbpLocations(mocks.mockOAuthClient as never, '1')).toHaveLength(2)
    const url = new URL(mockFetch.mock.calls[2][0]); expect(url.searchParams.get('readMask')).toContain('regularHours,specialHours'); expect(url.searchParams.get('readMask')).toContain('openInfo,metadata')
  })
  it('fetches monthly keywords one month at a time and exhausts pagination', async () => {
    const { fetchGbpSearchKeywords } = await import('@/lib/google/gbp-client')
    mockOk({ searchKeywordsCounts: [{ searchKeyword: 'kebab', insightsValue: { threshold: '15' } }], nextPageToken: 'two' })
    mockOk({ searchKeywordsCounts: [{ searchKeyword: 'killer', insightsValue: { value: '120' } }] })
    const rows = await fetchGbpSearchKeywords(mocks.mockOAuthClient as never, '2', '2026-08-01')
    expect(rows).toHaveLength(2); expect(rows[0].insightsValue).toEqual({ threshold: '15' })
    const url = new URL(mockFetch.mock.calls[0][0]); expect(url.pathname).toBe('/v1/locations/2/searchkeywords/impressions/monthly')
    expect(url.searchParams.get('monthlyRange.start_month.month')).toBe('8'); expect(url.searchParams.get('monthlyRange.end_month.month')).toBe('8')
  })
  it('rejects repeated page tokens and errors after a successful first page', async () => {
    const { fetchGbpSearchKeywords } = await import('@/lib/google/gbp-client')
    mockOk({ nextPageToken: 'same' }); mockOk({ nextPageToken: 'same' })
    await expect(fetchGbpSearchKeywords(mocks.mockOAuthClient as never, '2', '2026-08-01')).rejects.toThrow('PAGINATION_INCOMPLETE')
    mockOk({ searchKeywordsCounts: [{ searchKeyword: 'x' }], nextPageToken: 'two' }); mockError(403, 'private-provider-message')
    await expect(fetchGbpSearchKeywords(mocks.mockOAuthClient as never, '2', '2026-08-01')).rejects.toThrow('GBP API 403')
  })
  it('never returns OAuth error strings, Google messages, query tokens or credentials', async () => {
    const { fetchGbpAccounts, fetchGbpReviewsPage } = await import('@/lib/google/gbp-client')
    mocks.mockGetAccessToken.mockRejectedValueOnce(new Error('refresh_token=private-oauth-token'))
    await expect(fetchGbpAccounts(mocks.mockOAuthClient as never)).rejects.toThrow('OAUTH_REFRESH_FAILED')
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: 'Bearer private-token', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }) })
    const error = await fetchGbpReviewsPage(mocks.mockOAuthClient as never, '1', '2', 'private-page-token').catch(e => e)
    expect(error.message).toContain('ACCESS_TOKEN_SCOPE_INSUFFICIENT'); expect(error.message).not.toContain('private'); expect(error.message).not.toContain('Bearer')
  })
  it('handles Google omitting the empty reviews collection without changing reply calls', async () => {
    const { fetchGbpReviewsPage } = await import('@/lib/google/gbp-client')
    mockOk({ totalReviewCount: 0 }); expect((await fetchGbpReviewsPage(mocks.mockOAuthClient as never, '1', '2')).reviews).toEqual([])
  })
})
