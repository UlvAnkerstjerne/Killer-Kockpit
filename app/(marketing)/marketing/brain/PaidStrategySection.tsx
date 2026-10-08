import type { ReactNode } from 'react'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { PaidStrategyRecommendation, PaidStrategyRecommendationType, PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'

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

function StrategyCard({ rec, rank }: { rec: PaidStrategyRecommendation; rank: number }) {
  return <article className="rounded-2xl border border-kk-line bg-kk-panel p-5">
    <div className="flex items-start justify-between gap-3">
      <h3 className="text-base font-semibold leading-snug">{rank}. {rec.title}</h3>
      <span className="shrink-0 rounded-full bg-kk-soft px-2.5 py-1 text-[11px] font-medium text-kk-muted">{TYPE_LABELS[rec.recommendation_type] ?? rec.recommendation_type}</span>
    </div>
    <dl className="mt-4 space-y-3">
      <Field label="Facts · from our data">{rec.evidence}</Field>
      <Field label="Interpretation · inference, not fact">{rec.interpretation}</Field>
      <Field label="Hypothesis">{rec.hypothesis}</Field>
      <Field label="Test or action">{rec.exact_test_or_action}</Field>
      <Field label="Success metric">{rec.success_metric}</Field>
      <Field label="Evidence limitations" tone="muted">{rec.evidence_limitations}</Field>
    </dl>
  </article>
}

function RunMeta({ run }: { run: PaidStrategyRun }) {
  const budget = run.evidence?.budget
  return <p className="text-xs text-kk-muted">
    Generated {day(run.generated_at)} · Meta Ads {day(run.window_start)} to {day(run.window_end)} · {run.skill_ref}{run.model ? ` · ${run.model}` : ''}
    {budget?.monthly_ceiling != null && budget.month_to_date_spend != null
      ? <> · Month to date {money(budget.month_to_date_spend)} of the {money(budget.monthly_ceiling)} {budget.currency ?? 'DKK'} ceiling (a hard cap, not a target)</> : null}
  </p>
}

export default function PaidStrategySection({ data, generateControl }: { data: PaidStrategyData; generateControl?: ReactNode }) {
  if (!data.allowed) return null
  const run = data.latest
  return <section aria-labelledby="paid-strategy-title" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="paid-strategy-title" className="text-xl font-semibold">Paid strategy</h2>
        <p className="mt-1 text-xs text-kk-muted">Meta Ads · MESPER method · advisory only · up to 3 ideas worth testing next</p>
      </div>
      {data.canGenerate ? generateControl : null}
    </div>

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
          ? <div className="grid gap-4 lg:grid-cols-3">{run.recommendations.map((rec, i) => <StrategyCard key={`${i}-${rec.title}`} rec={rec} rank={i + 1} />)}</div>
          : <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted">The analysis found nothing worth recommending from the current data.</p>}
        {run.evidence?.data_gaps?.length ? <details className="rounded-xl border border-kk-line p-4 text-sm">
          <summary className="cursor-pointer font-medium">What this analysis could not see</summary>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-kk-muted">{run.evidence.data_gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        </details> : null}
        {data.previous.length ? <details className="rounded-xl border border-kk-line p-4 text-sm">
          <summary className="cursor-pointer font-medium">Previous runs ({data.previous.length})</summary>
          <div className="mt-3 space-y-3">{data.previous.map(prev => <details key={prev.id} className="rounded-lg border border-kk-line p-3">
            <summary className="cursor-pointer">{day(prev.generated_at)} · {prev.recommendations.length} recommendation{prev.recommendations.length === 1 ? '' : 's'} · {prev.skill_ref}</summary>
            <div className="mt-3 grid gap-4 lg:grid-cols-3">{prev.recommendations.map((rec, i) => <StrategyCard key={`${prev.id}-${i}`} rec={rec} rank={i + 1} />)}</div>
          </details>)}</div>
        </details> : null}
      </>}
      <p className="text-xs text-kk-muted">Advisory only. Nothing here changes a campaign. Operational changes still go through Paid Recommendations and Needs Review.</p>
    </>}
  </section>
}
