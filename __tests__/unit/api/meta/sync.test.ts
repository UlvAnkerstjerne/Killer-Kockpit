/**
 * Tests for app/api/meta/sync/route.ts
 *
 * Verifies: CRON_SECRET auth, correct HTTP methods, sync outcomes,
 * response status codes (200 / 401 / 405 / 500).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockRunMetaSync = vi.fn()
  return { mockRunMetaSync }
})

vi.mock('@/lib/meta/sync', () => ({
  runMetaSync: mocks.mockRunMetaSync,
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRequest(method: string, authHeader?: string) {
  return new NextRequest('http://localhost/api/meta/sync', {
    method,
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/meta/sync', () => {
  it('returns 405 Method Not Allowed', async () => {
    const { GET } = await import('@/app/api/meta/sync/route')
    const res = await GET()
    expect(res.status).toBe(405)
  })
})

describe('POST /api/meta/sync — auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
  })

  it('returns 500 when CRON_SECRET env var is not set', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer any'))
    expect(res.status).toBe(500)
    expect(mocks.mockRunMetaSync).not.toHaveBeenCalled()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(401)
    expect(mocks.mockRunMetaSync).not.toHaveBeenCalled()
  })

  it('returns 401 when Bearer token does not match CRON_SECRET', async () => {
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer wrong-secret'))
    expect(res.status).toBe(401)
    expect(mocks.mockRunMetaSync).not.toHaveBeenCalled()
  })
})

describe('POST /api/meta/sync — sync outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
  })

  it('returns 200 with ok:true when sync succeeds', async () => {
    mocks.mockRunMetaSync.mockResolvedValue({
      ok: true, errors: [], summary: 'Meta sync complete.',
    })
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.summary).toBe('Meta sync complete.')
    expect(body.errors).toBeUndefined()
  })

  it('returns 200 with errors array when sections partially fail', async () => {
    mocks.mockRunMetaSync.mockResolvedValue({
      ok: false,
      errors: ['Paid daily sync failed: Network error'],
      summary: 'Meta sync completed with 1 error(s).',
    })
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(200)   // partial failure → still 200
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.errors).toContain('Paid daily sync failed: Network error')
  })

  it('returns 500 when sync reports credentials not configured', async () => {
    mocks.mockRunMetaSync.mockResolvedValue({
      ok: false,
      errors: ['META_SYSTEM_USER_TOKEN not configured'],
      summary: 'Meta credentials missing.',
    })
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(500)
  })

  it('returns 500 when sync reports ad account not configured', async () => {
    mocks.mockRunMetaSync.mockResolvedValue({
      ok: false,
      errors: ['META_AD_ACCOUNT_ID not configured'],
      summary: 'Run discoverMetaAssets().',
    })
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(500)
  })

  it('returns 500 on unexpected exception from runMetaSync', async () => {
    mocks.mockRunMetaSync.mockRejectedValue(new Error('Unexpected crash'))
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/unexpected/i)
  })

  it('does not include errors key in body when no errors', async () => {
    mocks.mockRunMetaSync.mockResolvedValue({
      ok: true, errors: [], summary: 'Meta sync complete.',
    })
    const { POST } = await import('@/app/api/meta/sync/route')
    const res = await POST(makeRequest('POST', 'Bearer test-cron-secret'))
    const body = await res.json()
    expect(Object.keys(body)).not.toContain('errors')
  })
})
