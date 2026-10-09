import Link from 'next/link'
import type { BriefInsight } from '@/lib/marketing/insights/brief'
import { DOMAIN_LABEL, STRENGTH_LABEL } from '@/lib/marketing/insights/types'

/**
 * A short list on the Morning Brief: only insights that are new, important, or behind a decision the CMO section is asking for
 * (chosen by selectBriefInsights). Compact on purpose: the full evidence and history live on the CMO page.
 */
export default function BriefInsights({ items }: { items: BriefInsight[] }) {
  if (!items.length) return null
  return <section aria-labelledby="brief-insights-title" data-brief-insights className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id="brief-insights-title" className="text-xl font-semibold tracking-tight text-kk-ink">Worth knowing</h2>
      <Link href="/marketing/brain" className="text-sm text-kk-muted underline-offset-4 hover:text-kk-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand">All insights &rarr;</Link>
    </div>
    <ul className="divide-y divide-kk-line rounded-2xl border border-kk-line bg-kk-panel">
      {items.map(({ insight, label }) => <li key={insight.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <span className="shrink-0 rounded-full bg-kk-soft px-2 py-0.5 text-[10.5px] font-medium text-kk-muted">{label}</span>
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{insight.title}</span>
        <span className="shrink-0 text-xs text-kk-muted">{DOMAIN_LABEL[insight.domain]} · {STRENGTH_LABEL[insight.strength]}{insight.times_observed > 1 ? ` · seen in ${insight.times_observed} analyses` : ''}</span>
      </li>)}
    </ul>
  </section>
}
