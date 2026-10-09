import type { ReactNode } from 'react'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import ImplementationControl from './ImplementationControl'
import type { PaidStrategyRecommendationType, PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'
import { compactSummary } from '@/lib/marketing/paid-strategy/summary'

const TYPE_LABELS: Record<PaidStrategyRecommendationType, string> = {
  campaign_structure: 'Campaign', retargeting: 'Retargeting', audience: 'Audience', creative: 'Creative',
  copy: 'Copy', budget: 'Budget', tracking: 'Tracking', funnel: 'Funnel',
}
/**
 * Visual treatment only (no logic): a subtly tinted header with a small icon, keyed by recommendation_type so the cards are
 * quicker to scan. Class names are written out in full so Tailwind can see them. Unknown types fall back to a neutral style.
 */
type TypeStyle = { header: string; line: string; accent: string; tile: string; icon: ReactNode }
const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
const ICONS = {
  target: svg(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" /></>),
  spark: svg(<><path d="M10 4l1.9 5.1L17 11l-5.1 1.9L10 18l-1.9-5.1L3 11l5.1-1.9z" /><path d="M18.5 3.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>),
  funnel: svg(<path d="M3 4.5h18l-7 8.2V19l-4 2v-8.3z" />),
  layers: svg(<><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 12.5l9 5 9-5" /><path d="M3 16.8l9 5 9-5" /></>),
  users: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><circle cx="17.5" cy="9" r="2.5" /><path d="M17.5 14c2.4 0 4 1.7 4 4.5" /></>),
  wallet: svg(<><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19v14H5.5A2.5 2.5 0 0 1 3 16.5z" /><path d="M19 9.5h2v5h-2a2.5 2.5 0 0 1 0-5z" /></>),
  compass: svg(<><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></>),
}
const TONES = {
  blue:   { header: 'bg-[#EEF5FF]', line: 'border-[#3B6FA8]/15', accent: 'text-[#3B6FA8]', tile: 'bg-[#3B6FA8]/12' },
  coral:  { header: 'bg-[#FFF1EC]', line: 'border-[#C95A35]/15', accent: 'text-[#C95A35]', tile: 'bg-[#C95A35]/12' },
  green:  { header: 'bg-[#EEF6EF]', line: 'border-[#4F7A5A]/15', accent: 'text-[#4F7A5A]', tile: 'bg-[#4F7A5A]/12' },
  plum:   { header: 'bg-[#F4F0FA]', line: 'border-[#745D8C]/15', accent: 'text-[#745D8C]', tile: 'bg-[#745D8C]/12' },
  ochre:  { header: 'bg-[#FFF8E5]', line: 'border-[#9B762B]/15', accent: 'text-[#9B762B]', tile: 'bg-[#9B762B]/12' },
  kraft:  { header: 'bg-[#F5F1EB]', line: 'border-[#7B664E]/15', accent: 'text-[#7B664E]', tile: 'bg-[#7B664E]/12' },
  neutral:{ header: 'bg-[#F3F1EE]', line: 'border-[#6B665F]/15', accent: 'text-[#6B665F]', tile: 'bg-[#6B665F]/12' },
}
const TYPE_STYLES: Record<string, TypeStyle> = {
  tracking:           { ...TONES.blue,  icon: ICONS.target },
  creative:           { ...TONES.coral, icon: ICONS.spark },
  copy:               { ...TONES.coral, icon: ICONS.spark },   // messaging belongs with creative
  funnel:             { ...TONES.green, icon: ICONS.funnel },
  retargeting:        { ...TONES.green, icon: ICONS.funnel },  // a path back through the funnel
  campaign_structure: { ...TONES.plum,  icon: ICONS.layers },
  audience:           { ...TONES.ochre, icon: ICONS.users },
  budget:             { ...TONES.kraft, icon: ICONS.wallet },
}
const FALLBACK_STYLE: TypeStyle = { ...TONES.neutral, icon: ICONS.compass }
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
  const look = TYPE_STYLES[rec.recommendation_type] ?? FALLBACK_STYLE
  return <article className="overflow-hidden rounded-2xl border border-kk-line bg-kk-panel">
    <div data-card-header data-type={rec.recommendation_type} className={`flex items-start gap-2.5 border-b px-4 py-3 ${look.header} ${look.line}`}>
      <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${look.tile} ${look.accent}`}>{look.icon}</span>
      <h3 className="min-w-0 flex-1 text-base font-semibold leading-snug">{rank}. {human ? human.title : rec.title}</h3>
      <span className={`shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-medium ${look.accent}`}>{TYPE_LABELS[rec.recommendation_type] ?? rec.recommendation_type}</span>
    </div>
    <div className="p-5 pt-4">
    <p data-summary className="text-sm leading-relaxed">{human ? human.summary : <>{action}{action && reason ? ' ' : null}<span className="text-kk-muted">{reason}</span></>}</p>
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
    </div>
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
