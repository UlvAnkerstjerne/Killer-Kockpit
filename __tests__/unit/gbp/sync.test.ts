/**
 * Tests for lib/gbp/sync.ts
 *
 * All DB interactions and external API calls are mocked.
 * Tests verify: first-run vs incremental branching, activation window logic,
 * error isolation per location, metrics upsert, retryDraftForReview.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetGoogleOAuth2Client = vi.fn().mockResolvedValue({})
  const mockFetchAllGbpReviews    = vi.fn().mockResolvedValue([])
  const mockFetchGbpReviewsPage   = vi.fn().mockResolvedValue({ reviews: [], nextPageToken: undefined })
  const mockFetchLocationMetrics  = vi.fn().mockResolvedValue([])
  const mockNormaliseStarRating   = vi.fn().mockImplementation((r: string) =>
    ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[r] ?? 0)
  )
  const mockGbpReviewsSyncKey = vi.fn().mockImplementation((a: string, l: string) => `gbp_reviews:${a}:${l}`)
  const mockGbpMetricsSyncKey = vi.fn().mockImplementation((a: string, l: string) => `gbp_metrics:${a}:${l}`)
  const mockDraftReviewReply  = vi.fn()
  const mockFrom              = vi.fn()
  const mockServiceClient     = { from: mockFrom }

  return {
    mockGetGoogleOAuth2Client,
    mockFetchAllGbpReviews, mockFetchGbpReviewsPage, mockFetchLocationMetrics,
    mockNormaliseStarRating, mockGbpReviewsSyncKey, mockGbpMetricsSyncKey,
    mockDraftReviewReply,
    mockFrom, mockServiceClient,
  }
})

vi.mock('@/lib/supabase/server',   () => ({ createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient) }))
vi.mock('@/lib/google/auth',       () => ({ getGoogleOAuth2Client: mocks.mockGetGoogleOAuth2Client }))
vi.mock('@/lib/google/gbp-client', () => ({
  fetchAllGbpReviews:   mocks.mockFetchAllGbpReviews,
  fetchGbpReviewsPage:  mocks.mockFetchGbpReviewsPage,
  fetchLocationMetrics: mocks.mockFetchLocationMetrics,
  normaliseStarRating:  mocks.mockNormaliseStarRating,
  gbpReviewsSyncKey:    mocks.mockGbpReviewsSyncKey,
  gbpMetricsSyncKey:    mocks.mockGbpMetricsSyncKey,
}))
vi.mock('@/lib/ai/draft-review-reply', () => ({ draftReviewReply: mocks.mockDraftReviewReply }))
vi.mock('@/lib/marketing/gbp/brand-context', () => ({ KILLER_KEBAB_REVIEW_REPLY_CONTEXT: 'Be warm.' }))

// ── DB mock helpers ────────────────────────────────────────────────────────────
//
// `mkChain(resp)` produces a Promise-based chain that also supports:
//   .eq()     → returns itself (chainable + directly awaitable as `{data, error}`)
//   .single() → resolves to `resp`
//   .order()  → resolves to `resp`
//
// This mirrors the Supabase PostgrestFilterBuilder which is itself a PromiseLike.

type Chain = Promise<unknown> & {
  single: ReturnType<typeof vi.fn>
  eq:     ReturnType<typeof vi.fn>
  order:  ReturnType<typeof vi.fn>
  like:   ReturnType<typeof vi.fn>
}

function mkChain(resp: { data: unknown; error: unknown }): Chain {
  // Attach chainable methods to a real Promise so `await chain` resolves to resp
  // and chain.eq().order() etc. also work.
  const p = Object.assign(Promise.resolve(resp), {
    single: vi.fn().mockResolvedValue(resp),
    eq:     vi.fn(),
    order:  vi.fn().mockResolvedValue(resp),
    like:   vi.fn(),
  }) as Chain
  // Self-referential: eq() returns the same chain (supports double-eq chains)
  p.eq.mockReturnValue(p)
  p.like.mockReturnValue({ order: vi.fn().mockResolvedValue(resp) })
  return p
}

function mkFrom(resp: { data: unknown; error: unknown }) {
  return {
    select: vi.fn().mockReturnValue(mkChain(resp)),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    insert: vi.fn().mockResolvedValue({ error: null }),
  }
}

// Enqueue a sequence of responses. Each call to `from()` gets the next one.
function setupFromQueue(responses: Array<{ data: unknown; error: unknown }>) {
  const queue = [...responses]
  mocks.mockFrom.mockImplementation(() => {
    const resp = queue.shift() ?? { data: null, error: null }
    return mkFrom(resp)
  })
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const DB_LOCATION = {
  id:                  'loc-uuid',
  google_account_id:   '123',
  google_location_id:  '999',
  store_name:          'Killer Kebab CPH',
  store_short_name:    'CPH',
  activation_date:     '2024-01-01',
}

function makeReview(overrides: Partial<{
  name: string; comment: string | null; starRating: string;
  createTime: string; updateTime: string
  reviewer: { displayName: string }; reviewReply: unknown
}> = {}) {
  return {
    name:        'accounts/123/locations/999/reviews/RevA',
    reviewer:    { displayName: 'Alice' },
    starRating:  'FIVE' as const,
    createTime:  '2024-06-01T10:00:00Z',
    updateTime:  '2024-06-01T10:00:00Z',
    comment:     'Great food!',
    reviewReply: null,
    ...overrides,
  }
}

// Standard response set for "first-run, no reviews" — just enough for runGbpSync to complete
function noReviewsFirstRunQueue() {
  return [
    { data: [DB_LOCATION], error: null },   // gbp_locations select
    { data: null, error: null },              // integration_sync_state upsert (reviews syncing)
    { data: null, error: null },              // integration_sync_state upsert (metrics syncing)
    { data: null, error: null },              // getSyncState reviews → not_started
    { data: null, error: null },              // integration_sync_state upsert (reviews synced)
    { data: null, error: null },              // getSyncState metrics → not_started
    { data: null, error: null },              // integration_sync_state upsert (metrics synced)
  ]
}

// ── No locations ───────────────────────────────────────────────────────────────

describe('runGbpSync — no locations', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns empty result when no active locations exist', async () => {
    setupFromQueue([{ data: [], error: null }])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    const result = await runGbpSync('sync-user-id')

    expect(result.locations).toEqual([])
    expect(result.totalOk).toBe(0)
    expect(result.totalFail).toBe(0)
    expect(mocks.mockGetGoogleOAuth2Client).not.toHaveBeenCalled()
  })

  it('returns empty result when locations query returns null', async () => {
    setupFromQueue([{ data: null, error: null }])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    const result = await runGbpSync('sync-user-id')

    expect(result.locations).toHaveLength(0)
  })
})

// ── First-run vs incremental ───────────────────────────────────────────────────

describe('first-run vs incremental sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockDraftReviewReply.mockResolvedValue({ ok: false, error: 'no key' })
    mocks.mockFetchAllGbpReviews.mockResolvedValue([])
    mocks.mockFetchGbpReviewsPage.mockResolvedValue({ reviews: [] })
    mocks.mockFetchLocationMetrics.mockResolvedValue([])
  })

  it('calls fetchAllGbpReviews on first run (sync state not_started)', async () => {
    setupFromQueue(noReviewsFirstRunQueue())

    const { runGbpSync } = await import('@/lib/gbp/sync')
    await runGbpSync('sync-user-id')

    expect(mocks.mockFetchAllGbpReviews).toHaveBeenCalledOnce()
    expect(mocks.mockFetchGbpReviewsPage).not.toHaveBeenCalled()
  })

  it('calls fetchGbpReviewsPage on incremental run (sync state synced)', async () => {
    const syncedState = { status: 'synced', cursor: '2024-01-02', last_success_at: '2024-01-02' }
    setupFromQueue([
      { data: [DB_LOCATION], error: null },      // gbp_locations
      { data: null, error: null },                // upsert syncing (reviews)
      { data: null, error: null },                // upsert syncing (metrics)
      { data: syncedState, error: null },          // getSyncState reviews → synced
      { data: null, error: null },                // upsert synced (reviews)
      { data: null, error: null },                // getSyncState metrics → not_started
      { data: null, error: null },                // upsert synced (metrics)
    ])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    await runGbpSync('sync-user-id')

    expect(mocks.mockFetchGbpReviewsPage).toHaveBeenCalledOnce()
    expect(mocks.mockFetchAllGbpReviews).not.toHaveBeenCalled()
  })
})

// ── Activation window ──────────────────────────────────────────────────────────

describe('activation window logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockFetchLocationMetrics.mockResolvedValue([])
  })

  it('generates a draft for reviews within the activation window (< 7 days before activation_date)', async () => {
    const review = makeReview({ createTime: '2023-12-28T10:00:00Z' }) // 4 days before 2024-01-01
    const location = { ...DB_LOCATION, activation_date: '2024-01-01' }

    mocks.mockFetchAllGbpReviews.mockResolvedValueOnce([review])
    mocks.mockDraftReviewReply.mockResolvedValueOnce({ ok: true, draft: 'Thanks!', model: 'claude-sonnet-4-6', promptVersion: 'v1' })

    setupFromQueue([
      { data: [location], error: null },              // gbp_locations
      { data: null, error: null },                    // upsert syncing (reviews)
      { data: null, error: null },                    // upsert syncing (metrics)
      { data: null, error: null },                    // getSyncState reviews → not_started
      { data: null, error: null },                    // gbp_reviews existing check → null (new)
      { data: null, error: null },                    // gbp_reviews upsert
      { data: { id: 'rev-uuid' }, error: null },      // gbp_reviews select for draft
      { data: null, error: null },                    // gbp_review_replies upsert
      { data: null, error: null },                    // upsert synced (reviews)
      { data: null, error: null },                    // getSyncState metrics → not_started
      { data: null, error: null },                    // upsert synced (metrics)
    ])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    const result = await runGbpSync('sync-user-id')

    expect(mocks.mockDraftReviewReply).toHaveBeenCalledOnce()
    expect(result.totalOk).toBe(1)
    expect(result.locations[0].draftsGenerated).toBe(1)
  })

  it('does NOT generate a draft for reviews outside the activation window (> 7 days)', async () => {
    const review = makeReview({ createTime: '2023-12-20T10:00:00Z' }) // 12 days before 2024-01-01
    const location = { ...DB_LOCATION, activation_date: '2024-01-01' }

    mocks.mockFetchAllGbpReviews.mockResolvedValueOnce([review])

    setupFromQueue([
      { data: [location], error: null },          // gbp_locations
      { data: null, error: null },                // upsert syncing (reviews)
      { data: null, error: null },                // upsert syncing (metrics)
      { data: null, error: null },                // getSyncState reviews → not_started
      { data: null, error: null },                // gbp_reviews existing check → null (new)
      { data: null, error: null },                // gbp_reviews upsert
      // No draft generation — no gbp_reviews select or gbp_review_replies upsert
      { data: null, error: null },                // upsert synced (reviews)
      { data: null, error: null },                // getSyncState metrics → not_started
      { data: null, error: null },                // upsert synced (metrics)
    ])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    const result = await runGbpSync('sync-user-id')

    expect(mocks.mockDraftReviewReply).not.toHaveBeenCalled()
    expect(result.locations[0].draftsGenerated).toBe(0)
  })

  it('does NOT generate a draft for reviews that already have an existing reply', async () => {
    const review = makeReview({
      createTime:  '2024-06-01T10:00:00Z',
      reviewReply: { comment: 'Thanks!', updateTime: '2024-06-02T10:00:00Z' },
    })

    mocks.mockFetchAllGbpReviews.mockResolvedValueOnce([review])

    setupFromQueue([
      { data: [DB_LOCATION], error: null },       // gbp_locations
      { data: null, error: null },                // upsert syncing (reviews)
      { data: null, error: null },                // upsert syncing (metrics)
      { data: null, error: null },                // getSyncState → not_started
      { data: null, error: null },                // gbp_reviews existing check → null (new)
      { data: null, error: null },                // gbp_reviews upsert
      { data: null, error: null },                // detectExternalReplies: gbp_reviews select
      { data: null, error: null },                // detectExternalReplies: gbp_review_replies select → not found
      { data: null, error: null },                // upsert synced (reviews)
      { data: null, error: null },                // getSyncState metrics
      { data: null, error: null },                // upsert synced (metrics)
    ])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    await runGbpSync('sync-user-id')

    expect(mocks.mockDraftReviewReply).not.toHaveBeenCalled()
  })
})

// ── Error isolation ────────────────────────────────────────────────────────────

describe('runGbpSync — per-location error isolation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('captures error in LocationSyncResult without throwing', async () => {
    mocks.mockFetchAllGbpReviews.mockRejectedValueOnce(new Error('GBP API down'))
    mocks.mockFetchLocationMetrics.mockResolvedValue([])

    setupFromQueue([
      { data: [DB_LOCATION], error: null },   // gbp_locations
      { data: null, error: null },             // upsert syncing (reviews)
      { data: null, error: null },             // upsert syncing (metrics)
      { data: null, error: null },             // getSyncState reviews → not_started
      // fetchAllGbpReviews throws — triggers catch
      { data: null, error: null },             // upsert failed (reviews)
      { data: null, error: null },             // upsert failed (metrics)
    ])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    const result = await runGbpSync('sync-user-id')

    expect(result.totalFail).toBe(1)
    expect(result.totalOk).toBe(0)
    expect(result.locations[0].ok).toBe(false)
    expect(result.locations[0].error).toContain('GBP API down')
  })
})

// ── Draft generation failure ───────────────────────────────────────────────────

describe('draft generation failure', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('review is still counted as upserted when draft AI call fails', async () => {
    const review = makeReview({ createTime: '2024-06-01T10:00:00Z' })
    mocks.mockFetchAllGbpReviews.mockResolvedValueOnce([review])
    mocks.mockFetchLocationMetrics.mockResolvedValue([])
    mocks.mockDraftReviewReply.mockResolvedValueOnce({ ok: false, error: 'API key missing' })

    setupFromQueue([
      { data: [DB_LOCATION], error: null },
      { data: null, error: null },              // upsert syncing reviews
      { data: null, error: null },              // upsert syncing metrics
      { data: null, error: null },              // getSyncState reviews → not_started
      { data: null, error: null },              // gbp_reviews existing check → new
      { data: null, error: null },              // gbp_reviews upsert
      { data: { id: 'rev-uuid' }, error: null }, // gbp_reviews select for draft
      { data: null, error: null },              // gbp_review_replies upsert (status=new)
      { data: null, error: null },              // upsert synced reviews
      { data: null, error: null },              // getSyncState metrics
      { data: null, error: null },              // upsert synced metrics
    ])

    const { runGbpSync } = await import('@/lib/gbp/sync')
    const result = await runGbpSync('sync-user-id')

    expect(result.totalOk).toBe(1)
    expect(result.locations[0].reviewsUpserted).toBe(1)
    expect(result.locations[0].draftsGenerated).toBe(0)
  })
})

// ── retryDraftForReview ────────────────────────────────────────────────────────

describe('retryDraftForReview', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns ok: false when review not found', async () => {
    setupFromQueue([{ data: null, error: null }])

    const { retryDraftForReview } = await import('@/lib/gbp/sync')
    const result = await retryDraftForReview('nonexistent-id')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns ok: true on successful draft generation', async () => {
    mocks.mockDraftReviewReply.mockResolvedValueOnce({
      ok: true, draft: 'Thank you!', model: 'claude-sonnet-4-6', promptVersion: 'v1',
    })

    setupFromQueue([
      { data: { id: 'rev-1', google_review_id: 'grev', reviewer_name: 'Bob', star_rating: 5, review_text: 'Great', location_id: 'loc-1' }, error: null },
      { data: { store_name: 'Killer Kebab CPH' }, error: null },
      { data: null, error: null }, // gbp_review_replies upsert
    ])

    const { retryDraftForReview } = await import('@/lib/gbp/sync')
    const result = await retryDraftForReview('rev-1')

    expect(result.ok).toBe(true)
    expect(mocks.mockDraftReviewReply).toHaveBeenCalledOnce()
  })

  it('returns ok: false when location not found', async () => {
    setupFromQueue([
      { data: { id: 'rev-1', google_review_id: 'grev', reviewer_name: 'Bob', star_rating: 5, review_text: 'Great', location_id: 'loc-1' }, error: null },
      { data: null, error: null }, // location not found
    ])

    const { retryDraftForReview } = await import('@/lib/gbp/sync')
    const result = await retryDraftForReview('rev-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Location not found')
  })

  it('returns ok: false when AI draft fails', async () => {
    mocks.mockDraftReviewReply.mockResolvedValueOnce({ ok: false, error: 'network error' })

    setupFromQueue([
      { data: { id: 'rev-1', google_review_id: 'grev', reviewer_name: 'Bob', star_rating: 5, review_text: 'Great', location_id: 'loc-1' }, error: null },
      { data: { store_name: 'Killer Kebab CPH' }, error: null },
    ])

    const { retryDraftForReview } = await import('@/lib/gbp/sync')
    const result = await retryDraftForReview('rev-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('network error')
  })
})
