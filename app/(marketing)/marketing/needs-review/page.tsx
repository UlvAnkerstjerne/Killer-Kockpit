import { getMarketingPendingReviews } from '@/lib/actions/marketing/review-items'
import NeedsReviewClient from './NeedsReviewClient'

export const dynamic = 'force-dynamic'

export default async function NeedsReviewPage() {
  // getMarketingPendingReviews() self-authenticates — it calls getCurrentUser()
  // internally and resolves role + permissions from authenticated server state.
  // No authorization context is accepted from this page or from the browser.
  const items = await getMarketingPendingReviews()

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Needs Review</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Marketing actions waiting for your approval.
        </p>
      </div>
      <NeedsReviewClient items={items} />
    </div>
  )
}
