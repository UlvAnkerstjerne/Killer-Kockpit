import { describe, expect, it, vi } from 'vitest'
import { captureReviewHealth } from '@/lib/gbp/review-health'
import { estimateRatingMilestone } from '@/lib/gbp/rating-milestone'

describe('Google review-health capture', () => {
  it('passes unrounded Google metadata to one aggregate/upsert RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await captureReviewHealth({ rpc } as never, 'location', { averageRating: 4.57219, totalReviewCount: 3883 }, '2026-09-23T04:45:00Z')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('capture_gbp_review_health', {
      p_location_id: 'location', p_average_rating: 4.57219, p_total_review_count: 3883, p_captured_at: '2026-09-23T04:45:00Z',
    })
  })
  it('keeps unavailable metadata null, and rejects invalid values', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await captureReviewHealth({ rpc } as never, 'location', {}, '2026-09-23T04:45:00Z')
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_average_rating: null, p_total_review_count: null })
    await expect(captureReviewHealth({ rpc } as never, 'location', { averageRating: NaN }, '')).rejects.toThrow('invalid')
    await expect(captureReviewHealth({ rpc } as never, 'location', { totalReviewCount: -1 }, '')).rejects.toThrow('invalid')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
describe('estimated rating milestone (ordinary rounding assumption)', () => {
  it('estimates the next displayed tenth only with sufficient input precision', () => {
    expect(estimateRatingMilestone(4.57, 25)).toEqual({ fiveStarReviews: 6, displayedRating: 4.6, targetDisplayedRating: 4.7 })
    expect(estimateRatingMilestone(4.54, 100)?.fiveStarReviews).toBe(3)
  })
  it.each([4.5, 4, 5, NaN, Infinity, 0, null])('returns unavailable for %s', average => {
    expect(estimateRatingMilestone(average, 100)).toBeNull()
  })
  it.each([0, -1, 0.5, Infinity, NaN, null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid count %s', count => {
    expect(estimateRatingMilestone(4.57, count)).toBeNull()
  })
  it('handles the maximum displayed rating without division or pathological results', () => {
    expect(estimateRatingMilestone(4.99, 100)).toBeNull()
    expect(estimateRatingMilestone(4.94, 100)?.targetDisplayedRating).toBe(5)
  })
})
