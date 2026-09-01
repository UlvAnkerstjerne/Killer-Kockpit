/**
 * Tests for lib/meta/client.ts
 *
 * All tests mock global fetch — no live Meta API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockFetch = vi.fn()
  return { mockFetch }
})

vi.stubGlobal('fetch', mocks.mockFetch)

vi.mock('@/lib/meta/auth', () => ({
  getMetaAuthHeaders: vi.fn().mockReturnValue({ Authorization: 'Bearer test-token' }),
  hasMetaCredentials: vi.fn().mockReturnValue(true),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  mocks.mockFetch.mockResolvedValueOnce({
    ok:      status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => extraHeaders[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  })
}

function mockPaginatedResponse(items: unknown[], nextCursor?: string) {
  mockResponse({
    data:   items,
    paging: nextCursor
      ? { cursors: { after: nextCursor }, next: 'https://graph.facebook.com/next' }
      : { cursors: {} },
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('META_GRAPH_BASE_URL', () => {
  it('contains v26.0', async () => {
    const { META_GRAPH_BASE_URL } = await import('@/lib/meta/api-version')
    expect(META_GRAPH_BASE_URL).toContain('v26.0')
  })
})

describe('fetchAdAccounts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns discovered ad accounts', async () => {
    mockPaginatedResponse([
      { id: 'act_123', name: 'Killer Kebab', currency: 'DKK', account_status: 1 },
    ])
    const { fetchAdAccounts } = await import('@/lib/meta/client')
    const accounts = await fetchAdAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].id).toBe('act_123')
    expect(accounts[0].currency).toBe('DKK')
  })

  it('constructs correct Graph API URL with v26.0', async () => {
    mockPaginatedResponse([])
    const { fetchAdAccounts } = await import('@/lib/meta/client')
    await fetchAdAccounts()
    expect(mocks.mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('v26.0'),
      expect.any(Object),
    )
  })
})

describe('fetchCampaigns', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns campaigns for an ad account', async () => {
    mockPaginatedResponse([
      { id: 'c1', name: 'Summer 2026', status: 'ACTIVE', objective: 'OUTCOME_AWARENESS' },
    ])
    const { fetchCampaigns } = await import('@/lib/meta/client')
    const campaigns = await fetchCampaigns('act_123')
    expect(campaigns).toHaveLength(1)
    expect(campaigns[0].ad_account_id).toBe('act_123')
    expect(campaigns[0].status).toBe('ACTIVE')
  })

  it('returns empty array when no campaigns exist', async () => {
    mockPaginatedResponse([])
    const { fetchCampaigns } = await import('@/lib/meta/client')
    const campaigns = await fetchCampaigns('act_123')
    expect(campaigns).toEqual([])
  })
})

describe('pagination', () => {
  beforeEach(() => vi.clearAllMocks())

  it('follows nextPageToken until exhausted', async () => {
    // Page 1 has a next cursor; page 2 does not
    mockPaginatedResponse(
      [{ id: 'c1', name: 'Camp1', status: 'ACTIVE' }],
      'cursor-after-1',
    )
    mockPaginatedResponse(
      [{ id: 'c2', name: 'Camp2', status: 'PAUSED' }],
    )
    const { fetchCampaigns } = await import('@/lib/meta/client')
    const campaigns = await fetchCampaigns('act_123')
    expect(campaigns).toHaveLength(2)
    expect(mocks.mockFetch).toHaveBeenCalledTimes(2)
  })

  it('stops when no next cursor', async () => {
    mockPaginatedResponse([{ id: 'c1', name: 'Camp1', status: 'ACTIVE' }])
    const { fetchCampaigns } = await import('@/lib/meta/client')
    await fetchCampaigns('act_123')
    expect(mocks.mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('Meta error envelope', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws MetaApiError with code preserved when Meta returns error body', async () => {
    mockResponse({ error: { message: 'Invalid token', code: 190, type: 'OAuthException' } }, 400)
    const { fetchCampaigns, MetaApiError } = await import('@/lib/meta/client')
    await expect(fetchCampaigns('act_123')).rejects.toBeInstanceOf(MetaApiError)
  })

  it('throws MetaApiError on non-ok HTTP status without Meta error body', async () => {
    mockResponse({ message: 'Internal server error' }, 500)
    const { fetchCampaigns, MetaApiError } = await import('@/lib/meta/client')
    await expect(fetchCampaigns('act_123')).rejects.toBeInstanceOf(MetaApiError)
  })
})

describe('rate limit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('throws MetaRateLimitError when usage score >= 75', async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok:   true,
      status: 200,
      headers: {
        get: (name: string) =>
          name === 'x-business-use-case-usage'
            ? JSON.stringify({ act_123: [{ call_count: 80 }] })
            : null,
      },
      json: async () => ({ data: [] }),
    })
    const { fetchCampaigns, MetaRateLimitError } = await import('@/lib/meta/client')
    await expect(fetchCampaigns('act_123')).rejects.toBeInstanceOf(MetaRateLimitError)
  })

  it('does not throw when usage score < 75', async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok:   true,
      status: 200,
      headers: {
        get: (name: string) =>
          name === 'x-business-use-case-usage'
            ? JSON.stringify({ act_123: [{ call_count: 50 }] })
            : null,
      },
      json: async () => ({ data: [] }),
    })
    const { fetchCampaigns } = await import('@/lib/meta/client')
    await expect(fetchCampaigns('act_123')).resolves.toEqual([])
  })
})

describe('fetchAdInsights spend decimal handling', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns spend as the exact string from Meta (no float conversion)', async () => {
    mockPaginatedResponse([
      {
        ad_id: 'a1', date_start: '2026-08-01',
        impressions: '1000', reach: '800', clicks: '50',
        spend: '3.14',   // exact decimal string from Meta
        cpm: '3.14', cpc: '0.06', ctr: '0.05',
      },
    ])
    const { fetchAdInsights } = await import('@/lib/meta/client')
    const rows = await fetchAdInsights('act_123', '2026-08-01', '2026-08-01')
    expect(rows[0].spend).toBe('3.14')     // must remain a string, not a float
    expect(rows[0].impressions).toBe('1000')
  })
})

describe('fetchCampaignInsights', () => {
  afterEach(() => vi.clearAllMocks())

  it('includes frequency field (campaign-level only)', async () => {
    mockPaginatedResponse([
      {
        campaign_id: 'c1', date_start: '2026-08-01',
        impressions: '5000', reach: '2000', frequency: '2.5',
        spend: '100.00', cpm: '20.00', cpc: '2.00', ctr: '0.01',
      },
    ])
    const { fetchCampaignInsights } = await import('@/lib/meta/client')
    const rows = await fetchCampaignInsights('act_123', '2026-08-01', '2026-08-01')
    expect(rows[0].frequency).toBe('2.5')
    expect(rows[0].campaign_id).toBe('c1')
  })
})

describe('auth failure', () => {
  afterEach(() => vi.clearAllMocks())

  it('throws MetaApiError when getMetaAuthHeaders returns null', async () => {
    const authModule = await import('@/lib/meta/auth')
    vi.spyOn(authModule, 'getMetaAuthHeaders').mockReturnValueOnce(null)
    const { fetchCampaigns, MetaApiError } = await import('@/lib/meta/client')
    await expect(fetchCampaigns('act_123')).rejects.toBeInstanceOf(MetaApiError)
  })
})
