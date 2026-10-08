import { getCreativeIntelligence } from '@/lib/actions/marketing/creative-intelligence'
import { getPaidStrategy } from '@/lib/actions/marketing/paid-strategy'
import BrainView from './BrainView'
import PaidStrategyButton from './PaidStrategyButton'
import PaidStrategySection from './PaidStrategySection'
import RefreshButton from './RefreshButton'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Marketing Brain | Killer Kockpit' }

export default async function MarketingBrainPage() {
  const [data, strategy] = await Promise.all([getCreativeIntelligence(), getPaidStrategy()])
  return <BrainView
    data={data}
    refreshControl={data.canRefresh ? <RefreshButton /> : null}
    paidStrategy={<PaidStrategySection data={strategy} generateControl={strategy.canGenerate ? <PaidStrategyButton /> : null} />}
  />
}
