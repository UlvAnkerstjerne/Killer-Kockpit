'use client'

import { useRouter, usePathname } from 'next/navigation'
import type { GbpLocationRow, GbpReviewRow } from '@/lib/actions/marketing/gbp-reviews'
import type { GbpPerformanceData, GbpKeywordRow } from '@/lib/actions/marketing/gbp-performance'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  locations:          GbpLocationRow[]
  selectedLocationId: string | null
  days:               28 | 90
  performance:        GbpPerformanceData
  reviews:            GbpReviewRow[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtN(n: number | null): string {
  if (n === null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000)    return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString('en-US')
}

function fmtKeyword(kw: GbpKeywordRow): string {
  if (kw.impressions !== null) return fmtN(kw.impressions)
  if (kw.impressionsThreshold !== null) return `<${fmtN(kw.impressionsThreshold)}`
  return '—'
}

function fmtMonth(isoMonth: string | null): string {
  if (!isoMonth) return ''
  const [year, month] = isoMonth.split('-')
  const d = new Date(Number(year), Number(month) - 1, 1)
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

// ── Reviews section helpers ────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  new:                  'Draft pending',
  awaiting_review:      'Needs review',
  approved:             'Approved',
  rejected:             'Rejected',
  published:            'Published',
  publish_failed:       'Publish failed',
  externally_published: 'Replied externally',
}
const STATUS_CLASS: Record<string, string> = {
  new:                  'bg-kk-muted/10 text-kk-muted',
  awaiting_review:      'bg-amber-50 text-amber-700',
  approved:             'bg-blue-50 text-blue-700',
  rejected:             'bg-red-50 text-red-700',
  published:            'bg-green-50 text-green-700',
  publish_failed:       'bg-red-50 text-red-700',
  externally_published: 'bg-kk-muted/10 text-kk-muted',
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="text-amber-400 text-sm" aria-label={`${rating} out of 5 stars`}>
      {'★'.repeat(rating)}{'☆'.repeat(5 - rating)}
    </span>
  )
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-4">
      <div className="text-xs text-kk-muted font-medium mb-2">{label}</div>
      <div className="text-2xl font-black text-kk-ink">{value}</div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function GbpDashboard({
  locations,
  selectedLocationId,
  days,
  performance,
  reviews,
}: Props) {
  const router   = useRouter()
  const pathname = usePathname()

  function navigate(locId: string | null, newDays: 28 | 90) {
    const params = new URLSearchParams()
    if (locId) params.set('location', locId)
    if (newDays !== 28) params.set('period', String(newDays))
    const qs = params.toString()
    router.push(pathname + (qs ? `?${qs}` : ''))
  }

  const { kpis, breakdown, locationSummaries, topKeywords, keywordMonth, dateRange, hasData } = performance

  return (
    <div className="space-y-6">

      {/* ── Selectors ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Location selector */}
        <select
          value={selectedLocationId ?? 'all'}
          onChange={(e) => navigate(e.target.value === 'all' ? null : e.target.value, days)}
          className="border border-kk-line rounded-xl px-3 py-2 text-sm bg-kk-panel text-kk-ink focus:outline-none focus:ring-2 focus:ring-kk-accent/30"
          aria-label="Select location"
        >
          <option value="all">All Stores</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>{loc.store_name}</option>
          ))}
        </select>

        {/* Period tabs */}
        <div className="flex border border-kk-line rounded-xl overflow-hidden text-sm">
          {([28, 90] as const).map((d, i) => (
            <button
              key={d}
              onClick={() => navigate(selectedLocationId, d)}
              className={[
                'px-4 py-2 font-medium transition-colors',
                i > 0 ? 'border-l border-kk-line' : '',
                days === d
                  ? 'bg-kk-ink text-white'
                  : 'bg-kk-panel text-kk-muted hover:bg-kk-line/30',
              ].join(' ')}
            >
              {d}d
            </button>
          ))}
        </div>

        {dateRange.start && (
          <span className="text-xs text-kk-muted">
            {dateRange.start} — {dateRange.end}
          </span>
        )}
      </div>

      {/* ── Performance section ──────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-black tracking-wide text-kk-muted uppercase mb-3">Performance</h2>

        {/* KPI cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
          <KpiCard label="Search Impressions" value={fmtN(kpis.searchImpressions)} />
          <KpiCard label="Maps Impressions"   value={fmtN(kpis.mapsImpressions)} />
          <KpiCard label="Website Clicks"     value={fmtN(kpis.websiteClicks)} />
          <KpiCard label="Call Clicks"        value={fmtN(kpis.callClicks)} />
          <KpiCard label="Direction Requests" value={fmtN(kpis.directionRequests)} />
        </div>

        {/* Impressions breakdown */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4 mb-4">
          <div className="text-xs font-bold text-kk-muted uppercase tracking-wide mb-3">Impressions breakdown</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] text-kk-muted mb-1">Search</div>
              <div className="flex gap-4 text-sm">
                <span><span className="text-kk-muted text-xs">Desktop</span> <span className="font-semibold text-kk-ink">{fmtN(breakdown.desktopSearch)}</span></span>
                <span><span className="text-kk-muted text-xs">Mobile</span> <span className="font-semibold text-kk-ink">{fmtN(breakdown.mobileSearch)}</span></span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-kk-muted mb-1">Maps</div>
              <div className="flex gap-4 text-sm">
                <span><span className="text-kk-muted text-xs">Desktop</span> <span className="font-semibold text-kk-ink">{fmtN(breakdown.desktopMaps)}</span></span>
                <span><span className="text-kk-muted text-xs">Mobile</span> <span className="font-semibold text-kk-ink">{fmtN(breakdown.mobileMaps)}</span></span>
              </div>
            </div>
          </div>
        </div>

        {!hasData && (
          <div className="text-sm text-kk-muted bg-kk-panel border border-kk-line rounded-2xl px-5 py-4">
            No performance data yet — run a sync to populate metrics.
          </div>
        )}
      </section>

      {/* ── Top searches ──────────────────────────────────────────────────── */}
      {topKeywords.length > 0 && (
        <section>
          <h2 className="text-sm font-black tracking-wide text-kk-muted uppercase mb-3">
            Top Searches {keywordMonth ? `— ${fmtMonth(keywordMonth)}` : ''}
          </h2>
          <div className="bg-kk-panel border border-kk-line rounded-2xl divide-y divide-kk-line">
            {topKeywords.map((kw, i) => (
              <div key={kw.keyword} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-kk-muted w-5 text-right">{i + 1}</span>
                  <span className="text-sm text-kk-ink">{kw.keyword}</span>
                </div>
                <span className="text-sm font-semibold text-kk-ink tabular-nums">
                  {fmtKeyword(kw)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Location summary table ─────────────────────────────────────────── */}
      {locationSummaries.length > 1 && (
        <section>
          <h2 className="text-sm font-black tracking-wide text-kk-muted uppercase mb-3">By Location</h2>
          <div className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-kk-line bg-kk-line/20">
                  <th className="text-left px-5 py-3 text-xs font-bold text-kk-muted uppercase tracking-wide">Store</th>
                  <th className="text-right px-4 py-3 text-xs font-bold text-kk-muted uppercase tracking-wide">Impressions</th>
                  <th className="text-right px-4 py-3 text-xs font-bold text-kk-muted uppercase tracking-wide">Website</th>
                  <th className="text-right px-4 py-3 text-xs font-bold text-kk-muted uppercase tracking-wide">Calls</th>
                  <th className="text-right px-4 py-3 text-xs font-bold text-kk-muted uppercase tracking-wide">Directions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-kk-line">
                {locationSummaries.map((row) => (
                  <tr key={row.gbpLocationId}>
                    <td className="px-5 py-3 font-medium text-kk-ink">{row.storeShortName}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-kk-ink">{fmtN(row.totalImpressions)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-kk-ink">{fmtN(row.websiteClicks)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-kk-ink">{fmtN(row.callClicks)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-kk-ink">{fmtN(row.directionRequests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Reviews ──────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-black tracking-wide text-kk-muted uppercase mb-3">Reviews</h2>

        {locations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-sm text-kk-muted">No Google Business Profile locations configured.</div>
            <div className="text-xs text-kk-muted mt-1">Contact your administrator to set up GBP locations.</div>
          </div>
        ) : reviews.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="text-sm text-kk-muted">Waiting for Google API access.</div>
            <div className="text-xs text-kk-muted mt-1">
              Reviews will appear here once the GBP Reviews API is approved for this account.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {reviews.map((review) => {
              const location   = Array.isArray(review.location) ? review.location[0] : review.location
              const reply      = Array.isArray(review.reply)    ? review.reply[0]    : review.reply
              const replyStatus = reply?.status ?? (review.existing_reply_text ? 'externally_published' : 'new')
              const canReview  = replyStatus === 'awaiting_review'

              return (
                <div key={review.id} className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StarRating rating={review.star_rating} />
                        <span className="text-xs text-kk-muted font-medium">
                          {location?.store_short_name ?? '—'}
                        </span>
                        {review.reviewer_name && (
                          <span className="text-xs text-kk-muted">· {review.reviewer_name}</span>
                        )}
                        <span className="text-xs text-kk-muted">
                          · {new Date(review.review_created_at).toLocaleDateString('da-DK', {
                              timeZone: 'Europe/Copenhagen',
                            })}
                        </span>
                      </div>
                      {review.review_text && (
                        <div className="mt-2 text-sm text-kk-ink line-clamp-3">{review.review_text}</div>
                      )}
                      <div className="mt-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[replyStatus] ?? 'bg-kk-muted/10 text-kk-muted'}`}>
                          {STATUS_LABEL[replyStatus] ?? replyStatus}
                        </span>
                      </div>
                    </div>
                    {canReview && reply && (
                      <a
                        href={`/marketing/google-business-profile/reviews/${reply.id}`}
                        className="shrink-0 text-xs font-medium text-kk-accent hover:underline"
                      >
                        Review →
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

    </div>
  )
}
