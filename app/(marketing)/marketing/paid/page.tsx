import { getMetaCampaigns } from '@/lib/actions/marketing/meta-assets'
import PaidCampaignsClient from './PaidCampaignsClient'

export const dynamic = 'force-dynamic'

export default async function PaidPage() {
  const campaigns = await getMetaCampaigns()

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Paid</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Meta Ads performance across all active campaigns.
        </p>
      </div>
      <PaidCampaignsClient campaigns={campaigns} />
    </div>
  )
}
