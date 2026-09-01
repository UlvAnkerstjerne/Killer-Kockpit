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
  green: { label: 'Green', dot: 'bg-green-500', pill: 'bg-green-100 text-green-700' },
  amber: { label: 'Amber', dot: 'bg-amber-400', pill: 'bg-amber-100 text-amber-700' },
  red:   { label: 'Red',   dot: 'bg-red-500',   pill: 'bg-red-100 text-red-700' },
} as const

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconSpend() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 2v1.5M9 14.5V16M5.5 9H3M15 9h-2.5M13.24 4.76l-1.06 1.06M5.82 12.18l-1.06 1.06M13.24 13.24l-1.06-1.06M5.82 5.82 4.76 4.76" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  )
}

function IconEye() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M1.5 9C1.5 9 4 4 9 4s7.5 5 7.5 5-2.5 5-7.5 5S1.5 9 1.5 9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  )
}

function IconInstagram() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="4" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="13" cy="5" r="0.75" fill="currentColor"/>
    </svg>
  )
}

function IconFacebook() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M10.5 9h2l.5-2.5H10.5V5c0-.8.4-1.5 1.5-1.5H13V1.5A11 11 0 0 0 11 1.5C8.8 1.5 7.5 2.8 7.5 5.2V6.5H5.5V9h2v7.5h3V9Z" fill="currentColor"/>
    </svg>
  )
}

function IconCalendar() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M2.5 7.5h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M6 2v3M12 2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="6.5" cy="11" r="1" fill="currentColor"/>
      <circle cx="9" cy="11" r="1" fill="currentColor"/>
      <circle cx="11.5" cy="11" r="1" fill="currentColor"/>
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
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-kk-muted">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.25"/>
      <path d="M7 6.5v4M7 4.5v.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
    </svg>
  )
}

// ── StatusBanner ──────────────────────────────────────────────────────────────
// Warm cream background, status pill left + summary text right in one row.

function StatusBanner({
  status, reason, summary,
}: {
  status: 'green' | 'amber' | 'red'
  reason: string | null
  summary: string | null
}) {
  const cfg = STATUS_CFG[status]
  return (
    <div className="bg-kk-soft border border-kk-line rounded-2xl px-6 py-4 flex items-start gap-4">
      <span className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${cfg.pill}`}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
        {cfg.label}
      </span>
      <p className="text-sm text-kk-ink leading-relaxed pt-0.5">{summary || reason}</p>
    </div>
  )
}

// ── KPI cards ─────────────────────────────────────────────────────────────────
// Four separate bordered cards each with a colored icon square.

function KpiMetricCard({
  metric, iconBg, iconColor, icon,
}: {
  metric: BriefMetricRow
  iconBg: string
  iconColor: string
  icon: React.ReactNode
}) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${iconBg} ${iconColor}`}>
        {icon}
      </div>
      <div className="text-xs text-kk-muted mb-1 truncate">{metric.label}</div>
      <div className={`text-2xl font-bold tabular-nums leading-none tracking-tight ${metric.highlight ? 'text-amber-700' : 'text-kk-ink'}`}>
        {metric.value}
      </div>
      {metric.change && (
        <div className="text-xs text-kk-muted mt-1.5">{metric.change}</div>
      )}
    </div>
  )
}

function KpiCards({ sections }: { sections: MorningBriefSections }) {
  type KpiDef = { metric: BriefMetricRow; iconBg: string; iconColor: string; icon: React.ReactNode }
  const candidates: Array<KpiDef | null> = [
    sections.paid.metrics[0]
      ? { metric: sections.paid.metrics[0], iconBg: 'bg-green-100', iconColor: 'text-green-700', icon: <IconSpend /> }
      : null,
    sections.paid.metrics[1]
      ? { metric: sections.paid.metrics[1], iconBg: 'bg-violet-100', iconColor: 'text-violet-700', icon: <IconEye /> }
      : null,
    sections.organic.ig.metrics[0]
      ? { metric: sections.organic.ig.metrics[0], iconBg: 'bg-pink-100', iconColor: 'text-pink-600', icon: <IconInstagram /> }
      : null,
    sections.organic.fb.metrics[0]
      ? { metric: sections.organic.fb.metrics[0], iconBg: 'bg-blue-100', iconColor: 'text-blue-700', icon: <IconFacebook /> }
      : null,
  ]
  const cards = candidates.filter((c): c is KpiDef => c !== null)
  if (cards.length === 0) return null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, i) => (
        <KpiMetricCard
          key={i}
          metric={card.metric}
          iconBg={card.iconBg}
          iconColor={card.iconColor}
          icon={card.icon}
        />
      ))}
    </div>
  )
}

