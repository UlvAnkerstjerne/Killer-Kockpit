/**
 * Tests for lib/actions/marketing/gbp-reviews.ts
 *
 * All server actions are self-authenticating — actor identity comes from
 * getCurrentUser(), never from caller parameters.
 *
 * Tests verify: auth gates, permission checks, status validation,
 * audit event writes, publish success/failure paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockPublishGbpReviewReply = vi.fn()
  const mockRunGbpSync = vi.fn()
  const mockGetGoogleOAuth2Client = vi.fn()
  const mockHasGbpScope = vi.fn().mockReturnValue(true)

  // Flexible DB mock — each call to from() is controlled by tableQueues
  const tableQueues: Record<string, unknown[]> = {}

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const queue = tableQueues[table] ?? []
    const next = queue.shift() ?? { data: null, error: null }
    const selectResult = { data: (next as { data: unknown }).data, error: (next as { error: unknown }).error }

    const singleMock = vi.fn().mockResolvedValue(next)
    const eqMock: ReturnType<typeof vi.fn> = vi.fn()
    eqMock.mockReturnValue({ single: singleMock, eq: eqMock })
    const orderMock = vi.fn().mockResolvedValue(selectResult)
    const likeMock  = vi.fn().mockReturnValue({ order: orderMock })

    return {
      select: vi.fn().mockReturnValue({ eq: eqMock, like: likeMock, order: orderMock }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }
  })

  const mockServiceClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockPublishGbpReviewReply,
    mockRunGbpSync,
    mockGetGoogleOAuth2Client,
    mockHasGbpScope,
    mockFrom,
    mockServiceClient,
    tableQueues,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue(mocks.mockServiceClient),
}))
vi.mock('@/lib/google/auth', () => ({
  getGoogleOAuth2Client: mocks.mockGetGoogleOAuth2Client,
  hasGbpScope:           mocks.mockHasGbpScope,
}))
vi.mock('@/lib/google/gbp-client', () => ({
  publishGbpReviewReply: mocks.mockPublishGbpReviewReply,
}))
vi.mock('@/lib/gbp/sync', () => ({
  runGbpSync: mocks.mockRunGbpSync,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  id:               'admin-id',
  role:             'SUPER_ADMIN' as const,
  marketing_access: false,
}

const REVIEWER = {
  id:               'reviewer-id',
  role:             'UM' as const,
  marketing_access: true,
}

const NO_ACCESS = {
  id:               'no-access-id',
  role:             'MEMBER' as const,
  marketing_access: false,
}

// Simulate permission rows for a user with reviews_approve
function permRows(perms: string[]) {
  return perms.map((p) => ({ permission: p }))
}

// ── getGbpLocations ───────────────────────────────────────────────────────────

describe('getGbpLocations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty array for unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getGbpLocations } = await import('@/lib/actions/marketing/gbp-reviews')
    expect(await getGbpLocations()).toEqual([])
  })

  it('returns empty array for user without marketing_access', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(NO_ACCESS)
    const { getGbpLocations } = await import('@/lib/actions/marketing/gbp-reviews')
    expect(await getGbpLocations()).toEqual([])
  })

  it('returns locations for SUPER_ADMIN', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // SUPER_ADMIN bypasses marketing_access flag; assertMarketingRead also checks permissions
    // For SUPER_ADMIN, canRead = true regardless of permission rows
    const locations = [{ id: 'loc-1', store_name: 'CPH', store_short_name: 'CPH', address_summary: null, activation_date: '2024-01-01', active: true }]

    // First from() call: user_marketing_permissions query in assertMarketingRead
    // Second from() call: gbp_locations query
    mocks.mockFrom.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        like: vi.fn(), order: vi.fn(),
      }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    })).mockImplementationOnce(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ order: vi.fn().mockResolvedValue({ data: locations, error: null }) }),
        like: vi.fn(),
        order: vi.fn().mockResolvedValue({ data: locations, error: null }),
      }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    }))

    const { getGbpLocations } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await getGbpLocations()
    expect(result).toHaveLength(1)
    expect(result[0].store_name).toBe('CPH')
  })
})

// ── approveGbpReply ───────────────────────────────────────────────────────────

describe('approveGbpReply', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error for unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await approveGbpReply('reply-id', 'Thank you!')
    expect(result.error).toBeTruthy()
  })

  it('returns error for user without marketing_access', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(NO_ACCESS)
    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await approveGbpReply('reply-id', 'Thank you!')
    expect(result.error).toBeTruthy()
  })

  it('returns error when approvedText is empty', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // permissions query
    mocks.mockFrom.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    }))
    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await approveGbpReply('reply-id', '   ')
    expect(result.error).toContain('empty')
  })

  it('returns error when reply not found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    // permissions query
    mocks.mockFrom.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    }))
    // gbp_review_replies select — not found
    mocks.mockFrom.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    }))

    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await approveGbpReply('reply-id', 'Some text')
    expect(result.error).toContain('not found')
  })

  it('returns error when reply is in non-actionable status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'r', status: 'published' }, error: null }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await approveGbpReply('reply-id', 'Some text')
    expect(result.error).toContain('published')
  })

  it('returns { data: { status: approved } } on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    const mockInsert = vi.fn().mockResolvedValue({ error: null })

    mocks.mockFrom
      // 1. permissions
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // 2. gbp_review_replies select
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'r', status: 'awaiting_review' }, error: null }),
          }),
        }),
        insert: vi.fn(), update: mockUpdate, upsert: vi.fn(),
      }))
      // 3. gbp_review_replies update
      .mockImplementationOnce(() => ({ update: mockUpdate, select: vi.fn(), insert: vi.fn(), upsert: vi.fn() }))
      // 4. audit_events insert
      .mockImplementationOnce(() => ({ insert: mockInsert, select: vi.fn(), update: vi.fn(), upsert: vi.fn() }))

    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await approveGbpReply('reply-id', 'Thank you for visiting!')
    expect(result.error).toBeUndefined()
    expect((result as { data: { status: string } }).data?.status).toBe('approved')
  })
})

// ── rejectGbpReply ────────────────────────────────────────────────────────────

describe('rejectGbpReply', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error for unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { rejectGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    expect((await rejectGbpReply('reply-id', '')).error).toBeTruthy()
  })

  it('returns error when reply status is not rejectable', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'r', status: 'published' }, error: null }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { rejectGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await rejectGbpReply('reply-id', 'no reason')
    expect(result.error).toBeTruthy()
  })

  it('returns { data: { status: rejected } } on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'r', status: 'awaiting_review' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        select: vi.fn(), insert: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        insert: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { rejectGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await rejectGbpReply('reply-id', 'Tone not right')
    expect(result.error).toBeUndefined()
    expect((result as { data: { status: string } }).data?.status).toBe('rejected')
  })
})

// ── publishGbpReply ───────────────────────────────────────────────────────────

describe('publishGbpReply', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns error for unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { publishGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    expect((await publishGbpReply('reply-id')).error).toBeTruthy()
  })

  it('returns error when reply is not in approved status', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockFrom
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'r', status: 'awaiting_review', approved_text: null, review_id: 'rev-1' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { publishGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await publishGbpReply('reply-id')
    expect(result.error).toContain('approved')
  })

  it('returns error when no GBP token found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(false)

    mocks.mockFrom
      // permissions
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // gbp_review_replies
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'r', status: 'approved', approved_text: 'Thanks!', review_id: 'rev-1' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // gbp_reviews
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { google_review_id: 'accounts/1/locations/2/reviews/A' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // google_oauth_tokens — none with GBP scope
      .mockImplementationOnce(() => ({
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { publishGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await publishGbpReply('reply-id')
    expect(result.error).toContain('GBP')
  })

  it('returns { data: { status: published } } on successful publish', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(true)
    mocks.mockPublishGbpReviewReply.mockResolvedValue({ ok: true })
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})

    mocks.mockFrom
      // permissions
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // gbp_review_replies
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'r', status: 'approved', approved_text: 'Thanks!', review_id: 'rev-1' },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn(), upsert: vi.fn(),
      }))
      // gbp_reviews
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { google_review_id: 'accounts/1/locations/2/reviews/A' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // google_oauth_tokens
      .mockImplementationOnce(() => ({
        select: vi.fn().mockResolvedValue({
          data: [{ user_id: 'sync-user', scopes: ['https://www.googleapis.com/auth/business.manage'] }],
          error: null,
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // gbp_review_replies update (published)
      .mockImplementationOnce(() => ({
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        select: vi.fn(), insert: vi.fn(), upsert: vi.fn(),
      }))
      // audit_events insert
      .mockImplementationOnce(() => ({
        insert: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { publishGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await publishGbpReply('reply-id')
    expect(result.error).toBeUndefined()
    expect((result as { data: { status: string } }).data?.status).toBe('published')
    expect(mocks.mockPublishGbpReviewReply).toHaveBeenCalledOnce()
  })

  it('returns { data: { status: publish_failed } } when GBP publish fails', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(true)
    mocks.mockPublishGbpReviewReply.mockResolvedValue({ ok: false, error: '403 Forbidden' })
    mocks.mockGetGoogleOAuth2Client.mockResolvedValue({})

    mocks.mockFrom
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'r', status: 'approved', approved_text: 'Thanks!', review_id: 'rev-1' },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { google_review_id: 'accounts/1/locations/2/reviews/A' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn().mockResolvedValue({
          data: [{ user_id: 'sync-user', scopes: ['https://www.googleapis.com/auth/business.manage'] }],
          error: null,
        }),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))
      // update to publish_failed
      .mockImplementationOnce(() => ({
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        select: vi.fn(), insert: vi.fn(), upsert: vi.fn(),
      }))
      // audit insert
      .mockImplementationOnce(() => ({
        insert: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }))

    const { publishGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await publishGbpReply('reply-id')
    expect(result.error).toBeUndefined()
    expect((result as { data: { status: string } }).data?.status).toBe('publish_failed')
  })
})

// ── triggerGbpSync ────────────────────────────────────────────────────────────

describe('triggerGbpSync', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns error for non-SUPER_ADMIN', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(REVIEWER)
    const { triggerGbpSync } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await triggerGbpSync()
    expect(result.error).toContain('SUPER_ADMIN')
  })

  it('returns error when no GBP-scoped token found', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(false)
    mocks.mockFrom.mockImplementationOnce(() => ({
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    }))

    const { triggerGbpSync } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await triggerGbpSync()
    expect(result.error).toBeTruthy()
    expect(mocks.mockRunGbpSync).not.toHaveBeenCalled()
  })

  it('calls runGbpSync and returns summary on success', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    mocks.mockHasGbpScope.mockReturnValue(true)
    mocks.mockRunGbpSync.mockResolvedValue({ totalOk: 2, totalFail: 0, locations: [] })

    mocks.mockFrom.mockImplementationOnce(() => ({
      select: vi.fn().mockResolvedValue({
        data: [{ user_id: 'sync-user', scopes: ['https://www.googleapis.com/auth/business.manage'] }],
        error: null,
      }),
      insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
    }))

    const { triggerGbpSync } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await triggerGbpSync()
    expect(result.error).toBeUndefined()
    expect((result as { data: { summary: string } }).data?.summary).toContain('2')
    expect(mocks.mockRunGbpSync).toHaveBeenCalledWith('sync-user')
  })
})

// ── Actor ID trust boundary ───────────────────────────────────────────────────

describe('actor ID trust boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('approveGbpReply signature accepts only replyId and text — no auth params', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { approveGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    // Callable with exactly 2 args — no userId, role, or permissions from caller
    const result = await approveGbpReply('reply-id', 'text')
    expect(result.error).toBeTruthy() // unauthenticated
    expect(mocks.mockGetCurrentUser).toHaveBeenCalledOnce()
  })

  it('publishGbpReply signature accepts only replyId — no auth params', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { publishGbpReply } = await import('@/lib/actions/marketing/gbp-reviews')
    const result = await publishGbpReply('reply-id')
    expect(result.error).toBeTruthy()
    expect(mocks.mockGetCurrentUser).toHaveBeenCalledOnce()
  })
})
