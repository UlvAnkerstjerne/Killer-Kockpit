import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), db: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.db }))
vi.mock('@/lib/gbp/sync', () => ({ runGbpSync: vi.fn() }))
vi.mock('@/lib/google/auth', () => ({ getGoogleOAuth2Client: vi.fn(), hasGbpScope: vi.fn() }))
vi.mock('@/lib/google/gbp-client', () => ({ publishGbpReviewReply: vi.fn() }))
import { getGbpStoreReviewSummary } from '@/lib/actions/marketing/gbp-reviews'
beforeEach(() => { mocks.user.mockResolvedValue({ id: 'admin', role: 'SUPER_ADMIN' }) })
it('reads six latest snapshots and computes 7-day avg rating per store', async () => {
  const locations = ['Christianshavn', 'Fisketorvet', 'Frederiksberg', 'Borgergade', 'Nørrebro', 'Vesterbro', 'Parken'].map((name, i) => ({ id: `${i}`, store_short_name: name }))
  const tables: string[] = []
  mocks.db.mockReturnValue({ from: (table: string) => {
    tables.push(table)
    const q: Record<string, unknown> = { select: () => q, eq: () => q, gte: () => q, order: () => q,
      limit: () => q, maybeSingle: () => q,
      then: (resolve: (x: unknown) => void) => Promise.resolve(resolve({
        data: table === 'user_marketing_permissions' ? []
          : table === 'gbp_locations' ? locations
          : table === 'gbp_reviews' ? [{ star_rating: 4 }, { star_rating: 5 }]
          : { average_rating: 4.578, new_reviews_7d: 8, unanswered_count: 6 },
        error: null,
      })) }
    return q
  } })
  const result = await getGbpStoreReviewSummary()
  expect(result).toHaveLength(6)
  // avgRating7d (4.5) < avgRating (4.578) → recent reviews pulling rating down
  expect(result[0]).toMatchObject({ avgRating: 4.578, avgRating7d: 4.5, newReviews7d: 8, unanswered: 6, ratingTrend: 'down' })
})
