'use client'

import { useState } from 'react'
import type { OrganicData, PostWithContext, IgOverview, FbOverview, Insight, IgDailyRow } from '@/lib/actions/marketing/organic-performance'
import type { SortMode } from '@/lib/actions/marketing/organic-utils'
import { sortPosts } from '@/lib/actions/marketing/organic-utils'
import IgThumbnail from './IgThumbnail'

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  // Handle both date-only ("2026-09-17") and timestamp ("2026-09-17 14:30:04+00")
  const d = iso.length <= 10
    ? new Date(iso + 'T12:00:00Z')
    : new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function pctDelta(cur: number, pri: number): number | null {
  if (pri === 0) return null
  return ((cur - pri) / pri) * 100
}

function mediaTypeLabel(t: string): string {
  return ({ IMAGE: 'Image', VIDEO: 'Reel', CAROUSEL_ALBUM: 'Carousel', REEL: 'Reel' } as Record<string, string>)[t] ?? t
}

function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function DeltaBadge({ cur, pri, lowerBetter = false }: { cur: number; pri: number; lowerBetter?: boolean }) {
  const d = pctDelta(cur, pri)
  if (d === null) return <span className="text-xs text-kk-muted">vs prior: —</span>
  const improved = lowerBetter ? d < 0 : d >= 0
  const sign = d >= 0 ? '+' : ''
  return (
    <span className={['text-xs font-semibold', improved ? 'text-kk-good' : 'text-kk-bad'].join(' ')}>
      {sign}{d.toFixed(1)}% vs prior
    </span>
  )
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="bg-kk-soft border border-kk-line rounded-lg px-3 py-2.5">
      <div className="text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted mb-1">{label}</div>
      <div className="text-xl font-black text-kk-ink leading-none tabular-nums">{value}</div>
      {sub && <div className="mt-1">{sub}</div>}
    </div>
  )
}

type IgMetric = 'reach'

// ── MiniBarChart (simple, reusable) ──────────────────────────────────────────

