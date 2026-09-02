import { getCurrentUser } from '@/lib/auth'
import {
  getLatestMorningBrief,
  getLastReadyMorningBrief,
} from '@/lib/actions/marketing/morning-brief'
import RegenerateButton from './RegenerateButton'
import type {
  MorningBriefRow,
  MorningBriefSections,
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

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CFG = {
  green: {
    label: 'Green',
    dot: 'bg-green-500',
    pill: 'bg-green-100 text-green-700',
    banner: 'bg-green-50 border-green-200',
  },
  amber: {
    label: 'Amber',
    dot: 'bg-amber-400',
    pill: 'bg-amber-100 text-amber-700',
    banner: 'bg-amber-50 border-amber-200',
  },
  red: {
    label: 'Red',
    dot: 'bg-red-500',
    pill: 'bg-red-100 text-red-700',
    banner: 'bg-red-50 border-red-200',
  },
} as const

// ── Icons ─────────────────────────────────────────────────────────────────────

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

function IconStore() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2 8V15.5H16V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M1.5 8H16.5M3 3H15L16.5 8H1.5L3 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="6.5" y="11" width="5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  )
}

function IconCalendar() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M2.5 7.5h13" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M6 2v3M12 2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M5.5 11h1.5M9 11h1.5M12.5 11h0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function IconClipboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3.5" y="4" width="11" height="12.5" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M6.5 4V3a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M6.5 9h5M6.5 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function IconInfo() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.25"/>
      <path d="M7 6.5v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
      <circle cx="7" cy="4.5" r="0.6" fill="currentColor"/>
    </svg>
  )
}

function IconWarning() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 1.5 13.5 13H0.5L7 1.5Z" fill="currentColor"/>
      <path d="M7 5.5v3" stroke="white" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
      <circle cx="7" cy="10.8" r="0.65" fill="white"/>
    </svg>
  )
}

// ── StatusBanner ──────────────────────────────────────────────────────────────
// Warm tinted bg per status, compact pill left, summary text right.

