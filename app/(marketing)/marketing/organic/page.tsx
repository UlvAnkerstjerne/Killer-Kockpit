import { getOrganicPerformance } from '@/lib/actions/marketing/organic-performance'
import OrganicClient from './OrganicClient'

export const dynamic = 'force-dynamic'

export default async function OrganicPage() {
  const data = await getOrganicPerformance()
  return <OrganicClient data={data} />
}