// ── Anomaly row ───────────────────────────────────────────────────────────────

function AnomalyRow({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 pl-3.5 pr-4 py-2.5 bg-amber-50 border-l-2 border-amber-400 rounded-r-lg">
      <span className="text-amber-500 shrink-0 mt-0.5 text-[10px] font-bold leading-none">▲</span>
      <span className="text-xs text-amber-800 leading-relaxed">{text}</span>
    </div>
  )
}

// ── Campaign table ────────────────────────────────────────────────────────────

type CampaignSummary = MorningBriefSections['paid']['active_campaign_summaries'][number]

function CampaignTable({ campaigns }: { campaigns: CampaignSummary[] }) {
  if (campaigns.length === 0) return null
  return (
    <div>
      <div className="grid grid-cols-[1fr_auto] gap-x-4 px-3 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted">Campaign</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted">Spend 7d</span>
      </div>
      <div className="space-y-0.5">
        {campaigns.map((c, i) => (
          <div
            key={i}
            className={`grid grid-cols-[1fr_auto] gap-x-4 items-center px-3 py-2 rounded-lg ${
              c.anomaly_flag ? 'bg-amber-50' : 'hover:bg-kk-soft'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {c.anomaly_flag ? (
                <span className="shrink-0 text-amber-500 text-xs leading-none">⚠</span>
              ) : (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-kk-line" />
              )}
              <span className={`text-sm truncate ${c.anomaly_flag ? 'text-amber-800 font-medium' : 'text-kk-ink'}`}>
                {c.name}
              </span>
            </div>
            <span className={`text-sm tabular-nums font-medium shrink-0 ${c.anomaly_flag ? 'text-amber-700' : 'text-kk-muted'}`}>
              {c.spend_7d_formatted ?? '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Paid card ─────────────────────────────────────────────────────────────────
// Single white card containing heading, assessment, campaign table, and footer link.

function PaidCard({ paid }: { paid: MorningBriefSections['paid'] }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
      <div className="px-6 py-5">
        <div className="flex items-center gap-1.5 mb-2">
          <h2 className="text-lg font-semibold text-kk-ink">Paid</h2>
          <IconInfo />
        </div>
        <p className="text-sm text-kk-muted leading-relaxed mb-5">{paid.assessment}</p>

        {paid.anomalies.length > 0 && (
          <div className="space-y-2 mb-5">
            {paid.anomalies.map((a, i) => <AnomalyRow key={i} text={a} />)}
          </div>
        )}

        {paid.active_campaign_summaries.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-kk-muted uppercase tracking-widest mb-3">
              Active campaigns
            </h3>
            <CampaignTable campaigns={paid.active_campaign_summaries} />
          </div>
        )}
      </div>

      <div className="px-6 py-4 border-t border-kk-line">
        <a
          href="/marketing/campaigns"
          className="text-sm text-blue-600 hover:text-blue-700 transition-colors"
        >
          View all campaigns →
        </a>
      </div>
    </div>
  )
}

// ── GBP card ──────────────────────────────────────────────────────────────────

function GbpCard({ gbp }: { gbp: MorningBriefSections['gbp'] }) {
  if (gbp.integration_kind === 'pending_approval' || gbp.integration_kind === 'connected_no_sync') {
    const message = gbp.integration_kind === 'pending_approval'
      ? 'API approval pending — review queue and rating data will appear here once active.'
      : 'Connected — awaiting first sync.'

    return (
      <div className="bg-kk-soft border border-kk-line rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-lg bg-kk-line flex items-center justify-center">
            <span className="text-kk-muted text-[9px] font-bold tracking-tight">GBP</span>
          </div>
          <div className="min-w-0 pt-0.5">
            <div className="text-sm font-semibold text-kk-ink mb-1">Google Business Profile</div>
            <div className="text-xs text-kk-muted leading-relaxed">{message}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
      <div className="flex items-center gap-1.5 mb-3">
        <h2 className="text-sm font-semibold text-kk-ink">Google Business Profile</h2>
      </div>
      {gbp.assessment && (
        <p className="text-xs text-kk-muted leading-relaxed mb-3">{gbp.assessment}</p>
      )}
      <div className="space-y-2.5">
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
          <div className="pt-2 border-t border-kk-line">
            <a href="/marketing/google-business-profile" className="text-xs text-kk-ink font-medium hover:underline">
              {gbp.pending_reply_count} {gbp.pending_reply_count === 1 ? 'reply' : 'replies'} awaiting approval →
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Platform metric grid ───────────────────────────────────────────────────────
// Large numbers in a horizontal grid — used inside IG and FB cards.

function PlatformMetricGrid({ metrics }: { metrics: BriefMetricRow[] }) {
  if (metrics.length === 0) return null
  return (
    <div className={`grid gap-4 pt-4 ${metrics.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
      {metrics.map((m, i) => (
        <div key={i}>
          <div className="text-xs text-kk-muted mb-1 leading-tight">{m.label}</div>
          <div className={`text-2xl font-bold tabular-nums leading-none tracking-tight ${m.highlight ? 'text-amber-700' : 'text-kk-ink'}`}>
            {m.value}
          </div>
          {m.change && (
            <div className="text-xs text-kk-muted mt-1">{m.change}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Organic section ───────────────────────────────────────────────────────────
// Floating heading above two separate platform cards (Instagram, Facebook).

function OrganicSection({ organic }: { organic: MorningBriefSections['organic'] }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-1.5">
        <h2 className="text-lg font-semibold text-kk-ink">Organic</h2>
        <IconInfo />
      </div>

      {organic.assessment && (
        <p className="text-sm text-kk-muted leading-relaxed">{organic.assessment}</p>
      )}

      {/* Instagram card */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-kk-line">
          <div className="w-8 h-8 rounded-lg bg-pink-100 text-pink-600 flex items-center justify-center shrink-0">
            <IconInstagram />
          </div>
          <div>
            <div className="text-sm font-semibold text-kk-ink">Instagram</div>
            <div className="text-xs text-kk-muted">Past 7 days</div>
          </div>
        </div>
        <div className="px-5 pb-5">
          {organic.ig.metrics.length > 0
            ? <PlatformMetricGrid metrics={organic.ig.metrics} />
            : <p className="text-xs text-kk-muted pt-4">No data available.</p>
          }
        </div>
      </div>

      {/* Facebook card */}
      {organic.fb.available && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-kk-line">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <IconFacebook />
            </div>
            <div>
              <div className="text-sm font-semibold text-kk-ink">Facebook</div>
              <div className="text-xs text-kk-muted">Past 7 days</div>
            </div>
          </div>
          <div className="px-5 pb-5">
            {organic.fb.metrics.length > 0
              ? <PlatformMetricGrid metrics={organic.fb.metrics} />
              : <p className="text-xs text-kk-muted pt-4">No data available.</p>
            }
          </div>
        </div>
      )}
    </section>
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

// ── State panels ──────────────────────────────────────────────────────────────

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
    <div className="space-y-5">
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

      {/* 2 — KPI orientation strip (4 separate cards) */}
      {sections && <KpiCards sections={sections} />}

      {/* 3 — Main grid: Paid + GBP (left) | Organic (right) */}
      {sections && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-5">
          {/* LEFT column */}
          <div className="space-y-5">
            <PaidCard paid={sections.paid} />
            <GbpCard gbp={sections.gbp} />
          </div>

          {/* RIGHT column */}
          <OrganicSection organic={sections.organic} />
        </div>
      )}

      {/* 4 — Operational tail */}
      {sections && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Today's Content */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-green-100 text-green-700 flex items-center justify-center shrink-0">
                <IconCalendar />
              </div>
              <h2 className="text-sm font-semibold text-kk-ink">Today&apos;s Content</h2>
            </div>
            <p className="text-xs text-kk-muted">No content scheduled.</p>
          </div>

          {/* Needs Review */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-orange-100 text-orange-700 flex items-center justify-center shrink-0">
                <IconClipboard />
              </div>
              <h2 className="text-sm font-semibold text-kk-ink">Needs Review</h2>
            </div>
            {sections.needs_review.total === 0 ? (
              <p className="text-xs text-kk-muted">Nothing awaiting approval.</p>
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
                <a href="/marketing/needs-review" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
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
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-4xl font-black tracking-tight text-kk-ink">Morning Brief</h1>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1.5">
            <span className="text-sm text-kk-muted">{headerDate}</span>
            {displayBrief?.generated_at && (
              <>
                <span className="text-kk-line select-none">·</span>
                <span className="text-xs text-kk-muted">
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
