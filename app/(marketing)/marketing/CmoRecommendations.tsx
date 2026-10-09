import Link from 'next/link'
import { RecommendationCard } from './brain/PaidStrategyCard'
import type { CmoBriefData } from '@/lib/marketing/paid-strategy/implementation/surface'

/**
 * "CMO recommendations" on the Morning Brief: the current Paid Strategy ideas that still need a decision or an action.
 * It renders the same RecommendationCard (and so the same ImplementationControl, dialogs, server actions and permissions) as
 * the CMO page. Nothing here is stored in the brief: the data is read live at render time and the section is omitted when
 * there is nothing to act on (no empty-state card).
 */
export default function CmoRecommendations({ data }: { data: CmoBriefData }) {
  return <section aria-labelledby="cmo-recs-title" data-cmo-recommendations className="space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id="cmo-recs-title" className="text-3xl font-black tracking-tight text-kk-ink leading-none">CMO recommendations</h2>
      <Link href="/marketing/brain" className="text-sm text-kk-muted underline-offset-4 hover:text-kk-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">Open CMO &rarr;</Link>
    </div>
    <div className="grid items-start gap-4 grid-cols-1 lg:grid-cols-3">
      {data.items.map(({ rec, index }) => <RecommendationCard key={`${data.run.id}-${index}`} rec={rec} rank={index + 1} runId={data.run.id} index={index} superseded={false} implementations={data.implementations} />)}
    </div>
  </section>
}
