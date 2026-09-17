import { beforeEach, describe, it, expect, vi } from 'vitest'
import { gbpDb } from '../../helpers/gbp-db'
const mocks = vi.hoisted(() => ({ client: vi.fn(), page: vi.fn(), draft: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.client() }))
vi.mock('@/lib/google/gbp-client', () => ({ fetchGbpReviewsPage: mocks.page, normaliseStarRating: () => 5 }))
vi.mock('@/lib/ai/draft-review-reply', () => ({ draftReviewReply: mocks.draft }))
vi.mock('@/lib/marketing/gbp/brand-context', () => ({ KILLER_KEBAB_REVIEW_REPLY_CONTEXT: 'Existing policy' }))
import { syncLocationReviews, retryDraftForReview } from '@/lib/gbp/reviews-sync'
let db: ReturnType<typeof gbpDb>
const location = { id: 'gbp-1', google_account_id: '1', google_location_id: '2', location_id: 'store-1', store_name: 'Killer', store_short_name: 'KK', activation_date: '2026-09-01', active: true }
const review = (id: string, created = '2026-09-01T12:00:00Z', reply = false) => ({ name: `accounts/1/locations/2/reviews/${id}`, reviewer: {}, starRating: 'FIVE', createTime: created, updateTime: '2026-09-16T12:00:00Z', ...(reply ? { reviewReply: { comment: 'Already answered', updateTime: '2026-09-17T10:00:00Z' } } : {}) })
const run = (last: string | null = null) => syncLocationReviews(db as never, location, {} as never, last)
beforeEach(() => { vi.clearAllMocks(); db = gbpDb(); mocks.client.mockReturnValue(db); db.tables.gbp_locations = [location]; mocks.page.mockResolvedValue({ reviews: [] }); mocks.draft.mockResolvedValue({ ok: true, draft: 'Thanks', model: 'existing', promptVersion: 'v1' }) })
describe('existing GBP review policy', () => {
  it('fully paginates, imports history and only drafts inside the existing activation window', async () => {
    mocks.page.mockResolvedValueOnce({ reviews: [review('old', '2025-01-01T12:00:00Z')], nextPageToken: 'next' }).mockResolvedValueOnce({ reviews: [review('new'), review('answered', undefined, true)] })
    expect(await run()).toEqual({ reviewsUpserted: 3, draftsGenerated: 1 })
    expect(mocks.page).toHaveBeenCalledTimes(2); expect(mocks.draft).toHaveBeenCalledTimes(1)
    expect(db.tables.gbp_reviews.every(row => row.location_id === 'gbp-1')).toBe(true)
  })
  it('does not redraft or duplicate imported reviews on rerun', async () => {
    mocks.page.mockResolvedValue({ reviews: [review('new')] })
    await run(); await run()
    expect(db.tables.gbp_reviews).toHaveLength(1); expect(db.tables.gbp_review_replies).toHaveLength(1); expect(mocks.draft).toHaveBeenCalledTimes(1)
  })
  it('paginates incremental reviews until its previous-success overlap watermark', async () => {
    mocks.page.mockResolvedValueOnce({ reviews: [review('new')], nextPageToken: 'second' }).mockResolvedValueOnce({ reviews: [{ ...review('old'), updateTime: '2026-08-01T00:00:00Z' }], nextPageToken: 'unused' })
    await run('2026-09-15T12:00:00Z')
    expect(mocks.page).toHaveBeenCalledTimes(2); expect(db.tables.gbp_reviews).toHaveLength(1)
  })
  it('detects an externally published reply using the unchanged pending-status rules', async () => {
    db.tables.gbp_reviews = [{ id: 'review-1', google_review_id: review('r').name }]
    db.tables.gbp_review_replies = [{ id: 'reply-1', review_id: 'review-1', status: 'approved', draft_text: 'Existing draft' }]
    mocks.page.mockResolvedValue({ reviews: [review('r', undefined, true)] }); await run()
    expect(db.tables.gbp_review_replies[0]).toMatchObject({ status: 'externally_published', draft_text: 'Existing draft' })
    expect(mocks.draft).not.toHaveBeenCalled()
  })
  it('retains review data and existing manual retry when AI draft generation fails', async () => {
    mocks.page.mockResolvedValue({ reviews: [review('new')] }); mocks.draft.mockResolvedValueOnce({ ok: false, error: 'private-provider-error' })
    expect(await run()).toEqual({ reviewsUpserted: 1, draftsGenerated: 0 })
    expect(db.tables.gbp_review_replies[0].status).toBe('new')
    expect(await retryDraftForReview(db.tables.gbp_reviews[0].id)).toEqual({ ok: true })
  })
  it('rejects repeated pagination tokens, provider page errors and storage failure', async () => {
    mocks.page.mockResolvedValue({ reviews: [], nextPageToken: 'loop' }); await expect(run()).rejects.toThrow('pagination')
    mocks.page.mockRejectedValueOnce(new Error('page failed')); await expect(run()).rejects.toThrow('page failed')
    mocks.page.mockResolvedValue({ reviews: [review('new')] }); db.failures['gbp_reviews:upsert'] = 1; await expect(run()).rejects.toThrow('Could not save GBP review')
  })
  it('keeps manual retry not-found behaviour', async () => {
    expect(await retryDraftForReview('absent')).toMatchObject({ ok: false, error: 'Review not found.' })
    db.tables.gbp_reviews = [{ id: 'review', location_id: 'missing' }]
    expect(await retryDraftForReview('review')).toMatchObject({ ok: false, error: 'Location not found.' })
  })
})
