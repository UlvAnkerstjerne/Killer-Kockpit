/**
 * Tests for lib/gsc/sync.ts
 *
 * Key behaviour under test:
 * - Zero rows from the GSC API must NOT advance the cursor or set last_success_at
 * - Zero rows must set status='failed' and populate last_error
 * - Zero rows must set ok=false on the result
 * - Rows written successfully must advance cursor and set status='synced'
 * - Hard API errors are still caught and recorded as failures
 * - No credential found returns early with ok=false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // GSC searchanalytics.query mock — returns { data: { rows: [] } } by default
  const mockSearchanalyticsQuery = vi.fn().mockResolvedValue({ data: { rows: [] } })
  const mockWebmasters = vi.fn().mockReturnValue({
    searchanalytics: { query: mockSearchanalyticsQuery },
  })

  // OAuth client mock
  const mockGetGoogleOAuth2Client = vi.fn().mockResolvedValue({})
  const mockHasSearchConsoleScope = vi.fn().mockReturnValue(true)

  // Sync state: tracks calls made to upsertInstitutionalSyncState indirectly
  // via db.from('integration_sync_state').update/insert
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
    mockSearchanalyticsQuery,
    mockWebmasters,
    mockGetGoogleOAuth2Client,
    mockHasSearchConsoleScope,
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
    webmasters: mocks.mockWebmasters,
    auth: { OAuth2: vi.fn() },
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.mockCreateServiceClient,
}))

vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client:   mocks.mockGetGoogleOAuth2Client,
  hasSearchConsoleScope:   mocks.mockHasSearchConsoleScope,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all patches passed to db.from('integration_sync_state').update() */
function capturedUpdatePatches(): Array<Record<string, unknown>> {
  return mocks.mockUpdate.mock.calls.map(([patch]) => patch as Record<string, unknown>)
}

/** Collect all rows passed to db.from('integration_sync_state').insert() */
function capturedInsertRows(): Array<Record<string, unknown>> {
  return mocks.mockInsert.mock.calls.map(([row]) => row as Record<string, unknown>)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('runGscSync — credential resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mocks.mockHasSearchConsoleScope.mockReturnValue(true)
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockSearchanalyticsQuery.mockResolvedValue({ data: { rows: [] } })
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
    // google_oauth_tokens returns no rows → no credential
    mocks.mockSelect.mockReturnValueOnce({
      eq: mocks.mockEq, is: mocks.mockIs,
      // For the findCredentialUserId path: returns data:null
      data: null,
      error: null,
    })
  })

  it('returns ok=false when no user with webmasters scope is found', async () => {
    // google_oauth_tokens select returns empty
    mocks.mockFrom.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
      update: mocks.mockUpdate,
      insert: mocks.mockInsert,
      upsert: mocks.mockUpsert,
    })

    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/webmasters\.readonly/)
    expect(mocks.mockSearchanalyticsQuery).not.toHaveBeenCalled()
  })
})