function StatusBanner({
  status, reason, summary,
}: {
  status: 'green' | 'amber' | 'red'
  reason: string | null
  summary: string | null
}) {
  const cfg = STATUS_CFG[status]
  return (
    <div className={`border rounded-xl px-6 py-3 flex items-start gap-5 ${cfg.banner}`}>
      <span className={`mt-px shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${cfg.pill}`}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
        {cfg.label}
      </span>
      <p className="text-[13px] text-kk-ink/80 leading-snug">{summary || reason}</p>
    </div>
  )
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
// Catmull-Rom smooth polyline rendered as cubic Bezier SVG path.
// No axes, no labels, no external dependencies.

function Sparkline({ points, stroke }: { points: TrendPoint[]; stroke: string }) {
  if (points.length < 2) return null
  const W = 96, H = 36, pad = 3
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
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden="true" className="shrink-0 opacity-80">
      <path d={d} stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── KPI cards ─────────────────────────────────────────────────────────────────
// Icon + label on same row at top; large number below; change text + sparkline at bottom.

function KpiCard({
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
      <div className={`text-[32px] font-bold tabular-nums leading-none tracking-tight mt-2 ${metric.highlight ? 'text-amber-700' : 'text-kk-ink'}`}>
        {metric.value}
      </div>
      <div className="flex items-end justify-between mt-auto pt-2">
        <div className="text-xs text-kk-muted leading-none">
          {metric.change ?? ''}
        </div>
        {metric.trend && metric.trend.length >= 2 && (
          <Sparkline points={metric.trend} stroke={sparkColor} />
        )}
      </div>
    </div>
  )
}

function KpiStrip({ sections }: { sections: MorningBriefSections }) {
  type Slot = { metric: BriefMetricRow; icon: React.ReactNode; iconBg: string; iconColor: string; sparkColor: string }
  const candidates: Array<Slot | null> = [
    sections.paid.metrics[0]
      ? { metric: sections.paid.metrics[0], icon: <IconCreditCard />, iconBg: 'bg-green-100', iconColor: 'text-green-700', sparkColor: '#22c55e' }
      : null,
    sections.paid.metrics[1]
      ? { metric: sections.paid.metrics[1], icon: <IconEye />, iconBg: 'bg-violet-100', iconColor: 'text-violet-700', sparkColor: '#8b5cf6' }
      : null,
    sections.organic.ig.metrics[0]
      ? { metric: sections.organic.ig.metrics[0], icon: <IconInstagram />, iconBg: 'bg-pink-100', iconColor: 'text-pink-600', sparkColor: '#ec4899' }
      : null,
    sections.organic.fb.metrics[0]
      ? { metric: sections.organic.fb.metrics[0], icon: <IconFacebook />, iconBg: 'bg-blue-100', iconColor: 'text-blue-700', sparkColor: '#3b82f6' }
      : null,
  ]
  const slots = candidates.filter((s): s is Slot => s !== null)
  if (slots.length === 0) return null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {slots.map((s, i) => <KpiCard key={i} {...s} />)}
    </div>
  )
}

// ── Campaign table ────────────────────────────────────────────────────────────
// Bordered container with header row + border-t-separated data rows.

type CampaignSummary = MorningBriefSections['paid']['active_campaign_summaries'][number]

function CampaignTable({ campaigns }: { campaigns: CampaignSummary[] }) {
  if (campaigns.length === 0) return null
  return (
    <div className="rounded-xl border border-kk-line overflow-hidden">
      {/* header row */}
      <div className="grid grid-cols-[1fr_auto] gap-x-6 px-4 py-2 bg-kk-soft border-b border-kk-line">
        <span className="text-[11px] font-medium text-kk-muted tracking-wide uppercase">Campaign</span>
        <span className="text-[11px] font-medium text-kk-muted tracking-wide uppercase">7d spend</span>
      </div>
      {/* data rows */}
      {campaigns.map((c, i) => (
        <div
          key={i}
          className={`grid grid-cols-[1fr_auto] gap-x-6 items-center px-4 py-2.5 border-t border-kk-line ${
            c.anomaly_flag ? 'bg-amber-50' : ''
          }`}
        >
          <div className="flex items-center gap-2 min-w-0 pr-2">
            {c.anomaly_flag ? (
              <span className="shrink-0 text-amber-500"><IconWarning /></span>
            ) : (
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-kk-line/60" />
            )}
            <span className={`text-sm truncate ${c.anomaly_flag ? 'text-kk-ink font-medium' : 'text-kk-ink'}`}>{c.name}</span>
          </div>
          <span className={`text-sm tabular-nums shrink-0 ${c.anomaly_flag ? 'text-amber-700 font-medium' : 'text-kk-muted'}`}>
            {c.spend_7d_formatted ?? '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Paid card ─────────────────────────────────────────────────────────────────

function PaidCard({ paid }: { paid: MorningBriefSections['paid'] }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
      <div className="px-6 pt-5 pb-5">
        <div className="flex items-center gap-1.5 mb-2">
          <h2 className="text-xl font-semibold text-kk-ink">Paid</h2>
          <span className="text-kk-muted"><IconInfo /></span>
        </div>
        <p className="text-[13px] text-kk-muted leading-snug mb-3">{paid.assessment}</p>

        {paid.anomalies.length > 0 && (
          <div className="space-y-1 mb-4">
            {paid.anomalies.map((a, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                <span className="shrink-0 mt-[3px] w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-[11px] text-amber-800 leading-snug">{a}</span>
              </div>
            ))}
          </div>
        )}

        {paid.active_campaign_summaries.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-kk-ink mb-2">Active campaigns</h3>
            <CampaignTable campaigns={paid.active_campaign_summaries} />
          </div>
        )}
      </div>

      <div className="px-6 py-3 border-t border-kk-line">
        <a href="/marketing/paid" className="text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors">
          View all campaigns →
        </a>
      </div>
    </div>
  )
}

// ── GBP card ──────────────────────────────────────────────────────────────────

function GbpCard({ gbp }: { gbp: MorningBriefSections['gbp'] }) {
  if (gbp.integration_kind === 'pending_approval' || gbp.integration_kind === 'connected_no_sync') {
    const lines = gbp.integration_kind === 'pending_approval'
      ? [
          'Google Business Profile integration is pending API approval.',
          'Review queue and rating summaries will appear here once the integration is active.',
        ]
      : ['Google Business Profile is connected — awaiting first sync.']

    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-5 flex items-start gap-4">
        <div className="shrink-0 w-9 h-9 rounded-xl bg-blue-50 text-blue-500 flex items-center justify-center">
          <IconStore />
        </div>
        <div className="min-w-0 pt-0.5">
          <div className="text-sm font-semibold text-kk-ink mb-1">Google Business Profile</div>
          {lines.map((l, i) => (
            <p key={i} className="text-xs text-kk-muted leading-relaxed">{l}</p>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-5 flex items-start gap-4">
      <div className="shrink-0 w-9 h-9 rounded-xl bg-blue-50 text-blue-500 flex items-center justify-center">
        <IconStore />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-sm font-semibold text-kk-ink mb-2">Google Business Profile</div>
        {gbp.assessment && (
          <p className="text-xs text-kk-muted leading-relaxed mb-3">{gbp.assessment}</p>
        )}
        <div className="space-y-2">
          {gbp.new_reviews_yesterday != null && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-kk-muted">New reviews (yesterday)</span>
              <span className="text-sm font-semibold tabular-nums text-kk-ink">{gbp.new_reviews_yesterday}</span>
            </div>
          )}
          {gbp.avg_star_rating_7d != null && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-kk-muted">Avg rating (7d)</span>
              <span className="text-sm font-semibold tabular-nums text-kk-ink">{gbp.avg_star_rating_7d.toFixed(1)} / 5</span>
            </div>
          )}
          {gbp.pending_reply_count > 0 && (
            <a href="/marketing/google-business-profile" className="block text-xs text-blue-600 font-medium hover:underline pt-1">
              {gbp.pending_reply_count} {gbp.pending_reply_count === 1 ? 'reply' : 'replies'} awaiting approval →
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Platform metrics ──────────────────────────────────────────────────────────
// Horizontal flex with vertical divide-x separators; large tabular numbers.

function PlatformMetrics({ metrics }: { metrics: BriefMetricRow[] }) {
  if (metrics.length === 0) {
    return <p className="px-5 py-4 text-xs text-kk-muted">No data available.</p>
  }
  return (
    <div className="flex divide-x divide-kk-line">
      {metrics.map((m, i) => (
        <div key={i} className="flex-1 min-w-0 px-5 py-4">
          <div className="text-xs text-kk-muted mb-2">{m.label}</div>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className={`text-[28px] font-bold tabular-nums leading-none tracking-tight ${m.highlight ? 'text-amber-700' : 'text-kk-ink'}`}>
              {m.value}
            </span>
            {m.change && (
              <span className="text-xs text-kk-muted">{m.change}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Organic section ───────────────────────────────────────────────────────────

function OrganicSection({ organic }: { organic: MorningBriefSections['organic'] }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden flex flex-col">
      {/* Heading — same treatment as Paid */}
      <div className="flex items-center gap-1.5 px-6 pt-5 pb-4">
        <h2 className="text-xl font-semibold text-kk-ink">Organic</h2>
        <span className="text-kk-muted"><IconInfo /></span>
      </div>

      {/* Instagram — section within the outer card */}
      <div className="border-t border-kk-line">
        <div className="flex items-center gap-3 px-6 py-3.5">
          <div className="w-9 h-9 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center shrink-0">
            <IconInstagram />
          </div>
          <div>
            <div className="text-sm font-semibold text-kk-ink">Instagram</div>
            <div className="text-xs text-kk-muted">Past 7 days</div>
          </div>
        </div>
        <div className="border-t border-kk-line">
          <PlatformMetrics metrics={organic.ig.metrics} />
        </div>
      </div>

      {/* Facebook */}
      {organic.fb.available && (
        <div className="border-t border-kk-line">
          <div className="flex items-center gap-3 px-6 py-3.5">
            <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <IconFacebook />
            </div>
            <div>
              <div className="text-sm font-semibold text-kk-ink">Facebook</div>
              <div className="text-xs text-kk-muted">Past 7 days</div>
            </div>
          </div>
          <div className="border-t border-kk-line">
            <PlatformMetrics metrics={organic.fb.metrics} />
          </div>
        </div>
      )}
      {/* Footer link — mirrors Paid card's footer */}
      <div className="mt-auto px-6 py-3 border-t border-kk-line">
        <a href="/marketing/organic" className="text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors">
          View organic analytics →
        </a>
      </div>
    </div>
  )
}

// ── Stale banner ──────────────────────────────────────────────────────────────

function StaleBanner({ briefDate, reason }: { briefDate: string; reason: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
      <span className="font-semibold shrink-0">⚠ Showing brief from {formatDate(briefDate)}</span>
      <span className="text-amber-700">{reason}</span>
    </div>
  )
}

// ── State panel ───────────────────────────────────────────────────────────────

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

// ── MorningBriefContent ───────────────────────────────────────────────────────

function MorningBriefContent({
  brief, isStale, staleReason,
}: {
  brief: MorningBriefRow
  isStale?: boolean
  staleReason?: string
}) {
  const sections = brief.sections_json

  return (
    <div className="space-y-4">
      {isStale && staleReason && (
        <StaleBanner briefDate={brief.brief_date} reason={staleReason} />
      )}

      {/* 1 — Status banner */}
      {brief.overall_status && (
        <StatusBanner
          status={brief.overall_status}
          reason={brief.overall_reason ?? null}
          summary={brief.ai_summary ?? null}
        />
      )}

      {/* 2 — KPI strip */}
      {sections && <KpiStrip sections={sections} />}

      {/* 3 — Main grid */}
      {sections && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-5">
          {/* Left: Paid + GBP */}
          <div className="space-y-4">
            <PaidCard paid={sections.paid} />
            <GbpCard gbp={sections.gbp} />
          </div>
          {/* Right: Organic */}
          <OrganicSection organic={sections.organic} />
        </div>
      )}

      {/* 4 — Bottom operational cards */}
      {sections && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Today's Content */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-green-100 text-green-700 flex items-center justify-center shrink-0">
                <IconCalendar />
              </div>
              <h2 className="text-sm font-semibold text-kk-ink">Today&apos;s Content</h2>
            </div>
            <p className="text-sm text-kk-muted">No content scheduled.</p>
          </div>

          {/* Needs Review */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center shrink-0">
                <IconClipboard />
              </div>
              <h2 className="text-sm font-semibold text-kk-ink">Needs Review</h2>
            </div>
            {sections.needs_review.total === 0 ? (
              <p className="text-sm text-kk-muted">Nothing awaiting your approval right now.</p>
            ) : (
              <div>
                <div className="space-y-2 mb-3">
                  {sections.needs_review.items.map((item, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-3">
                      <span className="text-xs text-kk-muted">{item.label}</span>
                      <span className="text-sm font-semibold tabular-nums text-kk-ink">{item.count}</span>
                    </div>
                  ))}
                </div>
                <a href="/marketing/needs-review" className="text-sm text-blue-600 hover:text-blue-700 transition-colors">
                  Review all {sections.needs_review.total} →
                </a>
              </div>
            )}
          </div>
        </div>
      )}
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
