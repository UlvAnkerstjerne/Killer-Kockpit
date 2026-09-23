import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), db: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.db }))
vi.mock('@/lib/gbp/sync', () => ({ runGbpSync: vi.fn() }))
vi.mock('@/lib/google/auth', () => ({ getGoogleOAuth2Client: vi.fn(), hasGbpScope: vi.fn() }))
vi.mock('@/lib/google/gbp-client', () => ({ publishGbpReviewReply: vi.fn() }))
import { getGbpStoreReviewSummary } from '@/lib/actions/marketing/gbp-reviews'
beforeEach(() => { mocks.user.mockResolvedValue({ id: 'admin', role: 'SUPER_ADMIN' }) })
it('reads six latest snapshots without loading any reviews or snapshot history', async () => {
  const locations = ['Christianshavn', 'Fisketorvet', 'Frederiksberg', 'Borgergade', 'Nørrebro', 'Vesterbro', 'Parken'].map((name, i) => ({ id: `${i}`, store_short_name: name }))
  const limits: number[] = [], tables: string[] = []
  mocks.db.mockReturnValue({ from: (table: string) => {
    tables.push(table)
    const q = { select: () => q, eq: () => q, order: () => q,
      limit: (n: number) => { limits.push(n); return q }, maybeSingle: () => q,
      then: (resolve: (x: unknown) => void) => Promise.resolve(resolve({ data: table === 'user_marketing_permissions' ? [] : table === 'gbp_locations' ? locations : { average_rating: 4.578, new_reviews_7d: 8, unanswered_count: 6 }, error: null })) }
    return q
  } })
  const result = await getGbpStoreReviewSummary()
  expect(result).toHaveLength(6)
  expect(result[0]).toMatchObject({ avgRating: 4.578, newReviews7d: 8, unanswered: 6 })
  expect(tables).not.toContain('gbp_reviews')
  expect(limits).toEqual([1, 1, 1, 1, 1, 1])
})
