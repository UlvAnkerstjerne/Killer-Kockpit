import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { InsightsData } from '@/lib/actions/marketing/insights'
import {
  DOMAIN_LABEL, KIND_LABEL, STRENGTH_LABEL, TREND_LABEL, type InsightKind, type InsightStrength, type InsightTrend, type SourceRef,
} from '@/lib/marketing/insights/types'
import { clip } from '@/lib/marketing/insights/text'
import { KIND_ORDER, linkedRecommendations, splitInsights, type InsightView } from '@/lib/marketing/insights/view'
import { instagramLink } from './BrainView'
import CaptureInsightsButton from './CaptureInsightsButton'

/** Long statements are shortened on the card for scanning; the full text stays one click away. */
const STATEMENT_PREVIEW_CHARS = 300
const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

const STRENGTH_TONE: Record<InsightStrength, string> = {
  strong_pattern: 'bg-[#EEF6EF] text-[#4F7A5A]', reasonable_inference: 'bg-[#EEF5FF] text-[#3B6FA8]',
  weak_signal: 'bg-kk-soft text-kk-muted', hypothesis: 'bg-[#F5F1EB] text-[#7B664E]',
}
const TREND_TONE: Record<InsightTrend, string> = {
  new: 'bg-kk-brand/10 text-kk-brand', strengthening: 'bg-[#EEF6EF] text-[#4F7A5A]', steady: 'bg-kk-soft text-kk-muted',
  weakening: 'bg-[#FFF1EC] text-[#C95A35]', unconfirmed: 'border border-kk-line text-kk-muted',
}
const GROUP_TITLE: Record<InsightKind, { title: string; note: string }> = {
  finding: { title: 'What we’ve learned', note: 'Conclusions the analyses reached, with the evidence behind each and how they have held up.' },
  content_opportunity: { title: 'Content opportunities', note: 'Subjects worth making content about. The angle is an idea to try, never a result.' },
  retargeting_hypothesis: { title: 'Retargeting hypotheses', note: 'Ideas about people who already know us. Audience and targeting data are not stored, so these cannot be checked against current data.' },
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${tone}`}>{children}</span>
}

function SourceLine({ source }: { source: SourceRef }) {
  if (source.type === 'instagram_post') {
    const link = instagramLink(source.permalink)
    const text = `Instagram ${source.media_type === 'reel_video' ? 'Reel' : 'post'}${source.published_at ? ` · ${day(source.published_at)}` : ''}${source.ref ? ` (${source.ref})` : ''}`
    return <li>{link ? <a href={link} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{text} ↗</a> : text}</li>
  }
  if (source.type === 'creative_signal') return <li>Creative signal · {source.sample_size} post{source.sample_size === 1 ? '' : 's'} · {source.evidence_level}</li>
  return <li>Paid Strategy analysis · {day(source.window_start)} to {day(source.window_end)} · recommendation {source.index + 1}</li>
}

function InsightCard({ insight, strategy, implementations }: { insight: InsightView; strategy: PaidStrategyData; implementations: StrategyImplementationData }) {
  const linked = linkedRecommendations(insight, strategy, implementations)
  const history = insight.history.slice(0, 6)
  const clipped = insight.statement.length > STATEMENT_PREVIEW_CHARS
  return <article data-insight data-kind={insight.kind} className="rounded-2xl border border-kk-line bg-kk-panel p-5">
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto text-[11px] font-semibold uppercase tracking-wide text-kk-muted">{DOMAIN_LABEL[insight.domain]} · {KIND_LABEL[insight.kind]}</p>
      <Chip tone={STRENGTH_TONE[insight.strength]}>{STRENGTH_LABEL[insight.strength]}</Chip>
      <Chip tone={TREND_TONE[insight.trend]}>{TREND_LABEL[insight.trend]}</Chip>
    </div>
    <h3 className="mt-3 text-base font-semibold leading-snug">{insight.title}</h3>
    <p data-statement className="mt-2 text-sm leading-relaxed">{clipped ? clip(insight.statement, STATEMENT_PREVIEW_CHARS) : insight.statement}</p>
    {insight.suggestion ? <p className="mt-3 text-sm leading-relaxed"><span className="block text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Suggested angle · an idea to try, not a result</span>{insight.suggestion}</p> : null}
    {linked.length ? <ul className="mt-3 space-y-1 text-xs text-kk-muted">{linked.map(l => <li key={`${l.runId}-${l.index}`}>
      Behind recommendation: <span className="font-medium text-kk-ink">{l.title}</span> · {l.state}</li>)}</ul> : null}
    <details className="group mt-4 border-t border-kk-line pt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-kk-muted hover:text-kk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kk-brand [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">▸</span>
        <span className="group-open:hidden">Evidence &amp; history</span><span className="hidden group-open:inline">Hide evidence &amp; history</span>
      </summary>
      <dl className="mt-3 space-y-3 text-sm leading-relaxed">
        {clipped ? <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Full statement</dt><dd className="mt-0.5">{insight.statement}</dd></div> : null}
        {insight.evidence_text ? <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Evidence · from our data</dt><dd className="mt-0.5">{insight.evidence_text}</dd></div> : null}
        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Uncertainty</dt>
          <dd className="mt-0.5 text-kk-muted">{insight.limitations ?? 'No limits were recorded for this insight.'}{insight.strength === 'hypothesis' ? ' This is an untested hypothesis, not an observed result.' : ''}</dd></div>
        {insight.refs.length ? <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">Sources</dt>
          <dd className="mt-0.5"><ul className="space-y-0.5">{insight.refs.map((source, i) => <SourceLine key={i} source={source} />)}</ul></dd></div> : null}
        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-kk-muted">History</dt>
          <dd className="mt-0.5 text-kk-muted">
            First seen {day(insight.first_seen_at)} · seen in {insight.times_observed} run{insight.times_observed === 1 ? '' : 's'} · last supported {day(insight.last_supported_at)}
            {insight.runs_since_seen > 0 ? ` · not reproduced in the last ${insight.runs_since_seen} run${insight.runs_since_seen === 1 ? '' : 's'}` : ''}
            {history.length > 1 ? <ul className="mt-1 space-y-0.5">{history.map((h, i) => <li key={i}>{day(h.observed_at)} · {STRENGTH_LABEL[h.strength]} · {h.change}</li>)}</ul> : null}
          </dd></div>
      </dl>
    </details>
  </article>
}

/**
 * The accumulated, durable insights from the specialist analyses. Read-only here: insights are written when an analysis
 * finishes (or by the SUPER_ADMIN capture button). Recommendations and their decisions keep living in the Paid Strategy section;
 * an insight only points at them.
 */
export default function InsightsSection({ data, strategy, implementations }: { data: InsightsData; strategy: PaidStrategyData; implementations: StrategyImplementationData }) {
  if (!data.allowed) return null
  if (data.error) return data.canCapture ? <p role="status" className="text-sm text-kk-muted">{data.error}</p> : null
  const { active, stale } = splitInsights(data.insights)
  if (!data.insights.length && !data.canCapture) return null
  return <section aria-labelledby="insights-title" data-cmo-insights className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="insights-title" className="text-xl font-semibold">Insights</h2>
        <p className="mt-1 max-w-2xl text-sm text-kk-muted">What the analyses have learned so far, kept across runs. Each insight shows its evidence, how sure we are, and whether later runs back it up.</p>
      </div>
      {data.canCapture ? <CaptureInsightsButton label={data.insights.length ? 'Refresh from saved runs' : 'Capture insights from saved runs'} /> : null}
    </div>
    {!data.insights.length ? <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted">No insights have been captured yet. They are saved automatically after the next Paid Strategy or Creative Intelligence analysis; capture from saved runs to include earlier ones.</p> : null}
    {KIND_ORDER.map(kind => {
      const items = active.filter(i => i.kind === kind)
      if (!items.length) return null
      return <div key={kind} className="space-y-3">
        <div><h3 className="text-base font-semibold">{GROUP_TITLE[kind].title}</h3><p className="text-xs text-kk-muted">{GROUP_TITLE[kind].note}</p></div>
        <div className="grid items-start gap-4 lg:grid-cols-2">{items.map(i => <InsightCard key={i.id} insight={i} strategy={strategy} implementations={implementations} />)}</div>
      </div>
    })}
    {stale.length ? <details className="rounded-xl border border-kk-line p-4 text-sm">
      <summary className="cursor-pointer font-medium">Not seen recently ({stale.length})</summary>
      <p className="mt-2 text-xs text-kk-muted">Later analyses did not reproduce these. They are kept, not deleted, in case they come back.</p>
      <div className="mt-3 grid items-start gap-4 lg:grid-cols-2">{stale.map(i => <InsightCard key={i.id} insight={i} strategy={strategy} implementations={implementations} />)}</div>
    </details> : null}
  </section>
}
