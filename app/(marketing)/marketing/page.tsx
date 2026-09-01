import { getCurrentUser } from '@/lib/auth'
import {
  getLatestMorningBrief,
  getLastReadyMorningBrief,
} from '@/lib/actions/marketing/morning-brief'
import RegenerateButton from './RegenerateButton'
import type { MorningBriefRow, MorningBriefSections, GbpIntegrationStatusKind } from '@/lib/marketing/brief/types'

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

// ── Status indicator ──────────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'green' | 'amber' | 'red' }) {
  const classes = {
    green: 'bg-green-500',
    amber: 'bg-amber-400',
    red:   'bg-red-500',
  }
  const labels = { green: 'Green', amber: 'Amber', red: 'Red' }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${classes[status]}`} />
      <span className="text-sm font-medium text-kk-ink">{labels[status]}</span>
    </span>
  )
}

// ── Metric table ──────────────────────────────────────────────────────────────

function MetricRow({ label, value, change, highlight }: {
  label: string; value: string; change?: string; highlight?: boolean
}) {
  return (
    <div className={`flex items-center justify-between py-2 border-b border-kk-line last:border-0 ${highlight ? 'bg-amber-50 -mx-3 px-3 rounded' : ''}`}>
      <span className="text-sm text-kk-muted">{label}</span>
      <div className="flex items-center gap-2">
        {change && <span className="text-xs text-kk-muted">{change}</span>}
        <span className={`text-sm font-medium ${highlight ? 'text-amber-700' : 'text-kk-ink'}`}>{value}</span>
      </div>
    </div>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

// ── Paid section ──────────────────────────────────────────────────────────────

function PaidSection({ paid }: { paid: MorningBriefSections['paid'] }) {
  return (
    <SectionCard title="Paid">
      <p className="text-sm text-kk-ink mb-4 leading-relaxed">{paid.assessment}</p>

      {paid.anomalies.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {paid.anomalies.map((a, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
              <span className="shrink-0 font-semibold mt-0.5">⚠</span>
              <span>{a}</span>
            </div>
          ))}
        </div>
      )}

      {paid.metrics.length > 0 && (
        <div className="mb-4">
          {paid.metrics.map((m, i) => (
            <MetricRow key={i} {...m} />
          ))}
        </div>
      )}

      {paid.active_campaign_summaries.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-xs font-medium text-kk-muted uppercase tracking-wide mb-2">Active campaigns</div>
          {paid.active_campaign_summaries.map((c, i) => (
            <div key={i} className={`flex items-center justify-between text-xs py-1.5 ${c.anomaly_flag ? 'text-amber-700' : 'text-kk-muted'}`}>
              <span className="font-medium text-kk-ink truncate max-w-[200px]">{c.name}</span>
              <span>{c.spend_7d_formatted ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      {paid.pending_review_count > 0 && (
        <div className="mt-4 pt-3 border-t border-kk-line">
          <a href="/marketing/needs-review" className="text-xs text-kk-accent hover:underline">
            {paid.pending_review_count} paid item{paid.pending_review_count !== 1 ? 's' : ''} awaiting review →
          </a>
        </div>
      )}
    </SectionCard>
  )
}

// ── Organic section ───────────────────────────────────────────────────────────

function OrganicSection({ organic }: { organic: MorningBriefSections['organic'] }) {
  return (
    <SectionCard title="Organic">
      <p className="text-sm text-kk-ink mb-4 leading-relaxed">{organic.assessment}</p>

      {/* Instagram */}
      <div className="mb-4">
        <div className="text-xs font-medium text-kk-muted uppercase tracking-wide mb-2">Instagram</div>
        {organic.ig.metrics.map((m, i) => (
          <MetricRow key={i} {...m} />
        ))}
      </div>

      {organic.ig.notable_posts.length > 0 && (
        <div className="mb-4 space-y-2">
          <div className="text-xs font-medium text-kk-muted uppercase tracking-wide">Notable posts</div>
          {organic.ig.notable_posts.slice(0, 3).map((p, i) => (
            <div key={i} className="text-xs text-kk-muted border border-kk-line rounded-lg px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-kk-ink capitalize">{p.media_type.toLowerCase()}</span>
                <span>{p.published_at.slice(0, 10)}</span>
              </div>
              {p.caption_truncated && (
                <div className="mt-1 text-kk-muted italic line-clamp-1">&ldquo;{p.caption_truncated}&rdquo;</div>
              )}
              <div className="mt-1 flex items-center gap-3">
                {p.reach != null && <span>Reach: {p.reach.toLocaleString()}</span>}
                {p.performance_label && (
                  <span className={p.performance_label.startsWith('+') ? 'text-green-600' : 'text-kk-muted'}>
                    {p.performance_label}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Facebook */}
      {organic.fb.available && (
        <div>
          <div className="text-xs font-medium text-kk-muted uppercase tracking-wide mb-2">Facebook</div>
          {organic.fb.metrics.length > 0
            ? organic.fb.metrics.map((m, i) => <MetricRow key={i} {...m} />)
            : <p className="text-xs text-kk-muted">No Facebook page data available yet.</p>
          }
        </div>
      )}
    </SectionCard>
  )
}

// ── GBP section ───────────────────────────────────────────────────────────────

function GbpStatusMessage({ kind }: { kind: GbpIntegrationStatusKind }) {
  if (kind === 'pending_approval') {
    return (
      <p className="text-sm text-kk-muted">
        Google Business Profile integration is pending API approval.
        Review queue and rating summaries will appear here once the integration is active.
      </p>
    )
  }
  if (kind === 'connected_no_sync') {
    return (
      <p className="text-sm text-kk-muted">
        Google Business Profile is connected but sync has not yet run.
        Data will appear after the first sync completes.
      </p>
    )
  }
  return null
}

function GbpSection({ gbp }: { gbp: MorningBriefSections['gbp'] }) {
  return (
    <SectionCard title="Google Business Profile">
      <GbpStatusMessage kind={gbp.integration_kind} />

      {gbp.assessment && (
        <p className="text-sm text-kk-ink mb-3 leading-relaxed">{gbp.assessment}</p>
      )}

      {gbp.integration_kind === 'connected' && (
        <div className="space-y-1">
          {gbp.new_reviews_yesterday != null && (
            <MetricRow label="New reviews yesterday" value={String(gbp.new_reviews_yesterday)} />
          )}
          {gbp.avg_star_rating_7d != null && (
            <MetricRow label="Avg rating (7d)" value={`${gbp.avg_star_rating_7d.toFixed(1)} / 5`} />
          )}
          {gbp.pending_reply_count > 0 && (
            <div className="pt-2 border-t border-kk-line mt-2">
              <a href="/marketing/google-business-profile" className="text-xs text-kk-accent hover:underline">
                {gbp.pending_reply_count} review {gbp.pending_reply_count === 1 ? 'reply' : 'replies'} awaiting approval →
              </a>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// ── Today's content section ───────────────────────────────────────────────────

function ContentSection() {
  return (
    <SectionCard title="Today's Content">
      <p className="text-sm text-kk-muted">No content scheduled.</p>
    </SectionCard>
  )
}

// ── Needs Review section ──────────────────────────────────────────────────────

function NeedsReviewSection({ needsReview }: { needsReview: MorningBriefSections['needs_review'] }) {
  return (
    <SectionCard title="Needs Review">
      {needsReview.total === 0 ? (
        <p className="text-sm text-kk-muted">Nothing awaiting your approval right now.</p>
      ) : (
        <div>
          <div className="space-y-2 mb-3">
            {needsReview.items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-kk-muted">{item.label}</span>
                <span className="font-medium text-kk-ink">{item.count}</span>
              </div>
            ))}
          </div>
          <a href="/marketing/needs-review" className="text-xs text-kk-accent hover:underline">
            Review all {needsReview.total} item{needsReview.total !== 1 ? 's' : ''} →
          </a>
        </div>
      )}
    </SectionCard>
  )
}

// ── Stale banner ──────────────────────────────────────────────────────────────

function StaleBanner({ briefDate, reason }: { briefDate: string; reason: string }) {
  return (
    <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800">
      <span className="font-semibold">⚠ Showing brief from {formatDate(briefDate)}</span>
      {' — '}
      {reason}
    </div>
  )
}

// ── Full brief render ─────────────────────────────────────────────────────────

function MorningBriefContent({ brief, isStale, staleReason }: {
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

      {/* Overall status + summary */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-5">
        <div className="flex items-center gap-3 mb-3">
          {brief.overall_status && <StatusDot status={brief.overall_status} />}
          {brief.overall_reason && (
            <span className="text-sm text-kk-muted">{brief.overall_reason}</span>
          )}
        </div>

        {brief.ai_summary && (
          <p className="text-sm text-kk-ink leading-relaxed">{brief.ai_summary}</p>
        )}
      </div>

      {/* Sections */}
      {sections && (
        <>
          <PaidSection paid={sections.paid} />
          <OrganicSection organic={sections.organic} />
          <GbpSection gbp={sections.gbp} />
          <ContentSection />
          <NeedsReviewSection needsReview={sections.needs_review} />
        </>
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

  // Determine what to render
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
    // Showing a brief from a previous day
    readyBrief = latestBrief
    isStale = true
    staleReason = "Today's brief has not been generated yet."
  }

  // If today's brief failed, also try to show the last ready one
  let fallbackBrief: MorningBriefRow | null = null
  if (stateMessage === 'failed') {
    fallbackBrief = await getLastReadyMorningBrief()
    if (fallbackBrief && fallbackBrief.brief_date !== today) {
      isStale = true
      staleReason = `Today's brief failed to generate. Showing brief from ${formatDate(fallbackBrief.brief_date)}.`
    }
  }

  const displayBrief = readyBrief ?? fallbackBrief

  // Page header date
  const headerDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Europe/Copenhagen',
  })

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Morning Brief</h1>
          <p className="text-sm text-kk-muted mt-0.5">{headerDate}</p>
          {displayBrief?.generated_at && (
            <p className="text-xs text-kk-muted mt-0.5">
              {isStale
                ? `Brief from ${formatDate(displayBrief.brief_date)}, generated at ${formatTime(displayBrief.generated_at)}`
                : `Generated today at ${formatTime(displayBrief.generated_at)}`
              }
            </p>
          )}
        </div>

        {isAdmin && (
          <div className="shrink-0 pt-1">
            <RegenerateButton />
          </div>
        )}
      </div>

      {/* Ready brief */}
      {displayBrief && (
        <MorningBriefContent
          brief={displayBrief}
          isStale={isStale}
          staleReason={isStale ? staleReason : undefined}
        />
      )}

      {/* Generating state (today's brief is in progress, no fallback) */}
      {stateMessage === 'generating' && !displayBrief && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-12 text-center">
          <div className="text-sm text-kk-muted">Morning Brief is being generated…</div>
          <div className="text-xs text-kk-muted mt-1">This usually takes less than a minute.</div>
        </div>
      )}

      {/* Failed state — no fallback available */}
      {stateMessage === 'failed' && !displayBrief && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-12 text-center">
          <div className="text-sm text-kk-muted">Today&apos;s brief could not be generated.</div>
          <div className="text-xs text-kk-muted mt-1">
            {latestBrief?.error_message ?? 'An error occurred during generation.'}
          </div>
          {isAdmin && (
            <div className="mt-4">
              <RegenerateButton />
            </div>
          )}
        </div>
      )}

      {/* No brief at all */}
      {!displayBrief && !stateMessage && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-12 text-center">
          <div className="text-sm text-kk-muted">No Morning Brief has been generated yet.</div>
          <div className="text-xs text-kk-muted mt-1">
            Briefs are generated daily at approximately 09:00 Copenhagen time.
          </div>
          {isAdmin && (
            <div className="mt-4">
              <RegenerateButton />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
