import { getCurrentUser } from '@/lib/auth'
import {
  getLatestMorningBrief,
  getLastReadyMorningBrief,
} from '@/lib/actions/marketing/morning-brief'
import RegenerateButton from './RegenerateButton'
import type {
  MorningBriefRow,
  MorningBriefSections,
  BriefObservation,
  BriefMetricRow,
  TrendPoint,
} from '@/lib/marketing/brief/types'

export const dynamic = 'force-dynamic'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(isoDate: string): string {
  return new Date(isoDate + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

function formatTime(isoTs: string): string {
  return new Date(isoTs).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────────

export const SOURCE_LABELS: Record<string, string> = {
  meta_paid:       'Meta Paid',
  google_ads:      'Google Ads',
  organic_ig:      'Instagram',
  search_console:  'Search',
  ga4:             'Website',
  gbp_performance: 'Google Business Profile',
  data_health:     'Data Health',
}

/** Human-readable channel label for a signal source. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

/** Returns true when the observation should use a subdued/cautionary treatment. */
export function categoryIsDataHealth(category: string): boolean {
  return category === 'data_health'
}

/** Number of v2 observations stored in a sections payload. */
export function observationCount(sections: MorningBriefSections | null | undefined): number {
  return sections?.observations?.length ?? 0
}

/**
 * Returns true when a brief is v2 (has the observations field, even if empty).
 * v1 briefs have no observations field at all.
 * Relies on generate-brief.ts always setting sections.observations = [] for v2.
 */
export function isBriefV2(sections: MorningBriefSections | null | undefined): boolean {
  return sections?.observations !== undefined
}

/** Whether Needs Review block should be surfaced near the top of the page. */
export function needsReviewVisible(total: number): boolean {
  return total > 0
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CFG = {
  green: { label: 'Green', dot: 'bg-green-500',  pill: 'bg-kk-good-bg text-kk-good' },
  amber: { label: 'Amber', dot: 'bg-amber-400',  pill: 'bg-kk-warn-bg text-kk-warn' },
  red:   { label: 'Red',   dot: 'bg-red-500',    pill: 'bg-kk-bad-bg text-kk-bad'  },
} as const

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconWarning() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 1.5 13.5 13H0.5L7 1.5Z" fill="currentColor"/>
      <path d="M7 5.5v3" stroke="white" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
      <circle cx="7" cy="10.8" r="0.65" fill="white"/>
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function IconInstagram() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="4" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="13" cy="5" r="0.8" fill="currentColor"/>
    </svg>
  )
}

function IconFacebook() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M10.5 9h2l.5-2.5H10.5V5c0-.7.35-1.5 1.5-1.5H13V1.5C12.2 1.5 11 1.5 11 1.5 8.8 1.5 7.5 2.8 7.5 5.2V6.5H5.5V9h2v7.5h3V9Z" fill="currentColor"/>
    </svg>
  )
}

function IconCreditCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1.5" y="4" width="15" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M1.5 8h15" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M4.5 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function IconEye() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M1.5 9C1.5 9 4.5 4.5 9 4.5S16.5 9 16.5 9 13.5 13.5 9 13.5 1.5 9 1.5 9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  )
}

// ── StaleBanner ───────────────────────────────────────────────────────────────

function StaleBanner({ briefDate, reason }: { briefDate: string; reason: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 bg-kk-warn-bg border border-amber-200 rounded-xl text-xs text-kk-warn">
      <span className="font-semibold shrink-0">⚠ Showing brief from {formatDate(briefDate)}</span>
      <span className="opacity-80">{reason}</span>
    </div>
  )
}

// ── StatusStrip ───────────────────────────────────────────────────────────────
// Compact: status pill + reason inline + summary paragraph below.
// No large colored background — this is a brief, not a dashboard banner.

function StatusStrip({
  status, reason, summary,
}: {
  status: 'green' | 'amber' | 'red'
  reason: string | null
  summary: string | null
}) {
  const cfg = STATUS_CFG[status]
  return (
    <div>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} aria-hidden="true" />
          {cfg.label}
        </span>
        {reason && (
          <span className="text-sm text-kk-ink leading-snug">{reason}</span>
        )}
      </div>
    </div>
  )
}

