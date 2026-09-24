import { getCreativeIntelligence } from '@/lib/actions/marketing/creative-intelligence'
import BrainView from './BrainView'
import RefreshButton from './RefreshButton'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Marketing Brain | Killer Kockpit' }

export default async function MarketingBrainPage() {
  const data = await getCreativeIntelligence()
  return <BrainView data={data} refreshControl={data.canRefresh ? <RefreshButton /> : null} />
}
