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
  green: { label: 'Green', dot: 'bg-green-500', pill: 'bg-green-50 text-green-700', borderColor: '#22c55e' },
  amber: { label: 'Amber', dot: 'bg-amber-400', pill: 'bg-amber-50 text-amber-700', borderColor: '#f59e0b' },
  red:   { label: 'Red',   dot: 'bg-red-500',   pill: 'bg-red-50 text-red-700',     borderColor: '#ef4444' },
} as const

// ── BriefStatus ───────────────────────────────────────────────────────────────
// Editorial lead: status pill + reason inline, AI summary as the lede copy.
// Left-border accent communicates state without an aggressive alert box.

function BriefStatus({
  status, reason, summary,
}: {
  status: 'green' | 'amber' | 'red'
  reason: string | null
  summary: string | null
}) {
  const cfg = STATUS_CFG[status]
  return (
    <div
      className="bg-kk-panel border border-kk-line rounded-2xl px-7 py-6"
      style={{ borderLeftWidth: '4px', borderLeftColor: cfg.borderColor }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-4">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wider ${cfg.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
          {cfg.label}
        </span>
        {reason && (
          <span className="text-sm text-kk-muted">{reason}</span>
        )}
      </div>
      {summary && (
        <p className="text-sm text-kk-ink leading-relaxed max-w-3xl">{summary}</p>
      )}
    </div>
  )
}

// ── KPI strip ─────────────────────────────────────────────────────────────────
// Compact horizontal orientation panel — immediate read on key numbers.
// Sourced from paid aggregate metrics and IG account metrics.

function KpiCard({ metric }: { metric: BriefMetricRow }) {
  return (
    <div className="flex-1 min-w-0 px-5 py-4">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted mb-2 truncate">
        {metric.label}
      </div>
      <div className={`text-[22px] font-semibold tabular-nums leading-none tracking-tight ${metric.highlight ? 'text-amber-700' : 'text-kk-ink'}`}>
        {metric.value}
      </div>
      {metric.change && (
        <div className="text-xs text-kk-muted mt-1.5">{metric.change}</div>
      )}
    </div>
  )
}

function KpiStrip({ metrics }: { metrics: BriefMetricRow[] }) {
  if (metrics.length === 0) return null
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
      <div className="flex divide-x divide-kk-line">
        {metrics.map((m, i) => <KpiCard key={i} metric={m} />)}
      </div>
    </div>
  )
}

// ── Anomaly row ───────────────────────────────────────────────────────────────
// Left-border accent treatment — visually distinct from informational text.

function AnomalyRow({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 pl-3.5 pr-4 py-2.5 bg-amber-50 border-l-2 border-amber-400 rounded-r-lg">
      <span className="text-amber-500 shrink-0 mt-0.5 text-[10px] font-bold leading-none">▲</span>
      <span className="text-xs text-amber-800 leading-relaxed">{text}</span>
    </div>
  )
}

// ── Campaign table ────────────────────────────────────────────────────────────
// Grid-aligned campaign list — name dominant, spend right-aligned.
// Amber dot flags campaigns with anomalies without overwhelming the layout.

type CampaignSummary = MorningBriefSections['paid']['active_campaign_summaries'][number]

