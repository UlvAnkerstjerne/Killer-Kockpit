import type { GbpReviewsPage } from '@/lib/google/gbp-client'
import { GbpDataError } from './data'
import type { GbpDb } from './state'

/** Keep Google's precision; never substitute a local average or a guessed zero. */
export async function captureReviewHealth(db: GbpDb, locationId: string, metadata: Pick<GbpReviewsPage, 'averageRating' | 'totalReviewCount'>, capturedAt: string) {
  const average = metadata.averageRating
  const count = metadata.totalReviewCount
  if (average !== undefined && (!Number.isFinite(average) || average < 0 || average > 5 || (average > 0 && average < 1))) {
    throw new GbpDataError('Google returned an invalid average review rating.')
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
    throw new GbpDataError('Google returned an invalid total review count.')
  }
  const { error } = await db.rpc('capture_gbp_review_health', {
    p_location_id: locationId,
    p_average_rating: average && average >= 1 ? average : null,
    p_total_review_count: count ?? null,
    p_captured_at: capturedAt,
  })
  if (error) throw new GbpDataError('Could not save GBP review-health snapshot.')
}
