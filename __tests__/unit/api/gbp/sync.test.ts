/**
 * Tests for app/api/gbp/sync/route.ts
 *
 * Verifies: CRON_SECRET auth, correct HTTP methods, sync user resolution,
 * response status codes (200 / 400 / 401 / 405 / 500).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockRunGbpSync  = vi.fn()
  const mockHasGbpScope = vi.fn()

  const mockFrom = vi.fn()
  const mockServiceClient = { from: mockFrom }

  return { mockRunGbpSync, mockHasGbpScope, mockFrom, mockServiceClient }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/google/auth', () => ({
  hasGbpScope: mocks.mockHasGbpScope,
}))
vi.mock('@/lib/gbp/sync', () => ({
  runGbpSync: mocks.mockRunGbpSync,
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRequest(method: string, authHeader?: string) {
  return new NextRequest('http://localhost/api/gbp/sync', {
    method,
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function setupTokenQuery(rows: { user_id: string; scopes: string[] }[]) {
  mocks.mockFrom.mockReturnValue({
    select: vi.fn().mockResolvedValue({ data: rows, error: null }),
    insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/gbp/sync', () => {
  it('returns 405 Method Not Allowed', async () => {
    const { GET } = await import('@/app/api/gbp/sync/route')
    const res = await GET()
    expect(res.status).toBe(405)
  })
})

describe('POST /api/gbp/sync — auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
  })

  it('returns 401 when Authorization header is missing', async () => {
    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(401)
    expect(mocks.mockRunGbpSync).not.toHaveBeenCalled()
  })

  it('returns 401 when CRON_SECRET does not match', async () => {
    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer wrong-secret'))
    expect(res.status).toBe(401)
    expect(mocks.mockRunGbpSync).not.toHaveBeenCalled()
  })

  it('returns 500 when CRON_SECRET env var is not set', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer any'))
    expect(res.status).toBe(500)
    expect(mocks.mockRunGbpSync).not.toHaveBeenCalled()
  })
})

describe('POST /api/gbp/sync — sync user resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
  })

  it('returns 400 when no GBP-scoped token exists', async () => {
    mocks.mockHasGbpScope.mockReturnValue(false)
    setupTokenQuery([{ user_id: 'user-1', scopes: ['other-scope'] }])

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(400)
    expect(mocks.mockRunGbpSync).not.toHaveBeenCalled()
  })

  it('returns 400 when token table is empty', async () => {
    mocks.mockHasGbpScope.mockReturnValue(false)
    setupTokenQuery([])

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/gbp/sync — sync outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
    mocks.mockHasGbpScope.mockReturnValue(true)
    setupTokenQuery([{ user_id: 'sync-user', scopes: ['https://www.googleapis.com/auth/business.manage'] }])
  })

  it('returns 200 with sync summary when all locations succeed', async () => {
    mocks.mockRunGbpSync.mockResolvedValue({
      totalOk: 2,
      totalFail: 0,
      locations: [
        { storeName: 'CPH', ok: true, reviewsUpserted: 3, draftsGenerated: 1, metricsUpserted: 7 },
        { storeName: 'ARH', ok: true, reviewsUpserted: 1, draftsGenerated: 0, metricsUpserted: 7 },
      ],
    })

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.totalOk).toBe(2)
    expect(body.totalFail).toBe(0)
    expect(body.locations).toHaveLength(2)
    expect(mocks.mockRunGbpSync).toHaveBeenCalledWith('sync-user')
  })

  it('returns 500 when all locations fail', async () => {
    mocks.mockRunGbpSync.mockResolvedValue({
      totalOk: 0,
      totalFail: 1,
      locations: [{ storeName: 'CPH', ok: false, reviewsUpserted: 0, draftsGenerated: 0, metricsUpserted: 0, error: 'API down' }],
    })

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(500)
  })

  it('returns 200 when some locations succeed and some fail', async () => {
    mocks.mockRunGbpSync.mockResolvedValue({
      totalOk: 1,
      totalFail: 1,
      locations: [
        { storeName: 'CPH', ok: true,  reviewsUpserted: 3, draftsGenerated: 0, metricsUpserted: 7 },
        { storeName: 'ARH', ok: false, reviewsUpserted: 0, draftsGenerated: 0, metricsUpserted: 0, error: 'Auth failed' },
      ],
    })

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(200) // partial success → 200

    const body = await res.json()
    expect(body.totalOk).toBe(1)
    expect(body.totalFail).toBe(1)
    expect(body.locations[1].error).toBe('Auth failed')
  })

  it('returns 500 on unexpected exception from runGbpSync', async () => {
    mocks.mockRunGbpSync.mockRejectedValue(new Error('Unexpected crash'))

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(500)
  })

  it('response body includes per-location detail', async () => {
    mocks.mockRunGbpSync.mockResolvedValue({
      totalOk: 1,
      totalFail: 0,
      locations: [
        { storeName: 'CPH', ok: true, reviewsUpserted: 5, draftsGenerated: 2, metricsUpserted: 14 },
      ],
    })

    const { POST } = await import('@/app/api/gbp/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    const body = await res.json()
    const loc = body.locations[0]
    expect(loc.storeName).toBe('CPH')
    expect(loc.reviewsUpserted).toBe(5)
    expect(loc.draftsGenerated).toBe(2)
    expect(loc.metricsUpserted).toBe(14)
    expect(loc.error).toBeUndefined()
  })
})
