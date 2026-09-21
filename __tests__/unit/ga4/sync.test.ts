/**
 * Tests for lib/ga4/sync.ts
 *
 * Key behaviour under test:
 * - Zero rows from the GA4 API must NOT advance the cursor or set last_success_at
 * - Zero rows must set status='failed' and populate last_error
 * - Zero rows must set ok=false on the result
 * - Rows written successfully must advance cursor and set status='synced'
 * - Hard API errors are still caught and recorded as failures
 * - No credential found returns early with ok=false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // GA4 Data API runReport mock — returns empty rows by default
  const mockRunReport = vi.fn().mockResolvedValue({
    data: { rows: [], metricHeaders: [], dimensionHeaders: [] },
  })
  const mockProperties   = { runReport: mockRunReport }
  const mockAnalyticsdata = vi.fn().mockReturnValue({ properties: mockProperties })

  // OAuth client mock
  const mockGetGoogleOAuth2Client = vi.fn().mockResolvedValue({})
  const mockHasGA4Scope           = vi.fn().mockReturnValue(true)

  // Supabase mocks
  const mockUpdate      = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
  const mockInsert      = vi.fn().mockResolvedValue({ error: null })
  const mockUpsert      = vi.fn().mockResolvedValue({ error: null })
  const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null })
  const mockIs          = vi.fn()
  const mockEq          = vi.fn()

  mockEq.mockReturnValue({ eq: mockEq, is: mockIs, maybeSingle: mockMaybeSingle })
  mockIs.mockReturnValue({ maybeSingle: mockMaybeSingle })

  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq, is: mockIs, maybeSingle: mockMaybeSingle })
  const mockFrom   = vi.fn().mockReturnValue({
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
    upsert: mockUpsert,
  })

  const mockCreateServiceClient = vi.fn().mockReturnValue({ from: mockFrom })

  return {
    mockRunReport,
    mockAnalyticsdata,
    mockGetGoogleOAuth2Client,
    mockHasGA4Scope,
    mockFrom,
    mockSelect,
    mockEq,
    mockIs,
    mockMaybeSingle,
    mockUpdate,
    mockInsert,
    mockUpsert,
    mockCreateServiceClient,
  }
})

vi.mock('googleapis', () => ({
  google: {
    analyticsdata: mocks.mockAnalyticsdata,
    auth: { OAuth2: vi.fn() },
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.mockCreateServiceClient,
}))

vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client: mocks.mockGetGoogleOAuth2Client,
  hasGA4Scope:           mocks.mockHasGA4Scope,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function capturedUpdatePatches(): Array<Record<string, unknown>> {
  return mocks.mockUpdate.mock.calls.map(([patch]) => patch as Record<string, unknown>)
}

function capturedInsertRows(): Array<Record<string, unknown>> {
  return mocks.mockInsert.mock.calls.map(([row]) => row as Record<string, unknown>)
}

function makeGA4DailyRow(dateYYYYMMDD: string) {
  return {
    dimensionValues: [{ value: dateYYYYMMDD }],
    metricValues:    [{ value: '10' }, { value: '8' }, { value: '5' }, { value: '20' }],
  }
}

function makeGA4SourceRow(dateYYYYMMDD: string) {
  return {
    dimensionValues: [{ value: dateYYYYMMDD }, { value: 'google' }, { value: 'organic' }],
    metricValues:    [{ value: '10' }, { value: '8' }, { value: '5' }],
  }
}

function makeGA4PageRow(dateYYYYMMDD: string) {
  return {
    dimensionValues: [{ value: dateYYYYMMDD }, { value: '/' }],
    metricValues:    [{ value: '10' }, { value: '8' }, { value: '5' }],
  }
}

const dailyHeaders = [
  { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'screenPageViews' },
]

const shortHeaders = [
  { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
]

function setupWithCredential() {
  vi.clearAllMocks()
  vi.resetModules()

  mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
  mocks.mockHasGA4Scope.mockReturnValue(true)
  mocks.mockUpsert.mockResolvedValue({ error: null })

  const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
  mocks.mockUpdate.mockReturnValue({ eq: mockUpdateEq })
  mocks.mockInsert.mockResolvedValue({ error: null })

  mocks.mockMaybeSingle.mockResolvedValue({ data: null })
  mocks.mockIs.mockReturnValue({ maybeSingle: mocks.mockMaybeSingle })
  mocks.mockEq.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })
  mocks.mockSelect.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })

  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'google_oauth_tokens') {
      return {
        select: vi.fn().mockResolvedValue({
          data: [{ user_id: 'user-123', scopes: ['https://www.googleapis.com/auth/analytics.readonly'] }],
          error: null,
        }),
      }
    }
    return {
      select: mocks.mockSelect,
      update: mocks.mockUpdate,
      insert: mocks.mockInsert,
      upsert: mocks.mockUpsert,
    }
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('runGA4Sync — credential resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockHasGA4Scope.mockReturnValue(true)
    mocks.mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    mocks.mockInsert.mockResolvedValue({ error: null })
    mocks.mockUpsert.mockResolvedValue({ error: null })
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockEq.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })
    mocks.mockIs.mockReturnValue({ maybeSingle: mocks.mockMaybeSingle })
    mocks.mockSelect.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })
    mocks.mockFrom.mockReturnValue({
      select: mocks.mockSelect,
      update: mocks.mockUpdate,
      insert: mocks.mockInsert,
      upsert: mocks.mockUpsert,
    })
  })

  it('returns ok=false when no user with analytics.readonly scope is found', async () => {
    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
      update: mocks.mockUpdate,
      insert: mocks.mockInsert,
      upsert: mocks.mockUpsert,
    })

    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/analytics\.readonly/)
    expect(mocks.mockRunReport).not.toHaveBeenCalled()
  })
})

describe('runGA4Sync — zero-row response handling', () => {
  beforeEach(() => {
    setupWithCredential()
    mocks.mockRunReport.mockResolvedValue({
      data: { rows: [], metricHeaders: dailyHeaders, dimensionHeaders: [] },
    })
  })

  it('returns ok=false when all three datasets return zero rows', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    expect(result.ok).toBe(false)
    expect(result.dailyRows).toBe(0)
    expect(result.sourceRows).toBe(0)
    expect(result.pageRows).toBe(0)
  })

  it('includes three errors (one per dataset) when all return zero rows', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toMatch(/ga4_daily/)
    expect(result.errors[1]).toMatch(/ga4_traffic_sources/)
    expect(result.errors[2]).toMatch(/ga4_landing_pages/)
  })

  it('error messages reference zero rows and the property ID', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    for (const err of result.errors) {
      expect(err).toMatch(/Zero rows returned/)
      expect(err).toMatch(/333149501/)
    }
  })

  it('does not advance the cursor when zero rows returned', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    await runGA4Sync()

    const insertedRows = capturedInsertRows()
    for (const row of insertedRows) {
      expect(row.cursor).toBeUndefined()
      expect(row.last_success_at).toBeUndefined()
    }

    const updatedPatches = capturedUpdatePatches()
    for (const patch of updatedPatches) {
      expect(patch.cursor).toBeUndefined()
      expect(patch.last_success_at).toBeUndefined()
    }
  })

  it('writes status=failed (not synced) when zero rows returned', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    await runGA4Sync()

    const insertedRows = capturedInsertRows()
    const statusValues = insertedRows.map((r) => r.status)
    expect(statusValues.every((s) => s !== 'synced')).toBe(true)
    expect(statusValues.some((s) => s === 'failed')).toBe(true)
  })
})

describe('runGA4Sync — successful sync with rows', () => {
  beforeEach(() => {
    setupWithCredential()

    mocks.mockRunReport
      .mockResolvedValueOnce({
        data: { rows: [makeGA4DailyRow('20260918')], metricHeaders: dailyHeaders },
      })
      .mockResolvedValueOnce({
        data: { rows: [makeGA4SourceRow('20260918')], metricHeaders: shortHeaders },
      })
      .mockResolvedValueOnce({
        data: { rows: [makeGA4PageRow('20260918')], metricHeaders: shortHeaders },
      })
  })

  it('returns ok=true when all three datasets write rows', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns correct row counts', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    expect(result.dailyRows).toBe(1)
    expect(result.sourceRows).toBe(1)
    expect(result.pageRows).toBe(1)
  })

  it('writes status=synced and advances cursor when rows are present', async () => {
    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    const insertedRows = capturedInsertRows()
    const syncedRows   = insertedRows.filter((r) => r.status === 'synced')

    expect(syncedRows.length).toBeGreaterThanOrEqual(3)

    for (const row of syncedRows) {
      expect(row.cursor).toBe(result.dateRange.end)
      expect(row.last_success_at).toBeTruthy()
    }
  })
})

describe('runGA4Sync — API error handling', () => {
  beforeEach(() => {
    setupWithCredential()
  })

  it('captures API errors without throwing and returns ok=false', async () => {
    mocks.mockRunReport.mockRejectedValue(new Error('GA4 API unavailable'))

    const { runGA4Sync } = await import('@/lib/ga4/sync')
    const result = await runGA4Sync()

    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('GA4 API unavailable'))).toBe(true)
  })
})
