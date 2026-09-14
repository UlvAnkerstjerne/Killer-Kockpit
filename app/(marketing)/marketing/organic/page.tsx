import {
  getIgAccountDailyMetrics,
  getIgMediaFeed,
  getFbPageInsights,
  getFbPosts,
} from '@/lib/actions/marketing/meta-assets'
import IgThumbnail from './IgThumbnail'

export const dynamic = 'force-dynamic'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1_000) + 'K'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString('en-GB')
}

function fmtGrowth(n: number): string {
  const abs = fmt(Math.abs(n))
  return n >= 0 ? `+${abs}` : `−${abs}`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function mediaTypeLabel(t: string): string {
  return (
    ({ IMAGE: 'Image', VIDEO: 'Video', CAROUSEL_ALBUM: 'Carousel', REEL: 'Reel' } as Record<string, string>)[t] ?? t
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function OrganicPage() {
  // Date range for FB page insights: last 15 days
  const endDate   = new Date().toISOString().slice(0, 10)
  const startDate = new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)

  const [igDaily, igMedia, fbDaily, fbPosts] = await Promise.all([
    getIgAccountDailyMetrics(16),   // 16 rows: index 0 = today, index 14 = 14 days ago
    getIgMediaFeed(10),
    getFbPageInsights(startDate, endDate),
    getFbPosts(10),
  ])

  // ── IG stats ─────────────────────────────────────────────────────────────────
  // igDaily is ordered newest-first
  const igToday = igDaily[0] ?? null
  const ig7     = igDaily[7]  ?? null   // 7 days ago
  const ig14    = igDaily[14] ?? null   // 14 days ago

  const igFollowersToday = igToday?.followers_count ?? null
  const igGrowth7 =
    igFollowersToday !== null && ig7?.followers_count != null
      ? igFollowersToday - ig7.followers_count
      : null
  const igGrowth14 =
    igFollowersToday !== null && ig14?.followers_count != null
      ? igFollowersToday - ig14.followers_count
      : null

  // Last 7 days for reach bar chart (oldest → newest)
  const igReachTrend = igDaily.slice(0, 7).reverse()

  // ── FB stats ─────────────────────────────────────────────────────────────────
  // fbDaily is ordered newest-first
  const fbToday    = fbDaily[0] ?? null
  const fb7        = fbDaily[6] ?? null   // 7 rows back = 7 days ago within the 15-day window

  const fbFansToday = fbToday?.fan_count ?? null
  const fbGrowth7 =
    fbFansToday !== null && fb7?.fan_count != null
      ? fbFansToday - fb7.fan_count
      : null

  // Engagement rate: engaged_users ÷ views (not fan_count)
  const fbEngRate =
    fbToday?.engaged_users != null && fbToday?.views != null && fbToday.views > 0
      ? (fbToday.engaged_users / fbToday.views) * 100
      : null

  const fbViewsTrend   = fbDaily.slice(0, 7).reverse()
  const fbEngagedTrend = fbDaily.slice(0, 7).reverse()

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Organic</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Marketing · Organic · Instagram &amp; Facebook
        </p>
      </div>

      <div className="space-y-4">

        {/* ── Instagram ──────────────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Instagram</span>
            <span className="text-xs text-kk-muted">Organic account metrics</span>
          </div>

          <div className="px-5 py-4 flex items-start gap-8 flex-wrap border-b border-kk-line">
            <div>
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">Followers</div>
              <div className="text-3xl font-black text-kk-ink leading-none">
                {igFollowersToday !== null ? fmt(igFollowersToday) : '—'}
              </div>
              <div className="text-xs text-kk-muted mt-1">
                {igToday?.date ? fmtDateLong(igToday.date) : 'today'}
              </div>
            </div>

            {igGrowth7 !== null && (
              <div className="pb-0.5">
                <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">7-day growth</div>
                <div className={['text-xl font-bold leading-none', igGrowth7 >= 0 ? 'text-kk-good' : 'text-kk-bad'].join(' ')}>
                  {fmtGrowth(igGrowth7)}
                </div>
                <div className="text-xs text-kk-muted mt-1">followers</div>
              </div>
            )}

            {igGrowth14 !== null && (
              <div className="pb-0.5">
                <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">14-day growth</div>
                <div className={['text-xl font-bold leading-none', igGrowth14 >= 0 ? 'text-kk-good' : 'text-kk-bad'].join(' ')}>
                  {fmtGrowth(igGrowth14)}
                </div>
                <div className="text-xs text-kk-muted mt-1">followers</div>
              </div>
            )}
          </div>

          <div className="px-5 py-4">
            <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-3">
              Daily Reach — last 7 days
            </div>
            {igReachTrend.length > 0 ? (
              <MetricBars rows={igReachTrend.map(r => ({ date: r.date, value: r.reach }))} />
            ) : (
              <p className="text-sm text-kk-muted">No reach data available.</p>
            )}
          </div>
        </section>

        {/* ── Facebook ───────────────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Facebook</span>
            <span className="text-xs text-kk-muted">Organic page metrics</span>
          </div>

          <div className="px-5 py-4 flex items-start gap-8 flex-wrap border-b border-kk-line">
            <div>
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">Page Fans</div>
              <div className="text-3xl font-black text-kk-ink leading-none">
                {fbFansToday !== null ? fmt(fbFansToday) : '—'}
              </div>
              <div className="text-xs text-kk-muted mt-1">
                {fbToday?.date ? fmtDateLong(fbToday.date) : 'today'}
              </div>
            </div>

            {fbGrowth7 !== null && (
              <div className="pb-0.5">
                <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">7-day fan growth</div>
                <div className={['text-xl font-bold leading-none', fbGrowth7 >= 0 ? 'text-kk-good' : 'text-kk-bad'].join(' ')}>
                  {fmtGrowth(fbGrowth7)}
                </div>
                <div className="text-xs text-kk-muted mt-1">fans</div>
              </div>
            )}

            {fbToday?.engaged_users != null && (
              <div className="pb-0.5">
                <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">Engaged Users</div>
                <div className="text-xl font-bold text-kk-ink leading-none">{fmt(fbToday.engaged_users)}</div>
                <div className="text-xs text-kk-muted mt-1">today</div>
              </div>
            )}

            {fbEngRate !== null && (
              <div className="pb-0.5">
                <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-1">Engagement Rate</div>
                <div className="text-xl font-bold text-kk-ink leading-none">{fbEngRate.toFixed(2)}%</div>
                <div className="text-xs text-kk-muted mt-1">engaged / views</div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-kk-line">
            <div className="px-5 py-4">
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-3">
                Daily Views — last 7 days
              </div>
              {fbViewsTrend.length > 0 ? (
                <MetricBars rows={fbViewsTrend.map(r => ({ date: r.date, value: r.views }))} />
              ) : (
                <p className="text-sm text-kk-muted">No views data available.</p>
              )}
            </div>

            <div className="px-5 py-4">
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-3">
                Engaged Users — last 7 days
              </div>
              {fbEngagedTrend.length > 0 ? (
                <MetricBars rows={fbEngagedTrend.map(r => ({ date: r.date, value: r.engaged_users }))} />
              ) : (
                <p className="text-sm text-kk-muted">No engagement data available.</p>
              )}
            </div>
          </div>
        </section>

        {/* ── Content ────────────────────────────────────────────────────────── */}
        <section>
          {/* Section header */}
          <div className="mb-3">
            <h2 className="text-lg font-bold text-kk-ink">Content</h2>
            <p className="text-sm text-kk-muted mt-0.5">Instagram · Recent posts</p>
          </div>

          {igMedia.length > 0 && (
            <div className="space-y-2">
              {igMedia.map(post => {
                const thumbSrc = post.thumbnail_url ?? post.media_url ?? null
                const isVideo = post.media_type === 'VIDEO' || post.media_type === 'REEL'
                const primaryLabel = isVideo ? 'Views' : 'Reach'
                const primaryValue = isVideo ? post.plays : post.reach

                const cells = [
                  { label: primaryLabel, value: primaryValue != null ? fmt(primaryValue) : '—' },
                  { label: 'Likes',    value: post.likes          != null ? fmt(post.likes)          : '—' },
                  { label: 'Comments', value: post.comments_count  != null ? fmt(post.comments_count)  : '—' },
                  { label: 'Shares',   value: post.shares          != null ? fmt(post.shares)          : '—' },
                  { label: 'Saves',    value: post.saved           != null ? fmt(post.saved)           : '—' },
                ]

                return (
                  <div key={post.id} className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden">

                    {/* ── Card header: type | date + link ── */}
                    <div className="px-4 py-2.5 flex items-center justify-between bg-[#DDD9D1]">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-white/60 text-kk-muted">
                        {mediaTypeLabel(post.media_type)}
                      </span>
                      <div className="flex items-center gap-3">
                        {post.published_at && (
                          <span className="text-xs text-kk-muted">{fmtDateLong(post.published_at)}</span>
                        )}
                        {post.permalink && (
                          <a
                            href={post.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-kk-ink underline underline-offset-2"
                          >
                            View ↗
                          </a>
                        )}
                      </div>
                    </div>

                    {/* ── Card body: thumbnail + metrics ── */}
                    <div className="flex min-h-[112px]">
                      {/* Thumbnail — 112 px wide, fills full height */}
                      <div className="w-28 shrink-0 border-r border-kk-line overflow-hidden bg-kk-soft">
                        <IgThumbnail src={thumbSrc} />
                      </div>

                      {/* Metrics — 5 equal columns, Paid-style inline label: value */}
                      <div
                        className="flex-1 divide-x divide-kk-line"
                        style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' }}
                      >
                        {cells.map((cell, i) => (
                          <div key={i} className="px-3 py-4 flex items-center gap-1.5">
                            <span className="text-base font-medium text-kk-muted whitespace-nowrap">{cell.label}:</span>
                            <span className="text-base font-bold text-kk-ink tabular-nums">{cell.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                  </div>
                )
              })}
            </div>
          )}

          {igMedia.length === 0 && (
            <div className="bg-kk-panel border border-kk-line rounded-xl px-5 py-6 text-sm text-kk-muted">
              No Instagram posts synced yet.
            </div>
          )}

          {/* ── Facebook — compact list, unchanged ── */}
          {fbPosts.length > 0 && (
            <div className="mt-4 bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-kk-line bg-kk-soft">
                <span className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">Facebook</span>
              </div>
              <div className="divide-y divide-kk-line">
                {fbPosts.map(post => (
                  <div key={post.id} className="px-5 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-kk-soft text-kk-muted shrink-0">
                          {post.post_type}
                        </span>
                        <span className="text-xs text-kk-muted">{fmtDateLong(post.published_at)}</span>
                      </div>
                      {post.message && (
                        <p className="text-sm text-kk-ink line-clamp-2 mt-1">{post.message}</p>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-3">
                      <span className="text-xs text-kk-muted italic">Unavailable</span>
                      {post.permalink && (
                        <a
                          href={post.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-kk-ink underline underline-offset-2 shrink-0"
                        >
                          View ↗
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

      </div>
    </div>
  )
}

// ─── Bar chart helper ──────────────────────────────────────────────────────────

function MetricBars({ rows }: { rows: { date: string; value: number | null }[] }) {
  const max = Math.max(...rows.map(r => r.value ?? 0), 1)
  return (
    <div className="space-y-2">
      {rows.map(row => (
        <div key={row.date} className="flex items-center gap-3">
          <span className="text-xs text-kk-muted w-14 shrink-0">{fmtDate(row.date)}</span>
          <div className="flex-1 h-2 bg-kk-soft rounded-full overflow-hidden">
            <div
              className="h-full bg-kk-ink rounded-full"
              style={{ width: row.value !== null ? `${(row.value / max) * 100}%` : '0%' }}
            />
          </div>
          <span className="text-xs font-semibold text-kk-ink w-14 text-right shrink-0">
            {row.value !== null ? fmt(row.value) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}