function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  return (
    <div className={`grid grid-cols-[1fr_auto] gap-x-4 items-center px-3 py-2 rounded-lg transition-colors ${
      campaign.anomaly_flag ? 'bg-amber-50' : 'hover:bg-kk-soft'
    }`}>
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${campaign.anomaly_flag ? 'bg-amber-400' : 'bg-kk-line'}`} />
        <span className={`text-sm truncate ${campaign.anomaly_flag ? 'text-amber-800 font-medium' : 'text-kk-ink'}`}>
          {campaign.name}
        </span>
      </div>
      <span className={`text-sm tabular-nums font-medium shrink-0 ${campaign.anomaly_flag ? 'text-amber-700' : 'text-kk-muted'}`}>
        {campaign.spend_7d_formatted ?? '—'}
      </span>
    </div>
  )
}

function CampaignTable({ campaigns }: { campaigns: CampaignSummary[] }) {
  if (campaigns.length === 0) return null
  return (
    <div>
      <div className="grid grid-cols-[1fr_auto] gap-x-4 px-3 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted">Campaign</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted">Spend 7d</span>
      </div>
      <div className="space-y-0.5">
        {campaigns.map((c, i) => <CampaignRow key={i} campaign={c} />)}
      </div>
    </div>
  )
}

// ── Paid section ──────────────────────────────────────────────────────────────
// Floats on background — no outer card. Assessment as editorial text,
// anomalies as distinct amber rows, campaigns in a contained white panel.

function PaidSection({ paid }: { paid: MorningBriefSections['paid'] }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted">Paid</h2>
        {paid.pending_review_count > 0 && (
          <a href="/marketing/needs-review" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
            {paid.pending_review_count} awaiting review →
          </a>
        )}
      </div>

      <p className="text-sm text-kk-ink leading-relaxed mb-5">{paid.assessment}</p>

      {paid.anomalies.length > 0 && (
        <div className="space-y-2 mb-6">
          {paid.anomalies.map((a, i) => <AnomalyRow key={i} text={a} />)}
        </div>
      )}

      {paid.active_campaign_summaries.length > 0 && (
        <div className="bg-kk-panel border border-kk-line rounded-xl p-3">
          <CampaignTable campaigns={paid.active_campaign_summaries} />
        </div>
      )}
    </section>
  )
}

// ── Social metric group ───────────────────────────────────────────────────────
// Compact label / value rows — right-aligned numbers for easy scanning.

function SocialMetricGroup({ metrics }: { metrics: BriefMetricRow[] }) {
  if (metrics.length === 0) return null
  return (
    <div className="space-y-2.5">
      {metrics.map((m, i) => (
        <div key={i} className="flex items-baseline justify-between gap-4">
          <span className="text-xs text-kk-muted shrink-0">{m.label}</span>
          <div className="flex items-center gap-2 shrink-0">
            {m.change && <span className="text-xs text-kk-muted">{m.change}</span>}
            <span className={`text-sm font-semibold tabular-nums ${m.highlight ? 'text-amber-700' : 'text-kk-ink'}`}>
              {m.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Notable post row ──────────────────────────────────────────────────────────

type NotablePost = MorningBriefSections['organic']['ig']['notable_posts'][number]

function NotablePostRow({ post }: { post: NotablePost }) {
  return (
    <div className="flex items-center justify-between py-2 gap-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-kk-muted shrink-0">
          {post.media_type}
        </span>
        {post.caption_truncated && (
          <span className="text-xs text-kk-muted italic truncate">&ldquo;{post.caption_truncated}&rdquo;</span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {post.reach != null && (
          <span className="text-xs text-kk-muted tabular-nums">{post.reach.toLocaleString()} reach</span>
        )}
        {post.performance_label && (
          <span className={`text-xs font-medium tabular-nums ${post.performance_label.startsWith('+') ? 'text-green-600' : 'text-kk-muted'}`}>
            {post.performance_label}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Organic section ───────────────────────────────────────────────────────────
// Floats on background. Assessment as editorial text; IG and FB as
// sub-sections with hairline dividers — distinct but stylistically unified.

function OrganicSection({ organic }: { organic: MorningBriefSections['organic'] }) {
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted mb-5">Organic</h2>

      <p className="text-sm text-kk-ink leading-relaxed mb-6">{organic.assessment}</p>

      {/* Instagram */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs font-semibold text-kk-ink">Instagram</span>
          <div className="flex-1 h-px bg-kk-line" />
        </div>
        {organic.ig.metrics.length > 0
          ? <SocialMetricGroup metrics={organic.ig.metrics} />
          : <p className="text-xs text-kk-muted">No data available.</p>
        }
        {organic.ig.notable_posts.length > 0 && (
          <div className="mt-4 pt-3 border-t border-kk-line">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted mb-1">
              Recent posts
            </div>
            <div className="divide-y divide-kk-line">
              {organic.ig.notable_posts.slice(0, 3).map((p, i) => (
                <NotablePostRow key={i} post={p} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Facebook */}
      {organic.fb.available && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-kk-ink">Facebook</span>
            <div className="flex-1 h-px bg-kk-line" />
          </div>
          {organic.fb.metrics.length > 0
            ? <SocialMetricGroup metrics={organic.fb.metrics} />
            : <p className="text-xs text-kk-muted">No data available.</p>
          }
        </div>
      )}
    </section>
  )
}

// ── GBP card ──────────────────────────────────────────────────────────────────
// Pending state: muted kk-soft background with integration status message.
// Connected state: white card with metrics.

function GbpCard({ gbp }: { gbp: MorningBriefSections['gbp'] }) {
  if (gbp.integration_kind === 'pending_approval' || gbp.integration_kind === 'connected_no_sync') {
    const message = gbp.integration_kind === 'pending_approval'
      ? 'API approval pending — review queue and rating data will appear here once active.'
      : 'Connected — awaiting first sync.'

    return (
      <div className="bg-kk-soft border border-kk-line rounded-xl p-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-7 h-7 rounded-lg bg-kk-line flex items-center justify-center">
            <span className="text-kk-muted text-[9px] font-bold tracking-tight">GBP</span>
          </div>
          <div className="min-w-0 pt-0.5">
            <div className="text-xs font-semibold text-kk-ink mb-1">Google Business Profile</div>
            <div className="text-xs text-kk-muted leading-relaxed">{message}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl p-4">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted mb-3">
        Google Business Profile
      </div>
      {gbp.assessment && (
        <p className="text-xs text-kk-ink leading-relaxed mb-3">{gbp.assessment}</p>
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

  // KPI strip: first 3 paid aggregate metrics + first 2 IG metrics (cap at 5)
  const kpiMetrics: BriefMetricRow[] = [
    ...(sections?.paid.metrics.slice(0, 3) ?? []),
    ...(sections?.organic.ig.metrics.slice(0, 2) ?? []),
  ].slice(0, 5)

  return (
    <div className="space-y-5">
      {isStale && staleReason && (
        <StaleBanner briefDate={brief.brief_date} reason={staleReason} />
      )}

      {/* 1 — Executive status hero */}
      {brief.overall_status && (
        <BriefStatus
          status={brief.overall_status}
          reason={brief.overall_reason ?? null}
          summary={brief.ai_summary ?? null}
        />
      )}

      {/* 2 — KPI orientation strip */}
      {kpiMetrics.length > 0 && <KpiStrip metrics={kpiMetrics} />}

      {/* 3 — Main analytical grid: Paid (wider) | Organic + GBP */}
      {sections && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-x-12 gap-y-10 pt-3">
          <PaidSection paid={sections.paid} />

          <div className="space-y-7">
            <OrganicSection organic={sections.organic} />
            <GbpCard gbp={sections.gbp} />
          </div>
        </div>
      )}

      {/* 4 — Operational tail */}
      {sections && (
        <div className="grid grid-cols-2 gap-8 pt-6 mt-2 border-t border-kk-line">
          {/* Today's Content */}
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted mb-3">
              Today&apos;s Content
            </h2>
            <p className="text-xs text-kk-muted">Nothing scheduled.</p>
          </div>

          {/* Needs Review */}
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-kk-muted mb-3">
              Needs Review
            </h2>
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
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Morning Brief</h1>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1">
            <span className="text-sm text-kk-muted">{headerDate}</span>
            {displayBrief?.generated_at && (
              <>
                <span className="text-kk-line select-none">·</span>
                <span className="text-xs text-kk-muted">
                  {isStale
                    ? `From ${formatDate(displayBrief.brief_date)}, generated ${formatTime(displayBrief.generated_at)}`
                    : `Generated ${formatTime(displayBrief.generated_at)}`
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
