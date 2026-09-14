import { createServiceClient } from '@/lib/supabase/server'

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface IgDailyRow {
  date: string
  reach: number | null
  followers_count: number | null
}

interface FbDailyRow {
  date: string
  views: number | null
  engaged_users: number | null
  fan_count: number | null
}

interface IgMediaRow {
  id: string
  media_type: string
  caption: string | null
  permalink: string | null
  published_at: string | null
}

interface FbPostRow {
  id: string
  post_type: string | null
  message: string | null
  permalink: string | null
  published_at: string | null
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function OrganicPage() {
  const supabase = createServiceClient()

  const [
    { data: rawIgDaily },
    { data: rawFbDaily },
    { data: rawIgMedia },
    { data: rawFbPosts },
  ] = await Promise.all([
    supabase
      .from('meta_ig_account_daily')
      .select('date, reach, followers_count')
      .order('date', { ascending: false })
      .limit(16),
    supabase
      .from('meta_fb_page_insights')
      .select('date, views, engaged_users, fan_count')
      .order('date', { ascending: false })
      .limit(15),
    supabase
      .from('meta_ig_media')
      .select('id, media_type, caption, permalink, published_at')
      .order('published_at', { ascending: false })
      .limit(10),
    supabase
      .from('meta_fb_posts')
      .select('id, post_type, message, permalink, published_at')
      .order('published_at', { ascending: false })
      .limit(10),
  ])

  const igDaily: IgDailyRow[] = rawIgDaily ?? []
  const fbDaily: FbDailyRow[] = rawFbDaily ?? []
  const igMedia: IgMediaRow[] = rawIgMedia ?? []
  const fbPosts: FbPostRow[] = rawFbPosts ?? []

  // ── IG stats ────────────────────────────────────────────────────────────────

  const igToday = igDaily[0] ?? null
  const ig7 = igDaily[7] ?? null   // index 7 = 7 days ago (descending, 0-based)
  const ig14 = igDaily[14] ?? null // index 14 = 14 days ago

  const igFollowersToday = igToday?.followers_count ?? null
  const igGrowth7 =
    igFollowersToday !== null && ig7?.followers_count != null
      ? igFollowersToday - ig7.followers_count
      : null
  const igGrowth14 =
    igFollowersToday !== null && ig14?.followers_count != null
      ? igFollowersToday - ig14.followers_count
      : null

  const igReachTrend = igDaily.slice(0, 7).reverse()

  // ── FB stats ────────────────────────────────────────────────────────────────

  const fbToday = fbDaily[0] ?? null
  const fb7 = fbDaily[6] ?? null

  const fbFansToday = fbToday?.fan_count ?? null
  const fbGrowth7 =
    fbFansToday !== null && fb7?.fan_count != null
      ? fbFansToday - fb7.fan_count
      : null

  const fbViewsTrend = fbDaily.slice(0, 7).reverse()
  const fbEngagedTrend = fbDaily.slice(0, 7).reverse()

  const fbEngRate =
    fbToday?.engaged_users != null && fbToday?.views != null && fbToday.views > 0
      ? (fbToday.engaged_users / fbToday.views) * 100
      : null

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Organic</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Marketing · Organic · Instagram &amp; Facebook
        </p>
      </div>

      <div className="space-y-4">

        {/* ── Instagram ────────────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Instagram</span>
            <span className="text-xs text-kk-muted">Organic account metrics</span>
          </div>

          {/* Top stats */}
          <div className="px-5 py-4 flex items-start gap-8 flex-wrap border-b border-kk-line">
            <div>
              <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                Followers
              </div>
              <div className="text-3xl font-black text-kk-ink leading-none">
                {igFollowersToday !== null ? fmt(igFollowersToday) : '—'}
              </div>
              <div className="text-xs text-kk-muted mt-1">
                {igToday?.date ? fmtDateLong(igToday.date) : 'today'}
              </div>
            </div>

            {igGrowth7 !== null && (
              <div className="pb-0.5">
                <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                  7-day growth
                </div>
                <div className={[
                  'text-xl font-bold leading-none',
                  igGrowth7 >= 0 ? 'text-kk-good' : 'text-kk-bad',
                ].join(' ')}>
                  {fmtGrowth(igGrowth7)}
                </div>
                <div className="text-xs text-kk-muted mt-1">followers</div>
              </div>
            )}

            {igGrowth14 !== null && (
              <div className="pb-0.5">
                <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                  14-day growth
                </div>
                <div className={[
                  'text-xl font-bold leading-none',
                  igGrowth14 >= 0 ? 'text-kk-good' : 'text-kk-bad',
                ].join(' ')}>
                  {fmtGrowth(igGrowth14)}
                </div>
                <div className="text-xs text-kk-muted mt-1">followers</div>
              </div>
            )}
          </div>

          {/* Reach trend */}
          <div className="px-5 py-4">
            <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-3">
              Daily Reach — last 7 days
            </div>
            {igReachTrend.length > 0 ? (
              <ReachBars rows={igReachTrend} />
            ) : (
              <p className="text-sm text-kk-muted">No reach data available.</p>
            )}
          </div>
        </section>

        {/* ── Facebook ─────────────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Facebook</span>
            <span className="text-xs text-kk-muted">Organic page metrics</span>
          </div>

          {/* Top stats */}
          <div className="px-5 py-4 flex items-start gap-8 flex-wrap border-b border-kk-line">
            <div>
              <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                Page Fans
              </div>
              <div className="text-3xl font-black text-kk-ink leading-none">
                {fbFansToday !== null ? fmt(fbFansToday) : '—'}
              </div>
              <div className="text-xs text-kk-muted mt-1">
                {fbToday?.date ? fmtDateLong(fbToday.date) : 'today'}
              </div>
            </div>

            {fbGrowth7 !== null && (
              <div className="pb-0.5">
                <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                  7-day fan growth
                </div>
                <div className={[
                  'text-xl font-bold leading-none',
                  fbGrowth7 >= 0 ? 'text-kk-good' : 'text-kk-bad',
                ].join(' ')}>
                  {fmtGrowth(fbGrowth7)}
                </div>
                <div className="text-xs text-kk-muted mt-1">fans</div>
              </div>
            )}

            {fbToday?.engaged_users != null && (
              <div className="pb-0.5">
                <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                  Engaged Users
                </div>
                <div className="text-xl font-bold text-kk-ink leading-none">
                  {fmt(fbToday.engaged_users)}
                </div>
                <div className="text-xs text-kk-muted mt-1">today</div>
              </div>
            )}

            {fbEngRate !== null && (
              <div className="pb-0.5">
                <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">
                  Engagement Rate
                </div>
                <div className="text-xl font-bold text-kk-ink leading-none">
                  {fbEngRate.toFixed(2)}%
                </div>
                <div className="text-xs text-kk-muted mt-1">engaged / views</div>
              </div>
            )}
          </div>

          {/* Views + Engaged users trends */}
          <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-kk-line">
            <div className="px-5 py-4">
              <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-3">
                Daily Views — last 7 days
              </div>
              {fbViewsTrend.length > 0 ? (
                <MetricBars rows={fbViewsTrend.map(r => ({ date: r.date, value: r.views }))} />
              ) : (
                <p className="text-sm text-kk-muted">No views data available.</p>
              )}
            </div>

            <div className="px-5 py-4">
              <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-3">
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

        {/* ── Content ──────────────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-kk-line flex items-center gap-2">
            <span className="text-sm font-semibold text-kk-ink">Content</span>
            <span className="text-xs text-kk-muted italic">Post-level performance not yet synced</span>
          </div>

          {/* Instagram posts */}
          {igMedia.length > 0 && (
            <div>
              <div className="px-5 py-3 border-b border-kk-line bg-kk-soft">
                <span className="text-xs font-semibold text-kk-muted uppercase tracking-wider">Instagram</span>
              </div>
              <div className="divide-y divide-kk-line">
                {igMedia.map((post) => (
                  <div key={post.id} className="px-5 py-3 flex items-start gap-3">
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
                ))}
              </div>
            </div>
          )}

          {/* Facebook posts */}
          {fbPosts.length > 0 && (
            <div className={igMedia.length > 0 ? 'border-t border-kk-line' : ''}>
              <div className="px-5 py-3 border-b border-kk-line bg-kk-soft">
                <span className="text-xs font-semibold text-kk-muted uppercase tracking-wider">Facebook</span>
              </div>
              <div className="divide-y divide-kk-line">
                {fbPosts.map((post) => (
                  <div key={post.id} className="px-5 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        {post.post_type && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-kk-soft text-kk-muted shrink-0">
                            {post.post_type}
                          </span>
                        )}
                        {post.published_at && (
                          <span className="text-xs text-kk-muted">{fmtDateLong(post.published_at)}</span>
                        )}
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

// ─── Bar chart helpers ─────────────────────────────────────────────────────────

function ReachBars({ rows }: { rows: { date: string; reach: number | null }[] }) {
  const max = Math.max(...rows.map(r => r.reach ?? 0), 1)
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.date} className="flex items-center gap-3">
          <span className="text-xs text-kk-muted w-14 shrink-0">{fmtDate(row.date)}</span>
          <div className="flex-1 h-2 bg-kk-soft rounded-full overflow-hidden">
            <div
              className="h-full bg-kk-ink rounded-full"
              style={{ width: row.reach !== null ? `${(row.reach / max) * 100}%` : '0%' }}
            />
          </div>
          <span className="text-xs font-semibold text-kk-ink w-14 text-right shrink-0">
            {row.reach !== null ? fmt(row.reach) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

function MetricBars({ rows }: { rows: { date: string; value: number | null }[] }) {
  const max = Math.max(...rows.map(r => r.value ?? 0), 1)
  return (
    <div className="space-y-2">
      {rows.map((row) => (
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