// ── NeedsReviewBlock ──────────────────────────────────────────────────────────
// Surfaced near the top of the brief when there is actionable review work.

function NeedsReviewBlock({ needsReview }: { needsReview: MorningBriefSections['needs_review'] }) {
  if (!needsReviewVisible(needsReview.total)) return null
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 border-l-2 border-kk-brand bg-kk-bad-bg rounded-r-xl">
      <div className="min-w-0">
        <div className="text-xs font-bold tracking-[0.08em] uppercase text-kk-brand mb-1">
          Needs Review — {needsReview.total} item{needsReview.total !== 1 ? 's' : ''} awaiting approval
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          {needsReview.items.map((item, i) => (
            <span key={i} className="text-xs text-kk-muted">
              {item.count} {item.label}
            </span>
          ))}
        </div>
      </div>
      <a
        href="/marketing/needs-review"
        className="shrink-0 text-xs font-semibold text-kk-brand hover:underline whitespace-nowrap"
      >
        Review all →
      </a>
    </div>
  )
}

// ── ObservationItem ───────────────────────────────────────────────────────────
// Editorial numbered observation. data_health observations use quieter treatment.

function ObservationItem({
  obs,
  index,
  isLast,
}: {
  obs: BriefObservation
  index: number
  isLast: boolean
}) {
  // data_health observations signal data quality concerns, not marketing actions
  const isDataHealth = categoryIsDataHealth(obs.category ?? '')
  const label = obs.source ? sourceLabel(obs.source) : null

  return (
    <div
      data-observation-index={index}
      data-is-data-health={isDataHealth ? 'true' : undefined}
    >
      {/* Source label */}
      {label && (
        <div className={`text-[10px] font-bold tracking-[0.1em] uppercase mb-1 ${isDataHealth ? 'text-kk-muted/60' : 'text-kk-muted'}`}>
          {label}
        </div>
      )}

      {/* Headline */}
      <p className={`text-base leading-snug mb-1.5 ${
        isDataHealth
          ? 'text-kk-muted font-normal'
          : 'text-kk-ink font-semibold'
      }`}>
        {obs.observation}
      </p>

      {/* Evidence — plain text, no label prefix */}
      <p className={`text-xs leading-relaxed mb-2 ${isDataHealth ? 'text-kk-muted/70' : 'text-kk-muted'}`}>
        {obs.evidence}
      </p>

      {/* Recommended action */}
      {!isDataHealth && obs.recommended_action && (
        <p className="text-[13px] text-kk-ink leading-relaxed mb-2">
          → {obs.recommended_action}
        </p>
      )}

      {/* Why? — interpretation + creative_start behind optional expand */}
      {!isDataHealth && (obs.interpretation || obs.creative_start) && (
        <details className="group mt-1">
          <summary className="inline-flex items-center gap-0.5 text-[11px] font-medium text-kk-muted/70 cursor-pointer hover:text-kk-muted list-none select-none">
            <span>Why?</span>
            <span className="transition-transform group-open:rotate-180 inline-block"><IconChevronDown /></span>
          </summary>
          <div className="mt-2 space-y-2">
            {obs.interpretation && (
              <p className="text-[13px] text-kk-ink/80 leading-relaxed">{obs.interpretation}</p>
            )}
            {obs.creative_start && (
              <p className="text-[13px] text-kk-muted italic leading-relaxed">{obs.creative_start}</p>
            )}
          </div>
        </details>
      )}

      {/* Divider between items */}
      {!isLast && <hr className="mt-4 border-kk-line" />}
    </div>
  )
}

// ── WhatMattersTodaySection ───────────────────────────────────────────────────