function MiniBarChart({ rows, fmtVal }: {
  rows: { date: string; value: number }[]
  fmtVal: (v: number) => string
}) {
  if (rows.length === 0) return <p className="text-sm text-kk-muted">No data available.</p>
  const max = Math.max(...rows.map(r => r.value), 1)
  return (
    <div className="space-y-1.5">
      {rows.map(row => (
        <div key={row.date} className="flex items-center gap-3">
          <span className="text-[10px] text-kk-muted w-12 shrink-0">{fmtDate(row.date)}</span>
          <div className="flex-1 h-2 bg-kk-soft rounded-full overflow-hidden">
            <div
              className="h-full bg-kk-ink rounded-full"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </div>
          <span className="text-[10px] font-semibold text-kk-ink w-12 text-right shrink-0 tabular-nums">
            {fmtVal(row.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Post row ──────────────────────────────────────────────────────────────────

function PostRow({ post }: { post: PostWithContext }) {
  const thumbSrc = post.thumbnail_url ?? post.media_url ?? null
  const contextText = post.medianRatio !== null
    ? `${post.medianRatio.toFixed(1)}× median`
    : null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden">
      <div className="flex">
        {/* Thumbnail */}
        <div className="w-[72px] h-[72px] shrink-0 bg-kk-soft overflow-hidden">
          <IgThumbnail src={thumbSrc} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 px-3 py-2">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] font-semibold text-kk-ink">{mediaTypeLabel(post.media_type)}</span>
            {post.published_at && (
              <span className="text-[10px] text-kk-muted">{fmtDate(post.published_at)}</span>
            )}
            {contextText && (
              <span className={[
                'text-[10px] font-semibold px-1.5 py-0.5 rounded',
                post.medianRatio! >= 2 ? 'bg-kk-good-bg text-kk-good'
                  : post.medianRatio! >= 1 ? 'bg-kk-soft text-kk-ink'
                  : 'bg-kk-bad-bg text-kk-bad',
              ].join(' ')}>
                {contextText}
              </span>
            )}
            {post.permalink && (
              <a
                href={post.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-medium text-kk-muted hover:text-kk-ink ml-auto shrink-0"
              >
                View ↗
              </a>
            )}
          </div>
          {post.caption && (
            <p className="text-[11px] text-kk-muted line-clamp-1 mb-1">{post.caption}</p>
          )}
          <div className="flex items-center gap-3 text-[10px] tabular-nums">
            <span className="font-semibold text-kk-ink">{fmt(post.exposure)} <span className="font-normal text-kk-muted">{post.exposureLabel}</span></span>
            <span className="text-kk-muted">♥ {fmt(post.likes ?? 0)}</span>
            <span className="text-kk-muted">💬 {fmt(post.comments_count ?? 0)}</span>
            <span className="text-kk-muted">↗ {fmt(post.shares ?? 0)}</span>
            <span className="text-kk-muted">🔖 {fmt(post.saved ?? 0)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function OrganicClient({ data }: { data: OrganicData }) {
  const [period, setPeriod] = useState<7 | 28>(7)
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  type FbMetric = 'reach' | 'engaged_users'
  // Default to reach if any FB row has reach data, otherwise engaged_users
  const fbHasReach = data.fbDaily.some(r => r.reach != null)
  const [fbMetric, setFbMetric] = useState<FbMetric>(fbHasReach ? 'reach' : 'engaged_users')

  const igOverview = period === 7 ? data.igOverview7 : data.igOverview28
  const fbOverview = period === 7 ? data.fbOverview7 : data.fbOverview28
  const rawPosts   = period === 7 ? data.posts7 : data.posts28
  const insights   = period === 7 ? data.insights7 : data.insights28

  const posts = sortPosts(rawPosts, sortMode)

  // IG trend chart data
  const curEnd   = daysAgoStr(1)
  const curStart = daysAgoStr(period)
  const trendRows = data.igDaily
    .filter(r => r.date >= curStart && r.date <= curEnd)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({ date: r.date, value: r.reach ?? 0 }))

  // FB trend chart data
  const fbTrendRows = data.fbDaily
    .filter(r => r.date >= curStart && r.date <= curEnd)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({
      date: r.date,
      value: fbMetric === 'reach' ? (r.reach ?? 0) : (r.engaged_users ?? 0),
    }))
  const fbMetricLabel = fbMetric === 'reach' ? 'Reach' : 'Engaged Users'

  return (
    <div>
      {/* Header + period toggle */}
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Organic Performance</h1>
          <p className="text-sm text-kk-muted mt-0.5">Instagram &amp; Facebook</p>
        </div>
        <div className="flex items-center gap-1 bg-kk-panel border border-kk-line rounded-lg p-1">
          {([7, 28] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={[
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                period === p ? 'bg-kk-ink text-white' : 'text-kk-muted hover:text-kk-ink',
              ].join(' ')}
            >
              {p}d
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">

        {/* ── Instagram Overview ─────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="bg-[#DDD9D1] px-5 py-3 border-b border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kk-ink">Instagram</span>
              <span className="text-xs text-kk-muted">killerkebab</span>
            </div>
          </div>

          <div className="px-5 pt-4 pb-3 grid grid-cols-2 sm:grid-cols-4 gap-2 border-b border-kk-line">
            <KpiCard
              label="Followers"
              value={igOverview.followers !== null ? fmt(igOverview.followers) : '—'}
            />
            <KpiCard
              label="Reach"
              value={fmt(igOverview.reach)}
              sub={<DeltaBadge cur={igOverview.reach} pri={igOverview.reachPrior} />}
            />
            <KpiCard
              label="Engaged Users"
              value={igOverview.engagedUsers !== null ? fmt(igOverview.engagedUsers) : '—'}
              sub={igOverview.engagedUsers !== null && igOverview.engagedPrior !== null ? (
                <DeltaBadge cur={igOverview.engagedUsers} pri={igOverview.engagedPrior} />
              ) : undefined}
            />
            <KpiCard
              label="Follower Growth"
              value={igOverview.followerGrowth !== null ? fmtGrowth(igOverview.followerGrowth) : '—'}
              sub={igOverview.followerGrowthPrior !== null && igOverview.followerGrowth !== null ? (
                <span className="text-xs text-kk-muted">
                  Prior: {fmtGrowth(igOverview.followerGrowthPrior)}
                </span>
              ) : undefined}
            />
          </div>

          {/* Trend */}
          <div className="px-5 py-4">
            <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted mb-3">
              Daily Reach — {period} days
            </div>
            <MiniBarChart rows={trendRows} fmtVal={fmt} />
          </div>
        </section>

        {/* ── Top Content ───────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="bg-[#DDD9D1] px-5 py-3 border-b border-black/10 flex items-center justify-between">
            <span className="text-sm font-semibold text-kk-ink">Content</span>
            <span className="text-xs text-kk-muted">{rawPosts.length} posts in {period}d</span>
          </div>

          {/* Sort tabs */}
          <div className="px-5 pt-3 pb-2 flex gap-1 border-b border-kk-line">
            {([
              { key: 'recent' as SortMode, label: 'Recent' },
              { key: 'exposure' as SortMode, label: 'Reach / Views' },
              { key: 'shares' as SortMode, label: 'Shares' },
              { key: 'saves' as SortMode, label: 'Saves' },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setSortMode(tab.key)}
                className={[
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                  sortMode === tab.key ? 'bg-kk-ink text-white' : 'text-kk-muted hover:text-kk-ink',
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Post list */}
          <div className="p-3 space-y-2">
            {posts.length > 0 ? (
              posts.map(post => <PostRow key={post.id} post={post} />)
            ) : (
              <p className="text-sm text-kk-muted px-2 py-4">No posts in the last {period} days.</p>
            )}
          </div>
        </section>

        {/* ── What's Working ────────────────────────────────────────────── */}
        {insights.length > 0 && (
          <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
            <div className="bg-[#DDD9D1] px-5 py-3 border-b border-black/10">
              <span className="text-sm font-semibold text-kk-ink">What&apos;s working</span>
            </div>
            <div className="px-5 py-4 space-y-3">
              {insights.map((ins, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-kk-good text-sm mt-0.5 shrink-0">●</span>
                  <p className="text-sm text-kk-ink">{ins.text}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Facebook Overview ──────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
          <div className="bg-[#DDD9D1] px-5 py-3 border-b border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kk-ink">Facebook</span>
              <span className="text-xs text-kk-muted">Page metrics</span>
            </div>
          </div>

          <div className="px-5 pt-4 pb-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <KpiCard
              label="Page Fans"
              value={fbOverview.fans !== null ? fmt(fbOverview.fans) : '—'}
            />
            <KpiCard
              label="Reach"
              value={fbOverview.reach !== null ? fmt(fbOverview.reach) : '—'}
              sub={fbOverview.reach !== null && fbOverview.reachPrior !== null ? (
                <DeltaBadge cur={fbOverview.reach} pri={fbOverview.reachPrior} />
              ) : undefined}
            />
            <KpiCard
              label="Engaged Users"
              value={fmt(fbOverview.engagedUsers)}
              sub={<DeltaBadge cur={fbOverview.engagedUsers} pri={fbOverview.engagedPrior} />}
            />
            <KpiCard
              label="Fan Growth"
              value={fbOverview.fanGrowth !== null ? fmtGrowth(fbOverview.fanGrowth) : '—'}
              sub={fbOverview.fanGrowthPrior !== null ? (
                <span className="text-xs text-kk-muted">
                  Prior: {fmtGrowth(fbOverview.fanGrowthPrior!)}
                </span>
              ) : undefined}
            />
          </div>

          {/* FB Trend */}
          <div className="px-5 py-4 border-t border-kk-line">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
                Daily {fbMetricLabel} — {period} days
              </div>
              <div className="flex items-center gap-1">
                {([
                  { key: 'reach' as FbMetric, label: 'Reach' },
                  { key: 'engaged_users' as FbMetric, label: 'Engaged' },
                ] as const).map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setFbMetric(tab.key)}
                    className={[
                      'px-2 py-0.5 rounded text-[10px] font-semibold transition-colors',
                      fbMetric === tab.key ? 'bg-kk-ink text-white' : 'text-kk-muted hover:text-kk-ink',
                    ].join(' ')}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
            <MiniBarChart rows={fbTrendRows} fmtVal={fmt} />
          </div>
        </section>

      </div>
    </div>
  )
}
