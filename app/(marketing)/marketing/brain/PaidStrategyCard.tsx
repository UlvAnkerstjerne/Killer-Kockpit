import type { ReactNode } from 'react'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import ImplementationControl from './ImplementationControl'
import type { PaidStrategyRecommendationType, PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'
import { compactSummary } from '@/lib/marketing/paid-strategy/summary'

const TYPE_LABELS: Record<PaidStrategyRecommendationType, string> = {
  campaign_structure: 'Campaign structure', retargeting: 'Retargeting', audience: 'Audience', creative: 'Creative',
  copy: 'Copy', budget: 'Budget', tracking: 'Tracking', funnel: 'Funnel',
}
export const money = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n)
export const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

function Field({ label, children, tone = 'default' }: { label: string; children: ReactNode; tone?: 'default' | 'muted' }) {
  return <div>
    <dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{label}</dt>
    <dd className={`mt-0.5 text-sm leading-relaxed ${tone === 'muted' ? 'text-kk-muted' : ''}`}>{children}</dd>
  </div>
}

export type StoredRecommendation = PaidStrategyRun['recommendations'][number]

/**
 * Collapsed by default: what Brain suggests, why, and whether extra budget is involved. The implementation state and the
 * Reject / Approve controls stay visible; every detailed field is still there, unchanged, behind "Read more".
 * A native <details> keeps it keyboard accessible with no client code, and each card opens independently.
 */
export function StrategyCard({ rec, rank, footer }: { rec: StoredRecommendation; rank: number; footer?: ReactNode }) {
  // New runs carry plain-language copy written for the card. Older runs never had it and are never rewritten: they keep their
  // own title and a deterministic summary of the stored text.
  const human = rec.display_title && rec.display_summary ? { title: rec.display_title, summary: rec.display_summary } : null
  const { action, reason } = human ? { action: null, reason: null } : compactSummary(rec)
  const budget = rec.incremental_budget_dkk
  return <article className="rounded-2xl border border-kk-line bg-kk-panel p-5">
    <div className="flex items-start justify-between gap-3">
      <h3 className="text-base font-semibold leading-snug">{rank}. {human ? human.title : rec.title}</h3>
      <span className="shrink-0 rounded-full bg-kk-soft px-2.5 py-1 text-[11px] font-medium text-kk-muted">{TYPE_LABELS[rec.recommendation_type] ?? rec.recommendation_type}</span>
    </div>
    <p data-summary className="mt-3 text-sm leading-relaxed">{human ? human.summary : <>{action}{action && reason ? ' ' : null}<span className="text-kk-muted">{reason}</span></>}</p>
    {typeof budget === 'number'
      ? <p className="mt-3"><span data-budget className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-medium ${budget > 0 ? 'bg-kk-brand/10 text-kk-brand' : 'bg-kk-soft text-kk-muted'}`}>{budget > 0 ? `+${money(budget)} DKK test budget` : 'No extra spend'}</span></p> : null}
    {footer}
    <details className="group mt-4 border-t border-kk-line pt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-kk-muted hover:text-kk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">▸</span>
        <span className="group-open:hidden">Read more</span><span className="hidden group-open:inline">Show less</span>
      </summary>
      <dl className="mt-3 space-y-3">
        {human ? <Field label="Full title">{rec.title}</Field> : null}
        <Field label="Facts · from our data">{rec.evidence}</Field>
        <Field label="Interpretation · inference, not fact">{rec.interpretation}</Field>
        <Field label="Hypothesis">{rec.hypothesis}</Field>
        <Field label="Test or action">{rec.exact_test_or_action}</Field>
        {typeof budget === 'number'
          ? <Field label="Extra budget needed">{budget > 0 ? `${money(budget)} DKK on top of existing spend` : 'None (no extra spend)'}</Field> : null}
        <Field label="Success metric">{rec.success_metric}</Field>
        <Field label="Evidence limitations" tone="muted">{rec.evidence_limitations}</Field>
      </dl>
    </details>
  </article>
}


/**
 * One recommendation with its implementation / rejection state and the SAME controls everywhere it is shown (the CMO page,
 * previous runs, and the Morning Brief). The state and every action live in the one implementation row for
 * (run, recommendation), so acting here or there is the same thing. Controls are omitted when the state is unavailable.
 */
export function RecommendationCard({ rec, rank, runId, index, superseded, implementations }: {
  rec: StoredRecommendation; rank: number; runId: string; index: number; superseded: boolean; implementations?: StrategyImplementationData
}) {
  const footer = implementations && !implementations.error
    ? <ImplementationControl runId={runId} index={index} canApprove={implementations.canApprove} superseded={superseded} title={rec.title}
        view={implementations.views.find(v => v.strategyRunId === runId && v.recommendationIndex === index)} />
    : null
  return <StrategyCard rec={rec} rank={rank} footer={footer} />
}