describe('runGscSync — zero-row response handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    // GSC API returns zero rows for all three queries
    mocks.mockSearchanalyticsQuery.mockResolvedValue({ data: { rows: [] } })
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockHasSearchConsoleScope.mockReturnValue(true)

    // DB update/insert for sync state
    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
    mocks.mockUpdate.mockReturnValue({ eq: mockUpdateEq })
    mocks.mockInsert.mockResolvedValue({ error: null })
    mocks.mockUpsert.mockResolvedValue({ error: null })

    // integration_sync_state: no prior row (triggers insert path in upsertInstitutionalSyncState)
    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockIs.mockReturnValue({ maybeSingle: mocks.mockMaybeSingle })
    mocks.mockEq.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })
    mocks.mockSelect.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })

    // google_oauth_tokens: return a user with webmasters scope
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'google_oauth_tokens') {
        return {
          select: vi.fn().mockResolvedValue({
            data: [{ user_id: 'user-123', scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }],
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
  })

  it('returns ok=false when all three datasets return zero rows', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    expect(result.ok).toBe(false)
    expect(result.dailyRows).toBe(0)
    expect(result.queryRows).toBe(0)
    expect(result.pageRows).toBe(0)
  })

  it('includes three errors (one per dataset) when all return zero rows', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toMatch(/gsc_daily/)
    expect(result.errors[1]).toMatch(/gsc_queries/)
    expect(result.errors[2]).toMatch(/gsc_pages/)
  })

  it('error messages reference zero rows and the site URL', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    for (const err of result.errors) {
      expect(err).toMatch(/Zero rows returned/)
      expect(err).toMatch(/killerkebab\.com/)
    }
  })

  it('does not advance the cursor when zero rows returned', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    await runGscSync()

    // All insert/update calls to integration_sync_state should not include cursor or last_success_at
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
    const { runGscSync } = await import('@/lib/gsc/sync')
    await runGscSync()

    const insertedRows = capturedInsertRows()
    // At minimum one insert per dataset (since no prior state)
    const statusValues = insertedRows.map((r) => r.status)
    expect(statusValues.every((s) => s !== 'synced')).toBe(true)
    expect(statusValues.some((s) => s === 'failed')).toBe(true)
  })
})

describe('runGscSync — successful sync with rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockHasSearchConsoleScope.mockReturnValue(true)
    mocks.mockUpsert.mockResolvedValue({ error: null })

    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
    mocks.mockUpdate.mockReturnValue({ eq: mockUpdateEq })
    mocks.mockInsert.mockResolvedValue({ error: null })

    mocks.mockMaybeSingle.mockResolvedValue({ data: null })
    mocks.mockIs.mockReturnValue({ maybeSingle: mocks.mockMaybeSingle })
    mocks.mockEq.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })
    mocks.mockSelect.mockReturnValue({ eq: mocks.mockEq, is: mocks.mockIs, maybeSingle: mocks.mockMaybeSingle })

    // Return appropriate rows for each of the three API queries in order:
    // 1. gsc_daily: keys=['date']
    // 2. gsc_queries: keys=['date','query']
    // 3. gsc_pages: keys=['date','page']
    mocks.mockSearchanalyticsQuery
      .mockResolvedValueOnce({
        data: { rows: [{ keys: ['2026-09-18'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 }] },
      })
      .mockResolvedValueOnce({
        data: { rows: [{ keys: ['2026-09-18', 'killer kebab'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 }] },
      })
      .mockResolvedValueOnce({
        data: { rows: [{ keys: ['2026-09-18', 'https://killerkebab.com/'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 }] },
      })

    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'google_oauth_tokens') {
        return {
          select: vi.fn().mockResolvedValue({
            data: [{ user_id: 'user-123', scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }],
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
  })

  it('returns ok=true when all three datasets write rows', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns correct row counts', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    expect(result.dailyRows).toBe(1)
    expect(result.queryRows).toBe(1)
    expect(result.pageRows).toBe(1)
  })

  it('writes status=synced and advances cursor when rows are present', async () => {
    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    const insertedRows = capturedInsertRows()
    const syncedRows = insertedRows.filter((r) => r.status === 'synced')

    // Expect three datasets to be marked synced
    expect(syncedRows.length).toBeGreaterThanOrEqual(3)

    // Each synced row must have cursor and last_success_at
    for (const row of syncedRows) {
      expect(row.cursor).toBe(result.dateRange.end)
      expect(row.last_success_at).toBeTruthy()
    }
  })
})

describe('runGscSync — API error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})
    mocks.mockHasSearchConsoleScope.mockReturnValue(true)
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
            data: [{ user_id: 'user-123', scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }],
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
  })

  it('captures API errors without throwing and returns ok=false', async () => {
    mocks.mockSearchanalyticsQuery.mockRejectedValue(new Error('GSC API unavailable'))

    const { runGscSync } = await import('@/lib/gsc/sync')
    const result = await runGscSync()

    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('GSC API unavailable'))).toBe(true)
  })
})
