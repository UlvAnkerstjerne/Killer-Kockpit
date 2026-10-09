import { getCreativeIntelligence } from '@/lib/actions/marketing/creative-intelligence'
import { getPaidStrategy } from '@/lib/actions/marketing/paid-strategy'
import { getStrategyImplementations } from '@/lib/actions/marketing/paid-strategy-implementation'
import BrainView from './BrainView'
import PaidStrategyButton from './PaidStrategyButton'
import PaidStrategySection from './PaidStrategySection'
import RefreshButton from './RefreshButton'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'CMO | Killer Kockpit' }

export default async function MarketingBrainPage() {
  const [data, strategy, implementations] = await Promise.all([getCreativeIntelligence(), getPaidStrategy(), getStrategyImplementations()])
  return <BrainView
    data={data}
    refreshControl={data.canRefresh ? <RefreshButton /> : null}
    paidStrategy={<PaidStrategySection data={strategy} implementations={implementations} generateControl={strategy.canGenerate ? <PaidStrategyButton /> : null} />}
  />
}
