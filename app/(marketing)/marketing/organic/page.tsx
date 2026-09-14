import {
  getIgAccountDailyMetrics,
  getIgMediaFeed,
  getFbPageInsights,
  getFbPosts,
} from '@/lib/actions/marketing/meta-assets'

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
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Content</span>
            <span className="text-xs text-kk-muted italic">Post-level performance not yet synced</span>
          </div>

          {igMedia.length > 0 && (
            <div>
              <div className="px-5 py-3 border-b border-kk-line bg-kk-soft">
                <span className="text-xs font-semibold text-kk-muted uppercase tracking-wider">Instagram</span>
              </div>
              <div className="divide-y divide-kk-line">
                {igMedia.map(post => {
                  const thumbSrc = post.thumbnail_url ?? post.media_url ?? null
                  return (
                  <div key={post.id} className="px-5 py-3 flex items-center gap-3">
                    {/* Thumbnail */}
                    <div className="shrink-0 w-14 h-14 rounded-lg overflow-hidden bg-kk-soft flex items-center justify-center">
                      {thumbSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumbSrc}
                          alt=""
                          width={56}
                          height={56}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <span className="text-kk-muted text-[10px] text-center leading-tight px-1">No preview</span>
                      )}
                    </div>
                    {/* Meta */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-kk-soft text-kk-muted shrink-0">
                          {mediaTypeLabel(post.media_type)}
                        </span>
                        {post.published_at && (
                          <span className="text-xs text-kk-muted">{fmtDateLong(post.published_at)}</span>
                        )}
                      </div>
                      {post.caption && (
                        <p className="text-sm text-kk-ink line-clamp-2 mt-1">{post.caption}</p>
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
                  )
                })}
              </div>
            </div>
          )}

          {fbPosts.length > 0 && (
            <div className={igMedia.length > 0 ? 'border-t border-kk-line' : ''}>
              <div className="px-5 py-3 border-b border-kk-line bg-kk-soft">
                <span className="text-xs font-semibold text-kk-muted uppercase tracking-wider">Facebook</span>
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

          {igMedia.length === 0 && fbPosts.length === 0 && (
            <div className="px-5 py-6 text-sm text-kk-muted">No posts synced yet.</div>
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
