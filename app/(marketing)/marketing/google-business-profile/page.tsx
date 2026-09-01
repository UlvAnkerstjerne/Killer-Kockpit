import { getGbpReviews, getGbpLocations } from '@/lib/actions/marketing/gbp-reviews'
import GbpReviewsClient from './GbpReviewsClient'

export const dynamic = 'force-dynamic'

export default async function GoogleBusinessProfilePage() {
  const [reviews, locations] = await Promise.all([
    getGbpReviews(),
    getGbpLocations(),
  ])

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Google Business Profile</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Reviews from all Killer Kebab locations — AI-drafted replies, awaiting your approval.
        </p>
      </div>
      <GbpReviewsClient reviews={reviews} locations={locations} />
    </div>
  )
}
