import { getCreativeIntelligence } from '@/lib/actions/marketing/creative-intelligence'
import { getMarketingInsights } from '@/lib/actions/marketing/insights'
import { getPaidStrategy } from '@/lib/actions/marketing/paid-strategy'
import { getStrategyImplementations } from '@/lib/actions/marketing/paid-strategy-implementation'
import BrainView from './BrainView'
import InsightsSection from './InsightsSection'
import PaidStrategyButton from './PaidStrategyButton'
import PaidStrategySection from './PaidStrategySection'
import RefreshButton from './RefreshButton'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'CMO | Killer Kockpit' }

export default async function MarketingBrainPage() {
  const [data, strategy, implementations, insights] = await Promise.all([getCreativeIntelligence(), getPaidStrategy(), getStrategyImplementations(), getMarketingInsights()])
  return <BrainView
    data={data}
    refreshControl={data.canRefresh ? <RefreshButton /> : null}
    paidStrategy={<PaidStrategySection data={strategy} implementations={implementations} generateControl={strategy.canGenerate ? <PaidStrategyButton /> : null} />}
    insights={<InsightsSection data={insights} strategy={strategy} implementations={implementations} />}
  />
}
