'use client'

import { useState } from 'react'
import type { OrganicData, PostWithContext, FbPostWithContext } from '@/lib/actions/marketing/organic-performance'
import type { SortMode, FbSortMode } from '@/lib/actions/marketing/organic-utils'
import { sortPosts, sortFbPosts } from '@/lib/actions/marketing/organic-utils'
import IgThumbnail from './IgThumbnail'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-GB')
}

function fmtGrowth(n: number): string {
  const abs = fmt(Math.abs(n))
  return n >= 0 ? `+${abs}` : `−${abs}`
}

function fmtDate(iso: string): string {
  const d = iso.length <= 10
    ? new Date(iso + 'T12:00:00Z')
    : new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z')
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function pctDelta(cur: number, pri: number): number | null {
  if (pri === 0) return null
  return ((cur - pri) / pri) * 100
}

function mediaTypeLabel(t: string): string {
  return ({ IMAGE: 'Image', VIDEO: 'Reel', CAROUSEL_ALBUM: 'Carousel', REEL: 'Reel' } as Record<string, string>)[t] ?? t
}

function fbPostTypeLabel(t: string): string {
  return ({ video: 'Video', status: 'Post', photo: 'Photo', link: 'Link', offer: 'Offer' } as Record<string, string>)[t] ?? t
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

// ── Platform icons ──────────────────────────────────────────────────────────

function IgIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className={className}>
      <rect x="2.5" y="2.5" width="13" height="13" rx="4" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="13" cy="5" r="0.8" fill="currentColor"/>
    </svg>
  )
}

function FbIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className={className}>
      <path d="M10.5 9h2l.5-2.5H10.5V5c0-.7.35-1.5 1.5-1.5H13V1.5C12.2 1.5 11 1.5 11 1.5 8.8 1.5 7.5 2.8 7.5 5.2V6.5H5.5V9h2v7.5h3V9Z" fill="currentColor"/>
    </svg>
  )
}

// ── AreaChart (compact SVG, dates on x-axis, metric on y-axis) ──────────────

const CHART_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'
const CHART_LABEL_COLOR = '#6b6760'  // kk-muted

function AreaChart({ rows, fmtVal, height = 88 }: {
  rows: { date: string; value: number }[]
  fmtVal: (v: number) => string
  height?: number
}) {
  if (rows.length === 0) return <p className="text-sm text-kk-muted">No data available.</p>

  const max = Math.max(...rows.map(r => r.value), 1)
  const padL = 52   // left gutter for y-axis labels (room for full numbers like 80,000)
  const padR = 24   // right gutter — room for last date label
  const padT = 4
  const padB = 18   // bottom gutter for x-axis labels
  const w = 600     // viewBox width (scales with container)
  const plotW = w - padL - padR
  const plotH = height - padT - padB

  // y-axis: 3 ticks (top, mid, zero)
  const yTicks = [0, 0.5, 1].map(f => ({
    val: Math.round(max * f),
    y: padT + plotH * (1 - f),
  }))

  // x-axis: show ~5 evenly-spaced date labels, always include first and last.
  // Drop the penultimate interval label if it crowds the forced last label.
  const labelInterval = Math.max(1, Math.ceil(rows.length / 5))
  const lastIdx = rows.length - 1
  const xLabels = rows
    .map((r, i) => ({ ...r, i }))
    .filter((r, i) => {
      if (i === 0 || i === lastIdx) return true
      if (i % labelInterval !== 0) return false
      // suppress if within 2 indices of the last point (would crowd)
      if (lastIdx - i < labelInterval * 0.6) return false
      return true
    })

  // Build path
  const points = rows.map((r, i) => {
    const x = padL + (i / Math.max(rows.length - 1, 1)) * plotW
    const y = padT + plotH * (1 - r.value / max)
    return { x, y }
  })

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaPath = `${linePath} L${points[points.length - 1].x},${padT + plotH} L${points[0].x},${padT + plotH} Z`

  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet" aria-hidden>
      {/* Grid lines */}
      {yTicks.map(t => (
        <line key={t.val} x1={padL} x2={w - padR} y1={t.y} y2={t.y} stroke="#e5e2dc" strokeWidth={0.5} />
      ))}
      {/* Y-axis labels */}
      {yTicks.map(t => (
        <text key={t.val} x={padL - 4} y={t.y + 3} textAnchor="end" fontFamily={CHART_FONT} fontSize={9} fontWeight={500} fill={CHART_LABEL_COLOR}>
          {fmtVal(t.val)}
        </text>
      ))}
      {/* Area fill */}
      <path d={areaPath} fill="#171717" fillOpacity={0.06} />
      {/* Line */}
      <path d={linePath} fill="none" stroke="#171717" strokeWidth={1.5} strokeLinejoin="round" />
      {/* X-axis labels */}
      {xLabels.map((r, idx) => {
        const x = padL + (r.i / Math.max(rows.length - 1, 1)) * plotW
        const isFirst = idx === 0
        const isLast = idx === xLabels.length - 1
        const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle'
        return (
          <text key={r.date} x={x} y={height - 3} textAnchor={anchor} fontFamily={CHART_FONT} fontSize={9} fontWeight={500} fill={CHART_LABEL_COLOR}>
            {fmtDateShort(r.date)}
          </text>
        )
      })}
    </svg>
  )
}