function WhatMattersTodaySection({ observations }: { observations: BriefObservation[] }) {
  return (
    <div>
      <h2 className="text-[11px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-5">
        What matters today
      </h2>
      {observations.length === 0 ? (
        <p className="text-sm text-kk-muted" data-zero-observations="true">
          Nothing material needs your attention today.
        </p>
      ) : (
        <div className="space-y-4">
          {observations.map((obs, i) => (
            <ObservationItem
              key={obs.signal_id}
              obs={obs}
              index={i}
              isLast={i === observations.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Campaign table (legacy detail) ────────────────────────────────────────────

type CampaignSummary = MorningBriefSections['paid']['active_campaign_summaries'][number]

function CampaignTable({ campaigns }: { campaigns: CampaignSummary[] }) {
  if (campaigns.length === 0) return null
  return (
    <div className="rounded-xl border border-kk-line overflow-hidden mt-3">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 bg-kk-soft border-b border-kk-line">
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase text-kk-muted">Campaign</span>
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase text-kk-muted text-right">Goal</span>
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase text-kk-muted text-right">Yesterday</span>
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase text-kk-muted text-right">7 days</span>
      </div>
      {campaigns.map((c, i) => (
        <div
          key={i}
          className={`grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-4 py-2 border-t border-kk-line ${c.anomaly_flag ? 'bg-kk-warn-bg' : ''}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {c.anomaly_flag ? (
              <span className="shrink-0 text-kk-warn"><IconWarning /></span>
            ) : (
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-kk-line" />
            )}
            <span className={`text-xs truncate ${c.anomaly_flag ? 'text-kk-ink font-medium' : 'text-kk-ink'}`}>{c.name}</span>
          </div>
          <span className="text-xs tabular-nums shrink-0 text-kk-muted text-right">{c.goal_label ?? '—'}</span>
          <span className={`text-xs tabular-nums shrink-0 text-right ${c.anomaly_flag ? 'text-kk-warn font-medium' : 'text-kk-muted'}`}>{c.result_yesterday ?? '—'}</span>
          <span className={`text-xs tabular-nums shrink-0 text-right ${c.anomaly_flag ? 'text-kk-warn font-medium' : 'text-kk-muted'}`}>{c.result_7d ?? '—'}</span>
        </div>
      ))}
    </div>
  )
}

// ── Platform metrics (legacy detail) ─────────────────────────────────────────

function PlatformMetrics({ metrics }: { metrics: BriefMetricRow[] }) {
  if (metrics.length === 0) return <p className="text-xs text-kk-muted py-1">No data available.</p>
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 pt-2">
      {metrics.map((m, i) => (
        <div key={i} className="min-w-0">
          <div className="text-[10px] text-kk-muted mb-0.5">{m.label}</div>
          <div className="flex items-baseline gap-1.5">
            <span className={`text-xl font-bold tabular-nums leading-none ${m.highlight ? 'text-kk-warn' : 'text-kk-ink'}`}>{m.value}</span>
            {m.change && <span className="text-xs text-kk-muted">{m.change}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Sparkline (legacy detail) ─────────────────────────────────────────────────

function Sparkline({ points, stroke }: { points: TrendPoint[]; stroke: string }) {
  if (points.length < 2) return null
  const W = 80, H = 28, pad = 3
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  const coords: [number, number][] = points.map((p, i) => [
    (i / (points.length - 1)) * W,
    range === 0 ? H / 2 : pad + (H - 2 * pad) * (1 - (p.value - min) / range),
  ])
  const tension = 0.4
  let d = `M ${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(i - 1, 0)]
    const p1 = coords[i]
    const p2 = coords[i + 1]
    const p3 = coords[Math.min(i + 2, coords.length - 1)]
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden="true" className="opacity-70">
      <path d={d} stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── DetailsSection ────────────────────────────────────────────────────────────
// Secondary section — visually subordinate. Uses native <details> so no JS required.

function DetailsSection({ sections }: { sections: MorningBriefSections }) {
  const { paid, organic, gbp } = sections

  return (
    <div className="space-y-2">
      <h2 className="text-[11px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-3">
        Details
      </h2>

      {/* Paid */}
      <details className="group border border-kk-line rounded-xl overflow-hidden">
        <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none bg-kk-soft hover:bg-kk-line/40 select-none">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Paid</span>
            {paid.anomalies.length > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-kk-warn-bg text-kk-warn">
                {paid.anomalies.length} anomal{paid.anomalies.length === 1 ? 'y' : 'ies'}
              </span>
            )}
          </div>
          <span className="text-kk-muted transition-transform group-open:rotate-180"><IconChevronDown /></span>
        </summary>
        <div className="border-t border-kk-line px-4 py-4 space-y-3">
          <p className="text-xs text-kk-muted leading-relaxed">{paid.assessment}</p>
          {paid.anomalies.length > 0 && (
            <div className="space-y-1">
              {paid.anomalies.map((a, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-kk-warn">
                  <span className="shrink-0 mt-0.5"><IconWarning /></span>
                  <span>{a}</span>
                </div>
              ))}
            </div>
          )}
          {paid.active_campaign_summaries.length > 0 && (
            <CampaignTable campaigns={paid.active_campaign_summaries} />
          )}
          <a href="/marketing/paid" className="text-xs font-medium text-kk-brand hover:underline">
            View all campaigns →
          </a>
        </div>
      </details>

      {/* Organic */}
      <details className="group border border-kk-line rounded-xl overflow-hidden">
        <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none bg-kk-soft hover:bg-kk-line/40 select-none">
          <span className="text-sm font-semibold text-kk-ink">Organic</span>
          <span className="text-kk-muted transition-transform group-open:rotate-180"><IconChevronDown /></span>
        </summary>
        <div className="border-t border-kk-line px-4 py-4 space-y-4">
          <p className="text-xs text-kk-muted leading-relaxed">{organic.assessment}</p>

          {/* Instagram */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-kk-muted"><IconInstagram /></span>
              <span className="text-xs font-semibold text-kk-ink">Instagram</span>
            </div>
            <PlatformMetrics metrics={organic.ig.metrics} />
            {organic.ig.notable_posts.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {organic.ig.notable_posts.map((p, i) => (
                  <div key={i} className="flex items-baseline gap-2 text-xs text-kk-muted">
                    <span className="shrink-0">{p.media_type} {p.published_at.slice(0, 10)}</span>
                    {p.reach != null && <span>reach {p.reach.toLocaleString()}</span>}
                    {p.performance_label && <span className="font-medium">{p.performance_label}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Facebook */}
          {organic.fb.available && organic.fb.metrics.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-kk-muted"><IconFacebook /></span>
                <span className="text-xs font-semibold text-kk-ink">Facebook</span>
              </div>
              <PlatformMetrics metrics={organic.fb.metrics} />
            </div>
          )}

          <a href="/marketing/organic" className="text-xs font-medium text-kk-brand hover:underline">
            View organic analytics →
          </a>
        </div>
      </details>

      {/* Google Business Profile */}
      <details className="group border border-kk-line rounded-xl overflow-hidden">
        <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none bg-kk-soft hover:bg-kk-line/40 select-none">
          <span className="text-sm font-semibold text-kk-ink">Google Business Profile</span>
          <span className="text-kk-muted transition-transform group-open:rotate-180"><IconChevronDown /></span>
        </summary>
        <div className="border-t border-kk-line px-4 py-4 space-y-2">
          {gbp.integration_kind !== 'connected' && (
            <p className="text-xs text-kk-muted">
              {gbp.integration_kind === 'pending_approval'
                ? 'API approval pending — no GBP data available yet.'
                : 'Connected but sync has not yet run.'}
            </p>
          )}
          {gbp.assessment && (
            <p className="text-xs text-kk-muted leading-relaxed">{gbp.assessment}</p>
          )}
          {gbp.integration_kind === 'connected' && (
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 pt-1">
              {gbp.new_reviews_yesterday != null && (
                <div>
                  <div className="text-[10px] text-kk-muted">New reviews yesterday</div>
                  <div className="text-sm font-bold tabular-nums text-kk-ink">{gbp.new_reviews_yesterday}</div>
                </div>
              )}
              {gbp.avg_star_rating_7d != null && (
                <div>
                  <div className="text-[10px] text-kk-muted">Avg rating (7d)</div>
                  <div className="text-sm font-bold tabular-nums text-kk-ink">{gbp.avg_star_rating_7d.toFixed(1)} ★</div>
                </div>
              )}
              {gbp.pending_reply_count > 0 && (
                <div>
                  <div className="text-[10px] text-kk-muted">Pending replies</div>
                  <div className="text-sm font-bold tabular-nums text-kk-brand">{gbp.pending_reply_count}</div>
                </div>
              )}
            </div>
          )}
          <a href="/marketing/google-business-profile" className="text-xs font-medium text-kk-brand hover:underline">
            View GBP page →
          </a>
        </div>
      </details>
    </div>
  )
}

// ── LegacyKpiStrip (v1 backward compat) ──────────────────────────────────────

function LegacyKpiCard({
  metric, icon, iconBg, iconColor, sparkColor,
}: {
  metric: BriefMetricRow
  icon: React.ReactNode
  iconBg: string
  iconColor: string
  sparkColor: string
}) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 pt-4 pb-4 flex flex-col shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${iconBg} ${iconColor}`}>
          {icon}
        </div>
        <span className="text-xs text-kk-muted leading-tight">{metric.label}</span>
      </div>
      <div className={`text-[32px] font-bold tabular-nums leading-none tracking-tight mt-2 ${metric.highlight ? 'text-kk-warn' : 'text-kk-ink'}`}>
        {metric.value}
      </div>
      <div className="flex items-end justify-between mt-auto pt-2">
        <div className="text-xs text-kk-muted leading-none">{metric.change ?? ''}</div>
        {metric.trend && metric.trend.length >= 2 && (
          <Sparkline points={metric.trend} stroke={sparkColor} />
        )}
      </div>
    </div>
  )
}

function LegacyKpiStrip({ sections }: { sections: MorningBriefSections }) {
  type Slot = { metric: BriefMetricRow; icon: React.ReactNode; iconBg: string; iconColor: string; sparkColor: string }
  const candidates: Array<Slot | null> = [
    sections.paid.metrics[0]
      ? { metric: sections.paid.metrics[0], icon: <IconCreditCard />, iconBg: 'bg-kk-good-bg', iconColor: 'text-kk-good', sparkColor: '#2f6d4c' }
      : null,
    sections.paid.metrics[1]
      ? { metric: sections.paid.metrics[1], icon: <IconEye />, iconBg: 'bg-kk-soft', iconColor: 'text-kk-muted', sparkColor: '#8D795F' }
      : null,
    sections.organic.ig.metrics[0]
      ? { metric: sections.organic.ig.metrics[0], icon: <IconInstagram />, iconBg: 'bg-kk-soft', iconColor: 'text-kk-muted', sparkColor: '#8D795F' }
      : null,
    sections.organic.fb.metrics[0]
      ? { metric: sections.organic.fb.metrics[0], icon: <IconFacebook />, iconBg: 'bg-kk-soft', iconColor: 'text-kk-muted', sparkColor: '#B7A486' }
      : null,
  ]
  const slots = candidates.filter((s): s is Slot => s !== null)
  if (slots.length === 0) return null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {slots.map((s, i) => <LegacyKpiCard key={i} {...s} />)}
    </div>
  )
}

// ── LegacyBriefContent ────────────────────────────────────────────────────────
// Rendered when a brief has no observations (old v1 briefs). Keeps the existing
// dashboard layout intact — no data is lost.

function LegacyBriefContent({ sections }: { sections: MorningBriefSections }) {
  return (
    <div className="space-y-4" data-legacy-layout="true">
      <LegacyKpiStrip sections={sections} />
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-5">
        {/* Left column */}
        <div className="space-y-4">
          {/* Paid */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
            <div className="px-6 pt-5 pb-5">
              <h2 className="text-xl font-bold text-kk-ink mb-2">Paid</h2>
              <p className="text-[13px] text-kk-muted leading-snug mb-3">{sections.paid.assessment}</p>
              {sections.paid.anomalies.length > 0 && (
                <div className="space-y-1 mb-4">
                  {sections.paid.anomalies.map((a, i) => (
                    <div key={i} className="flex items-start gap-2 px-3 py-1.5 bg-kk-warn-bg border border-amber-200 rounded-lg">
                      <span className="shrink-0 mt-[3px] w-1.5 h-1.5 rounded-full bg-amber-400" />
                      <span className="text-[11px] text-kk-warn leading-snug">{a}</span>
                    </div>
                  ))}
                </div>
              )}
              {sections.paid.active_campaign_summaries.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-kk-ink mb-2">Active campaigns</h3>
                  <CampaignTable campaigns={sections.paid.active_campaign_summaries} />
                </div>
              )}
            </div>
            <div className="px-6 py-3 border-t border-kk-line">
              <a href="/marketing/paid" className="text-sm font-medium text-kk-brand hover:underline">View all campaigns →</a>
            </div>
          </div>
          {/* GBP */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-5">
            <h2 className="text-xl font-bold text-kk-ink mb-2">Google Business Profile</h2>
            {sections.gbp.assessment
              ? <p className="text-[13px] text-kk-muted leading-snug">{sections.gbp.assessment}</p>
              : <p className="text-[13px] text-kk-muted">{sections.gbp.integration_kind === 'pending_approval' ? 'API approval pending.' : 'Not yet connected.'}</p>
            }
            <div className="mt-3">
              <a href="/marketing/google-business-profile" className="text-sm font-medium text-kk-brand hover:underline">View GBP →</a>
            </div>
          </div>
        </div>
        {/* Right column */}
        <div className="space-y-4">
          {/* Organic */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
            <div className="px-6 pt-5 pb-4">
              <h2 className="text-xl font-bold text-kk-ink mb-2">Organic</h2>
              <p className="text-[13px] text-kk-muted leading-snug mb-3">{sections.organic.assessment}</p>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-kk-muted"><IconInstagram /></span>
                <span className="text-xs font-semibold text-kk-ink">Instagram</span>
              </div>
              <PlatformMetrics metrics={sections.organic.ig.metrics} />
              {sections.organic.fb.available && (
                <>
                  <div className="flex items-center gap-2 mt-4 mb-1">
                    <span className="text-kk-muted"><IconFacebook /></span>
                    <span className="text-xs font-semibold text-kk-ink">Facebook</span>
                  </div>
                  <PlatformMetrics metrics={sections.organic.fb.metrics} />
                </>
              )}
            </div>
            <div className="px-6 py-3 border-t border-kk-line">
              <a href="/marketing/organic" className="text-sm font-medium text-kk-brand hover:underline">View organic analytics →</a>
            </div>
          </div>
          {/* Needs Review */}
          {needsReviewVisible(sections.needs_review.total) && (
            <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
              <h2 className="text-sm font-semibold text-kk-ink mb-3">Needs Review</h2>
              <div className="space-y-2 mb-3">
                {sections.needs_review.items.map((item, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-kk-muted">{item.label}</span>
                    <span className="text-sm font-semibold tabular-nums text-kk-ink">{item.count}</span>
                  </div>
                ))}
              </div>
              <a href="/marketing/needs-review" className="text-sm text-kk-brand hover:underline">
                Review all {sections.needs_review.total} →
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── MorningBriefContent ───────────────────────────────────────────────────────
// Dispatches between v2 (observations) and v1 (legacy) layouts.

function MorningBriefContent({
  brief, isStale, staleReason,
}: {
  brief: MorningBriefRow
  isStale?: boolean
  staleReason?: string
}) {
  const sections = brief.sections_json
  // isBriefV2: observations field present (even if []) → v2; absent → v1 legacy
  const isV2 = isBriefV2(sections)

  return (
    <div className="space-y-5">
      {isStale && staleReason && (
        <StaleBanner briefDate={brief.brief_date} reason={staleReason} />
      )}

      {/* Status + summary — always shown when available */}
      {brief.overall_status && (
        <StatusStrip
          status={brief.overall_status}
          reason={brief.overall_reason ?? null}
          summary={brief.ai_summary ?? null}
        />
      )}

      {/* Needs Review — near-top block only for v2; v1 has its own in LegacyBriefContent */}
      {sections && isV2 && needsReviewVisible(sections.needs_review.total) && (
        <NeedsReviewBlock needsReview={sections.needs_review} />
      )}

      {/* v2 layout — observations are primary content */}
      {sections && isV2 && (
        <>
          <WhatMattersTodaySection observations={sections.observations ?? []} />
          <hr className="border-kk-line" />
          <DetailsSection sections={sections} />
        </>
      )}

      {/* v1 fallback — render legacy dashboard layout for old briefs */}
      {sections && !isV2 && (
        <LegacyBriefContent sections={sections} />
      )}
    </div>
  )
}

// ── StatePanel ────────────────────────────────────────────────────────────────

function StatePanel({ title, detail, action }: {
  title: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-16 text-center">
      <div className="text-sm font-medium text-kk-ink mb-1.5">{title}</div>
      <div className="text-xs text-kk-muted max-w-sm mx-auto leading-relaxed">{detail}</div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function MorningBriefPage() {
  const [user, latestBrief] = await Promise.all([
    getCurrentUser(),
    getLatestMorningBrief(),
  ])

  const isAdmin = user?.role === 'SUPER_ADMIN'
  const today   = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(new Date())
  const isTodaysBrief = latestBrief?.brief_date === today

  let readyBrief: MorningBriefRow | null = null
  let stateMessage: string | null = null
  let isStale = false
  let staleReason = ''

  if (latestBrief?.status === 'ready' && isTodaysBrief) {
    readyBrief = latestBrief
  } else if (latestBrief?.status === 'generating' && isTodaysBrief) {
    stateMessage = 'generating'
  } else if (latestBrief?.status === 'failed' && isTodaysBrief) {
    stateMessage = 'failed'
  } else if (latestBrief?.status === 'ready' && !isTodaysBrief) {
    readyBrief = latestBrief
    isStale = true
    staleReason = "Today's brief has not been generated yet."
  }

  let fallbackBrief: MorningBriefRow | null = null
  if (stateMessage === 'failed') {
    fallbackBrief = await getLastReadyMorningBrief()
    if (fallbackBrief && fallbackBrief.brief_date !== today) {
      isStale = true
      staleReason = `Today's brief failed to generate. Showing brief from ${formatDate(fallbackBrief.brief_date)}.`
    }
  }

  const displayBrief = readyBrief ?? fallbackBrief

  const headerDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Europe/Copenhagen',
  })

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-4xl font-black tracking-tight text-kk-ink leading-tight">Morning Brief</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-semibold text-kk-ink">{headerDate}</span>
            {displayBrief?.generated_at && (
              <>
                <span className="text-kk-muted select-none">•</span>
                <span className="text-sm text-kk-muted">
                  {isStale
                    ? `From ${formatDate(displayBrief.brief_date)}, generated ${formatTime(displayBrief.generated_at)}`
                    : `Generated today at ${formatTime(displayBrief.generated_at)}`
                  }
                </span>
              </>
            )}
          </div>
        </div>
        {isAdmin && <RegenerateButton />}
      </div>

      {displayBrief && (
        <MorningBriefContent
          brief={displayBrief}
          isStale={isStale}
          staleReason={isStale ? staleReason : undefined}
        />
      )}

      {stateMessage === 'generating' && !displayBrief && (
        <StatePanel
          title="Morning Brief is being generated…"
          detail="This usually takes less than a minute."
        />
      )}

      {stateMessage === 'failed' && !displayBrief && (
        <StatePanel
          title="Brief generation failed"
          detail={latestBrief?.error_message ?? 'An error occurred during generation.'}
          action={isAdmin ? <RegenerateButton /> : undefined}
        />
      )}

      {!displayBrief && !stateMessage && (
        <StatePanel
          title="No Morning Brief yet"
          detail="Briefs are generated daily at approximately 09:00 Copenhagen time."
          action={isAdmin ? <RegenerateButton /> : undefined}
        />
      )}
    </div>
  )
}
