/**
 * Tests for lib/actions/marketing/review-items.ts
 *
 * getMarketingPendingReviews() is a self-authenticating server action.
 * It derives user identity, role, and permissions from authenticated server
 * state — never from caller-supplied parameters.
 *
 * In M1, no domain tables exist. The function must return an empty array
 * for all callers regardless of role or permissions.
 *
 * Security tests verify:
 *   - unauthenticated callers receive an empty array (not an error surface)
 *   - users without marketing_access receive an empty array
 *   - role and permissions come from server state, not caller input
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()

  // mkChain: a Promise-based chainable that mirrors Supabase's PostgrestFilterBuilder.
  // Supports: await select().eq(), eq().eq().single(), eq().order(), etc.
  function mkChain(resp: { data: unknown; error: unknown }): never {
    const p = Object.assign(Promise.resolve(resp), {
      single: vi.fn().mockResolvedValue(resp),
      eq:     vi.fn(),
      order:  vi.fn().mockResolvedValue(resp),
      like:   vi.fn(),
    }) as never as {
      single: ReturnType<typeof vi.fn>
      eq: ReturnType<typeof vi.fn>
      order: ReturnType<typeof vi.fn>
      like: ReturnType<typeof vi.fn>
    }
    ;(p as { eq: ReturnType<typeof vi.fn> }).eq.mockReturnValue(p)
    ;(p as { like: ReturnType<typeof vi.fn> }).like.mockReturnValue({ order: vi.fn().mockResolvedValue(resp) })
    return p as never
  }

  // Default from() impl: permissions query gets [], GBP replies get []
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'user_marketing_permissions') {
      return {
        select: vi.fn().mockReturnValue(mkChain({ data: [], error: null })),
        insert: vi.fn(), update: vi.fn(), upsert: vi.fn(),
      }
    }
    return {
      select: vi.fn().mockReturnValue(mkChain({ data: [], error: null })),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }
  })

  const mockClient = { from: mockFrom }

  return { mockGetCurrentUser, mockFrom, mockClient }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn().mockResolvedValue(mocks.mockClient),
  createServiceClient: vi.fn().mockReturnValue(mocks.mockClient),
}))

// ── Global setup ──────────────────────────────────────────────────────────────
//
// Some tests override `mocks.mockClient.from`. This top-level beforeEach
// restores the default table-aware mockFrom before each test so overrides
// don't leak across tests.

beforeEach(() => {
  mocks.mockClient.from = mocks.mockFrom
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUPER_ADMIN = {
  id: 'admin-id',
  role: 'SUPER_ADMIN' as const,
  marketing_access: false, // SUPER_ADMIN bypasses the flag
}

const MARKETING_UM = {
  id: 'um-id',
  role: 'UM' as const,
  marketing_access: true,
}

const NO_ACCESS_MEMBER = {
  id: 'member-id',
  role: 'MEMBER' as const,
  marketing_access: false,
}

// ── M1 baseline — empty array for all cases ───────────────────────────────────

describe('getMarketingPendingReviews — M1 baseline (no domain tables)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty array for unauthenticated caller', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toEqual([])
  })

  it('returns empty array for user without marketing_access', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(NO_ACCESS_MEMBER)
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toEqual([])
  })

  it('returns empty array for SUPER_ADMIN (no domain records exist yet)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toEqual([])
  })

  it('returns empty array for marketing_access UM with reviews_manage but NOT reviews_approve', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MARKETING_UM)
    // reviews_manage alone does not grant access to getPendingGbpReplies
    mocks.mockClient.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'user_marketing_permissions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { permission: 'paid_manage' },
                { permission: 'reviews_manage' },  // no reviews_approve
              ],
              error: null,
            }),
          }),
        }
      }
      // GBP table — should not be reached for reviews_manage-only user
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) }
    })
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toEqual([])
  })

  it('result is always an array', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(Array.isArray(result)).toBe(true)
  })
})

// ── Authorization self-containment ────────────────────────────────────────────
//
// These tests verify that the function does not accept caller-controlled
// authorization context. The function signature is () => Promise<...>.
// Role and permissions come exclusively from getCurrentUser + DB, not the caller.

describe('getMarketingPendingReviews — authorization is self-contained', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts no caller-supplied userId, role, or permissions', async () => {
    // The function must be callable with zero arguments — no auth context accepted
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    // Type-level: getMarketingPendingReviews() — zero args
    const result = await getMarketingPendingReviews()
    expect(Array.isArray(result)).toBe(true)
  })

  it('calls getCurrentUser to resolve identity', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    await getMarketingPendingReviews()
    expect(mocks.mockGetCurrentUser).toHaveBeenCalledOnce()
  })

  it('returns empty array without calling domain queries when not authenticated', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(null)
    const mockFromSpy = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn() }),
    })
    mocks.mockClient.from = mockFromSpy
    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    await getMarketingPendingReviews()
    // No DB reads for permissions or domain data when unauthenticated
    expect(mockFromSpy).not.toHaveBeenCalled()
  })
})

// ── M2 GBP review reply items ─────────────────────────────────────────────────
//
// collectPendingReviews() calls getPendingGbpReplies() only when the caller
// has reviews_approve. Tests verify both the happy path and the gate.

describe('getMarketingPendingReviews — GBP review reply items (M2)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns GBP reply items for user with reviews_approve permission', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MARKETING_UM)

    // Build a service client mock that returns:
    //   1st from() call → user_marketing_permissions (reviews_approve granted)
    //   2nd from() call → gbp_review_replies (one pending item)
    const pendingReply = {
      id:         'reply-uuid-1',
      status:     'awaiting_review',
      created_at: '2024-06-01T10:00:00Z',
      review:     {
        star_rating:      5,
        review_text:      'Amazing kebab!',
        review_created_at: '2024-06-01T10:00:00Z',
        reviewer_name:    'Alice',
        location:         { store_short_name: 'CPH' },
      },
    }

    let callCount = 0
    mocks.mockClient.from = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // user_marketing_permissions
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ permission: 'reviews_approve' }],
              error: null,
            }),
          }),
        }
      }
      // gbp_review_replies
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [pendingReply], error: null }),
          }),
        }),
      }
    })

    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('reply-uuid-1')
    expect(result[0].kind).toBe('review_reply')
    expect(result[0].title).toContain('CPH')
    expect(result[0].title).toContain('Alice')
    expect(result[0].description).toContain('Amazing kebab!')
    expect(result[0].requires_permission).toBe('reviews_approve')
  })

  it('does NOT return GBP reply items for user with only reviews_manage (not reviews_approve)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(MARKETING_UM)

    mocks.mockClient.from = vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ permission: 'reviews_manage' }],
          error: null,
        }),
      }),
    }))

    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toEqual([])
  })

  it('returns GBP items for SUPER_ADMIN (bypasses permission check)', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    const pendingReply = {
      id:         'reply-uuid-2',
      status:     'awaiting_review',
      created_at: '2024-06-01T10:00:00Z',
      review:     {
        star_rating:      4,
        review_text:      'Good place.',
        review_created_at: '2024-06-01T10:00:00Z',
        reviewer_name:    'Bob',
        location:         { store_short_name: 'ARH' },
      },
    }

    let callCount = 0
    mocks.mockClient.from = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // permissions — empty (SUPER_ADMIN bypasses)
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }
      }
      // gbp_review_replies
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [pendingReply], error: null }),
          }),
        }),
      }
    })

    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('review_reply')
  })

  it('handles rating-only reviews (null review_text) without description', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    const ratingOnlyReply = {
      id:         'reply-uuid-3',
      status:     'awaiting_review',
      created_at: '2024-06-01T10:00:00Z',
      review:     {
        star_rating:      5,
        review_text:      null,
        review_created_at: '2024-06-01T10:00:00Z',
        reviewer_name:    'Anonymous',
        location:         { store_short_name: 'CPH' },
      },
    }

    let callCount = 0
    mocks.mockClient.from = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) }
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [ratingOnlyReply], error: null }),
          }),
        }),
      }
    })

    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toHaveLength(1)
    expect(result[0].description).toBeNull()
  })

  it('returns empty array when gbp_review_replies query errors', async () => {
    mocks.mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN)

    let callCount = 0
    mocks.mockClient.from = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) }
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: null, error: { message: 'table not found' } }),
          }),
        }),
      }
    })

    const { getMarketingPendingReviews } = await import('@/lib/actions/marketing/review-items')
    const result = await getMarketingPendingReviews()
    expect(result).toEqual([])
  })
})
