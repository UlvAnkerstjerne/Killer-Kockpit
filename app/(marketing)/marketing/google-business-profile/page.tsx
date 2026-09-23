import { getGbpReviews, getGbpLocations, getGbpStoreReviewSummary } from '@/lib/actions/marketing/gbp-reviews'
import { getGbpPerformance } from '@/lib/actions/marketing/gbp-performance'
import GbpDashboard from './GbpDashboard'

export const dynamic = 'force-dynamic'

export default async function GoogleBusinessProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; period?: string }>
}) {
  const params     = await searchParams
  const locationId = !params.location || params.location === 'all' ? null : params.location
  const days: 28 | 90 = params.period === '90' ? 90 : 28

  const [locations, reviews, performance, storeSummaries] = await Promise.all([
    getGbpLocations(),
    getGbpReviews(locationId ?? undefined),
    getGbpPerformance(locationId, days),
    getGbpStoreReviewSummary(),
  ])

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Google Business Profile</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Performance data and review management for all Killer Kebab locations.
        </p>
      </div>
      <GbpDashboard
        locations={locations}
        selectedLocationId={locationId}
        days={days}
        performance={performance}
        reviews={reviews}
        storeSummaries={storeSummaries}
      />
    </div>
  )
}
