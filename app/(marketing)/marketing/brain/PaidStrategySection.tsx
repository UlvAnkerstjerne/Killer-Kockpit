import type { ReactNode } from 'react'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import ImplementationControl from './ImplementationControl'
import type { PaidStrategyRecommendationType, PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'
import { compactSummary } from '@/lib/marketing/paid-strategy/summary'

const TYPE_LABELS: Record<PaidStrategyRecommendationType, string> = {
  campaign_structure: 'Campaign structure', retargeting: 'Retargeting', audience: 'Audience', creative: 'Creative',
  copy: 'Copy', budget: 'Budget', tracking: 'Tracking', funnel: 'Funnel',
}
const money = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n)
const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

function Field({ label, children, tone = 'default' }: { label: string; children: ReactNode; tone?: 'default' | 'muted' }) {
  return <div>
    <dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{label}</dt>
    <dd className={`mt-0.5 text-sm leading-relaxed ${tone === 'muted' ? 'text-kk-muted' : ''}`}>{children}</dd>
  </div>
}

type StoredRecommendation = PaidStrategyRun['recommendations'][number]

/**
 * Collapsed by default: what Brain suggests, why, and whether extra budget is involved. The implementation state and the
 * Reject / Approve controls stay visible; every detailed field is still there, unchanged, behind "Read more".
 * A native <details> keeps it keyboard accessible with no client code, and each card opens independently.
 */
function StrategyCard({ rec, rank, footer }: { rec: StoredRecommendation; rank: number; footer?: ReactNode }) {
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

function RunMeta({ run }: { run: PaidStrategyRun }) {
  const budget = run.evidence?.budget
  return <p className="text-xs text-kk-muted">
    Generated {day(run.generated_at)} · Meta Ads {day(run.window_start)} to {day(run.window_end)} · {run.skill_ref}{run.model ? ` · ${run.model}` : ''}
    {budget?.monthly_ceiling != null && budget.month_to_date_spend != null
      ? <> · Month to date {money(budget.month_to_date_spend)} of the {money(budget.monthly_ceiling)} {budget.currency ?? 'DKK'} ceiling (a hard cap, not a target)</> : null}
    {budget?.projection?.projected_month_end_spend != null
      ? <> · Projection: about {money(budget.projection.projected_month_end_spend)} by month end, {budget.projection.projected_incremental_headroom == null ? 'no reliable spare headroom' : `about ${money(budget.projection.projected_incremental_headroom)} ${budget.currency ?? 'DKK'} spare for new tests`}</> : null}
  </p>
}

export default function PaidStrategySection({ data, generateControl, implementations }: { data: PaidStrategyData; generateControl?: ReactNode; implementations?: StrategyImplementationData }) {
  if (!data.allowed) return null
  const run = data.latest
  const control = (runId: string, index: number, superseded: boolean, title: string) => implementations && !implementations.error
    ? <ImplementationControl runId={runId} index={index} canApprove={implementations.canApprove} superseded={superseded} title={title}
        view={implementations.views.find(v => v.strategyRunId === runId && v.recommendationIndex === index)} />
    : null
  return <section aria-labelledby="paid-strategy-title" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="paid-strategy-title" className="text-xl font-semibold">Paid strategy</h2>
        <p className="mt-1 text-xs text-kk-muted">Meta Ads · MESPER method · advisory only · up to 3 ideas worth testing next</p>
      </div>
      {data.canGenerate ? generateControl : null}
    </div>

    {implementations?.error ? <p role="alert" className="rounded-xl border border-kk-line bg-kk-panel p-4 text-sm">{implementations.error}</p> : null}
    {data.error ? <p role="alert" className="rounded-xl border border-kk-line bg-kk-panel p-4 text-sm">{data.error}</p> : <>
      {data.latestAttempt?.status === 'running' ? <p role="status" className="text-sm text-kk-muted">A Paid Strategy analysis is running. The last saved result remains available.</p> : null}
      {data.latestAttempt?.status === 'failed' ? <p role="alert" className="rounded-xl border border-kk-line bg-kk-panel p-4 text-sm">{data.latestAttempt.error} {run ? 'Showing the last saved result below.' : ''}</p> : null}

      {!run ? <div className="rounded-2xl border border-kk-line bg-kk-panel px-6 py-10">
        <h3 className="text-base font-semibold">No Paid Strategy analysis yet</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-kk-muted">Generate an analysis to get up to three strategic paid-media experiments based on the stored Meta Ads data. It never changes a campaign.</p>
        {!data.canGenerate ? <p className="mt-4 text-sm text-kk-muted">A SUPER_ADMIN can generate the first analysis.</p> : null}
      </div> : <>
        <RunMeta run={run} />
        {run.recommendations.length
          ? <div className="grid items-start gap-4 lg:grid-cols-3">{run.recommendations.map((rec, i) => <StrategyCard key={`${i}-${rec.title}`} rec={rec} rank={i + 1} footer={control(run.id, i, false, rec.title)} />)}</div>
          : <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted">The analysis found nothing worth recommending from the current data.</p>}
        {run.evidence?.data_gaps?.length ? <details className="rounded-xl border border-kk-line p-4 text-sm">
          <summary className="cursor-pointer font-medium">What this analysis could not see</summary>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-kk-muted">{run.evidence.data_gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        </details> : null}
        {data.previous.length ? <details className="rounded-xl border border-kk-line p-4 text-sm">
          <summary className="cursor-pointer font-medium">Previous runs ({data.previous.length})</summary>
          <div className="mt-3 space-y-3">{data.previous.map(prev => <details key={prev.id} className="rounded-lg border border-kk-line p-3">
            <summary className="cursor-pointer">{day(prev.generated_at)} · {prev.recommendations.length} recommendation{prev.recommendations.length === 1 ? '' : 's'} · {prev.skill_ref}</summary>
            <div className="mt-3 grid items-start gap-4 lg:grid-cols-3">{prev.recommendations.map((rec, i) => <StrategyCard key={`${prev.id}-${i}`} rec={rec} rank={i + 1} footer={control(prev.id, i, true, rec.title)} />)}</div>
          </details>)}</div>
        </details> : null}
      </>}
      <p className="text-xs text-kk-muted">Advisory only. Nothing here changes a campaign. Operational changes still go through Paid Recommendations and Needs Review.{implementations?.canApprove ? ' "Approve & implement" lets Kockpit do the work itself after you confirm: everything it creates in Meta is paused until you activate it, and it stops only for an access it lacks, a decision only you can make, or a physical act.' : null}</p>
    </>}
  </section>
}
