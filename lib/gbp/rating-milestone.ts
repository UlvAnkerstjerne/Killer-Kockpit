/** Arithmetic estimate only: assumes the supplied mean is exact and ordinary
 * rounding to the nearest tenth. Google's display algorithm is not asserted.
 * A one-decimal input cannot support this estimate, so return unavailable. */
export function estimateRatingMilestone(average: number | null, count: number | null): { fiveStarReviews: number; displayedRating: number; targetDisplayedRating: number } | null {
  if (average === null || count === null || !Number.isFinite(average) || average < 1 || average >= 5 || !Number.isSafeInteger(count) || count <= 0) return null
  if (Math.abs(average * 10 - Math.round(average * 10)) < 1e-9) return null
  const displayed = Math.round(average * 10) / 10
  const target = (Math.round(average * 10) + 1) / 10
  if (target > 5) return null
  const threshold = target - 0.05
  const estimate = Math.ceil((count * (threshold - average)) / (5 - threshold) - 1e-9)
  if (!Number.isSafeInteger(estimate) || estimate < 1) return null
  return { fiveStarReviews: estimate, displayedRating: displayed, targetDisplayedRating: target }
}
