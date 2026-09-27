import { getGbpReviews, getGbpLocations, getGbpStoreReviewSummary } from '@/lib/actions/marketing/gbp-reviews'
import { getGbpPerformance } from '@/lib/actions/marketing/gbp-performance'
import { getCurrentUser } from '@/lib/auth'
import { hasMarketingPermission } from '@/lib/permissions'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import GbpDashboard from './GbpDashboard'
import GbpPublishModal from './GbpPublishModal'

export const dynamic = 'force-dynamic'

export default async function GoogleBusinessProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; period?: string }>
}) {
  const params     = await searchParams
  const locationId = !params.location || params.location === 'all' ? null : params.location
  const days: 28 | 90 = params.period === '90' ? 90 : 28

  const [locations, reviews, performance, storeSummaries, user] = await Promise.all([
    getGbpLocations(),
    getGbpReviews(locationId ?? undefined),
    getGbpPerformance(locationId, days),
    getGbpStoreReviewSummary(),
    getCurrentUser(),
  ])

  const permissions = user ? await getUserMarketingPermissions(user.id) : []
  const canPublish = user ? hasMarketingPermission(user.role, permissions, 'content_manage') : false

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Google Business Profile</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            Performance data and review management for all Killer Kebab locations.
          </p>
        </div>
        {canPublish && <GbpPublishModal locations={locations} />}
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