// ── Post row (Instagram) ────────────────────────────────────────────────────

function PostRow({ post }: { post: PostWithContext }) {
  const thumbSrc = post.thumbnail_url ?? post.media_url ?? null
  const contextText = post.medianRatio !== null
    ? `${post.medianRatio.toFixed(1)}× median`
    : null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden">
      <div className="flex">
        <div className="w-[72px] h-[72px] shrink-0 bg-kk-soft overflow-hidden">
          <IgThumbnail src={thumbSrc} />
        </div>
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

// ── Post row (Facebook) ─────────────────────────────────────────────────────

function FbPostRow({ post }: { post: FbPostWithContext }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden">
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-semibold text-kk-ink">{fbPostTypeLabel(post.post_type)}</span>
          {post.published_at && (
            <span className="text-[10px] text-kk-muted">{fmtDate(post.published_at)}</span>
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
        {post.message && (
          <p className="text-[11px] text-kk-muted line-clamp-2 mb-1">{post.message}</p>
        )}
        <div className="flex items-center gap-3 text-[10px] tabular-nums">
          {post.reactions_total != null && (
            <span className="font-semibold text-kk-ink">{fmt(post.reactions_total)} <span className="font-normal text-kk-muted">Reactions</span></span>
          )}
          {post.clicks != null && (
            <span className="text-kk-muted">🖱 {fmt(post.clicks)} Clicks</span>
          )}
          {post.comments != null && post.comments > 0 && (
            <span className="text-kk-muted">💬 {fmt(post.comments)}</span>
          )}
          {post.shares != null && post.shares > 0 && (
            <span className="text-kk-muted">↗ {fmt(post.shares)}</span>
          )}
          {post.reactions_total == null && post.clicks == null && (
            <span className="text-kk-muted">No metrics available</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function OrganicClient({ data }: { data: OrganicData }) {
  const [period, setPeriod] = useState<7 | 28>(7)
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [fbSortMode, setFbSortMode] = useState<FbSortMode>('recent')

  type FbMetric = 'reach' | 'engaged_users'
  const fbHasReach = data.fbDaily.some(r => r.reach != null)
  const [fbMetric, setFbMetric] = useState<FbMetric>(fbHasReach ? 'reach' : 'engaged_users')

  const igOverview = period === 7 ? data.igOverview7 : data.igOverview28
  const fbOverview = period === 7 ? data.fbOverview7 : data.fbOverview28
  const rawPosts   = period === 7 ? data.posts7 : data.posts28
  const insights   = period === 7 ? data.insights7 : data.insights28
  const rawFbPosts = period === 7 ? data.fbPosts7 : data.fbPosts28

  const posts   = sortPosts(rawPosts, sortMode)
  const fbPosts = sortFbPosts(rawFbPosts, fbSortMode)

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
        <section
          className="bg-white border border-kk-line rounded-2xl overflow-hidden"
          style={{ boxShadow: '0 2px 8px rgba(23,23,23,0.05)' }}
        >
          <div className="px-5 py-4 flex items-center gap-2.5 border-b border-kk-line">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#FDF0F7', color: '#C13584' }}>
              <IgIcon />
            </div>
            <span className="text-[13px] font-bold tracking-[0.06em] uppercase text-kk-muted">Instagram</span>
            <span className="text-xs text-kk-muted">killerkebab</span>
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
            <AreaChart rows={trendRows} fmtVal={fmt} />
          </div>
        </section>

        {/* ── Instagram Content ──────────────────────────────────────────── */}
        <section
          className="bg-white border border-kk-line rounded-2xl overflow-hidden"
          style={{ boxShadow: '0 2px 8px rgba(23,23,23,0.05)' }}
        >
          <div className="px-5 py-4 flex items-center justify-between border-b border-kk-line">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#FDF0F7', color: '#C13584' }}>
                <IgIcon />
              </div>
              <span className="text-[13px] font-bold tracking-[0.06em] uppercase text-kk-muted">Content</span>
            </div>
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

          {/* Post list — scrollable */}
          <div className="p-3 space-y-2 max-h-[480px] overflow-y-auto">
            {posts.length > 0 ? (
              posts.map(post => <PostRow key={post.id} post={post} />)
            ) : (
              <p className="text-sm text-kk-muted px-2 py-4">No posts in the last {period} days.</p>
            )}
          </div>
        </section>

        {/* ── What's Working ────────────────────────────────────────────── */}
        {insights.length > 0 && (
          <section
            className="bg-white border border-kk-line rounded-2xl overflow-hidden"
            style={{ boxShadow: '0 2px 8px rgba(23,23,23,0.05)' }}
          >
            <div className="px-5 py-4 flex items-center gap-2.5 border-b border-kk-line">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-kk-good-bg text-kk-good">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M6 9l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <span className="text-[13px] font-bold tracking-[0.06em] uppercase text-kk-muted">What&apos;s working</span>
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
        <section
          className="bg-white border border-kk-line rounded-2xl overflow-hidden"
          style={{ boxShadow: '0 2px 8px rgba(23,23,23,0.05)' }}
        >
          <div className="px-5 py-4 flex items-center gap-2.5 border-b border-kk-line">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#EBF3FF', color: '#1877F2' }}>
              <FbIcon />
            </div>
            <span className="text-[13px] font-bold tracking-[0.06em] uppercase text-kk-muted">Facebook</span>
            <span className="text-xs text-kk-muted">Page metrics</span>
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
            <AreaChart rows={fbTrendRows} fmtVal={fmt} />
          </div>
        </section>

        {/* ── Facebook Content ───────────────────────────────────────────── */}
        <section
          className="bg-white border border-kk-line rounded-2xl overflow-hidden"
          style={{ boxShadow: '0 2px 8px rgba(23,23,23,0.05)' }}
        >
          <div className="px-5 py-4 flex items-center justify-between border-b border-kk-line">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#EBF3FF', color: '#1877F2' }}>
                <FbIcon />
              </div>
              <span className="text-[13px] font-bold tracking-[0.06em] uppercase text-kk-muted">Content</span>
            </div>
            <span className="text-xs text-kk-muted">{rawFbPosts.length} posts in {period}d</span>
          </div>

          {/* Sort tabs */}
          <div className="px-5 pt-3 pb-2 flex gap-1 border-b border-kk-line">
            {([
              { key: 'recent' as FbSortMode, label: 'Recent' },
              { key: 'reactions' as FbSortMode, label: 'Reactions' },
              { key: 'clicks' as FbSortMode, label: 'Clicks' },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setFbSortMode(tab.key)}
                className={[
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                  fbSortMode === tab.key ? 'bg-kk-ink text-white' : 'text-kk-muted hover:text-kk-ink',
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Post list — scrollable */}
          <div className="p-3 space-y-2 max-h-[480px] overflow-y-auto">
            {fbPosts.length > 0 ? (
              fbPosts.map(post => <FbPostRow key={post.id} post={post} />)
            ) : (
              <p className="text-sm text-kk-muted px-2 py-4">No Facebook posts in the last {period} days.</p>
            )}
          </div>
        </section>

      </div>
    </div>
  )
}
