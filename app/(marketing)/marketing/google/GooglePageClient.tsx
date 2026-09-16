'use client'

import { useState } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GscRow {
  date: string
  clicks: number | null
  impressions: number | null
  ctr: number | null
  position: number | null
}

export interface Ga4Row {
  date: string
  sessions: number | null
  total_users: number | null
  new_users: number | null
  page_views: number | null  // stored as page_views (screenPageViews metric)
}

export interface OrgRow {
  date: string
  sessions: number
}

export interface GscBreakdownRow {
  key:         string          // query text or full page URL
  clicks:      number
  impressions: number
  ctr:         number          // fraction 0–1
  position:    number | null   // impression-weighted avg, null if no position data
}

type ScMetric  = 'impressions' | 'clicks' | 'ctr' | 'position'
type Ga4Metric = 'sessions' | 'total_users' | 'new_users' | 'page_views' | 'organic_sessions'
type ChartType = 'line' | 'bar'

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000)    return Math.round(n / 1_000) + 'K'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString('en-GB')
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function pctDelta(cur: number, pri: number): number | null {
  if (pri === 0) return null
  return ((cur - pri) / pri) * 100
}

// Strip scheme + host from a page URL, show just the path (and query string if any).
// Root path shown as '/'. Trailing slash preserved when meaningful.
function shortenUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname + (u.search || '')
    return path || '/'
  } catch {
    return url
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ChartToggle({ value, onChange }: { value: ChartType; onChange: (v: ChartType) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-white/50 rounded-md p-0.5 border border-black/10">
      {(['line', 'bar'] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={[
            'px-2.5 py-1 rounded text-xs font-semibold transition-colors',
            value === t ? 'bg-kk-ink text-white' : 'text-kk-muted hover:text-kk-ink',
          ].join(' ')}
        >
          {t === 'line' ? 'Line' : 'Columns'}
        </button>
      ))}
    </div>
  )
}

function DeltaBadge({
  cur,
  pri,
  lowerBetter = false,
}: {
  cur: number
  pri: number
  lowerBetter?: boolean
}) {
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

// ── MiniChart ──────────────────────────────────────────────────────────────────
//
// SVG coordinate system: viewBox="0 0 600 110", preserveAspectRatio="none".
// Y-axis labels are HTML (avoids text distortion from preserveAspectRatio="none").
// Hover state is managed by the parent and passed as hoverIdx / onHoverChange.
// DateAxis is included inside so it stays aligned with the ml-8 chart offset.
//
// yMin: optional floor for the Y scale (used for Avg. Position to avoid zero-base).
// compact=true: renders at h-20 (~80px). Default h-28 (~112px).

function MiniChart({
  rows,
  type,
  gid,
  compact = false,
  fmtVal,
  hoverIdx,
  onHoverChange,
  yMin: yMinProp,
}: {
  rows: { date: string; value: number }[]
  type: ChartType
  gid: string
  compact?: boolean
  fmtVal: (v: number) => string
  hoverIdx: number | null
  onHoverChange: (idx: number | null) => void
  yMin?: number
}) {
  const h = compact ? 'h-20' : 'h-28'

  if (rows.length === 0) {
    return (
      <div className={`ml-8 ${h} flex items-center justify-center text-sm text-kk-muted`}>
        No data for this period.
      </div>
    )
  }

  const W     = 600
  const H     = 110
  const max   = Math.max(...rows.map((r) => r.value), 1)
  const yMin  = yMinProp ?? 0
  const range = Math.max(max - yMin, 0.001)
  const n     = rows.length

  // SVG coordinate helpers
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2)
  const py = (v: number) => H - ((v - yMin) / range) * H * 0.93 + H * 0.02

  // Y-axis CSS % positions matching py() in SVG coords
  // py(max)/H ≈ 9%   py(mid)/H ≈ 55.5%
  const Y_TOP_PCT = 9
  const Y_MID_PCT = 55.5
  const yMid = yMin + range / 2

  // Convert pointer clientX to nearest data-row index
  function idxFromClientX(clientX: number, svgEl: SVGSVGElement): number {
    const rect = svgEl.getBoundingClientRect()
    const svgX = ((clientX - rect.left) / rect.width) * W
    if (type === 'line') {
      return Math.max(0, Math.min(n - 1, Math.round((svgX / W) * (n - 1))))
    }
    return Math.max(0, Math.min(n - 1, Math.floor((svgX / W) * n)))
  }

  const mouseHandlers = {
    onMouseMove:  (e: React.MouseEvent<SVGSVGElement>) =>
      onHoverChange(idxFromClientX(e.clientX, e.currentTarget)),
    onMouseLeave: () => onHoverChange(null),
  }

  // pan-y: browser owns vertical scroll; we still receive touch events for
  // horizontal position tracking so chart inspection works on mobile.
  const touchHandlers = {
    onTouchStart: (e: React.TouchEvent<SVGSVGElement>) => {
      const t = e.touches[0]
      if (t) onHoverChange(idxFromClientX(t.clientX, e.currentTarget))
    },
    onTouchMove: (e: React.TouchEvent<SVGSVGElement>) => {
      const t = e.touches[0]
      if (t) onHoverChange(idxFromClientX(t.clientX, e.currentTarget))
    },
    onTouchEnd: () => onHoverChange(null),
  }

  // Date axis labels
  const dFirst = rows[0].date
  const dMid   = rows[Math.floor(n / 2)].date
  const dLast  = rows[n - 1].date

  // Bar chart
  if (type === 'bar') {
    const gap = Math.max(1, (W / n) * 0.18)
    const bW  = W / n - gap

    return (
      <div className="relative">
        {/* Y-axis labels */}
        <div className="absolute inset-y-0 left-0 w-8 pointer-events-none select-none" aria-hidden="true">
          <span
            className="absolute right-1.5 text-[9px] leading-none text-kk-muted tabular-nums"
            style={{ top: `${Y_TOP_PCT}%`, transform: 'translateY(-50%)' }}
          >
            {fmtVal(max)}
          </span>
          <span
            className="absolute right-1.5 text-[9px] leading-none text-kk-muted tabular-nums"
            style={{ top: `${Y_MID_PCT}%`, transform: 'translateY(-50%)' }}
          >
            {fmtVal(yMid)}
          </span>
          <span className="absolute bottom-[18px] right-1.5 text-[9px] leading-none text-kk-muted">
            {fmtVal(yMin)}
          </span>
        </div>

        {/* Chart */}
        <div className="ml-8">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className={`w-full ${h} cursor-default`}
            preserveAspectRatio="none"
            style={{ touchAction: 'pan-y' }}
            {...mouseHandlers}
            {...touchHandlers}
          >
            {rows.map((r, i) => {
              const bH = ((r.value - yMin) / range) * H
              return (
                <rect
                  key={r.date}
                  x={(i / n) * W + gap / 2}
                  y={H - bH}
                  width={Math.max(bW, 1)}
                  height={Math.max(bH, 1)}
                  fill="#171717"
                  fillOpacity={hoverIdx !== null && i !== hoverIdx ? 0.25 : 1}
                  rx={2}
                />
              )
            })}
          </svg>

          {/* Date axis */}
          {n >= 2 && (
            <div className="flex justify-between text-[10px] text-kk-muted mt-1 px-0.5 select-none">
              <span>{fmtDate(dFirst)}</span>
              <span>{fmtDate(dMid)}</span>
              <span>{fmtDate(dLast)}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Line chart
  const pts  = rows.map((r, i) => `${px(i)},${py(r.value)}`).join(' ')
  const area = [
    `M${px(0)},${H}`,
    `L${px(0)},${py(rows[0].value)}`,
    ...rows.slice(1).map((r, i) => `L${px(i + 1)},${py(r.value)}`),
    `L${px(n - 1)},${H}`,
    'Z',
  ].join(' ')

  return (
    <div className="relative">
      {/* Y-axis labels */}
      <div className="absolute inset-y-0 left-0 w-8 pointer-events-none select-none" aria-hidden="true">
        <span
          className="absolute right-1.5 text-[9px] leading-none text-kk-muted tabular-nums"
          style={{ top: `${Y_TOP_PCT}%`, transform: 'translateY(-50%)' }}
        >
          {fmtVal(max)}
        </span>
        <span
          className="absolute right-1.5 text-[9px] leading-none text-kk-muted tabular-nums"
          style={{ top: `${Y_MID_PCT}%`, transform: 'translateY(-50%)' }}
        >
          {fmtVal(yMid)}
        </span>
        <span className="absolute bottom-[18px] right-1.5 text-[9px] leading-none text-kk-muted">
          {fmtVal(yMin)}
        </span>
      </div>

      {/* Chart */}
      <div className="ml-8">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={`w-full ${h} cursor-default`}
          preserveAspectRatio="none"
          style={{ touchAction: 'pan-y' }}
          {...(n > 1 ? { ...mouseHandlers, ...touchHandlers } : {})}
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#171717" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#171717" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {n > 1 && <path d={area} fill={`url(#${gid})`} />}

          {n === 1 ? (
            <circle cx={W / 2} cy={py(rows[0].value)} r={5} fill="#171717" />
          ) : (
            <polyline
              points={pts}
              fill="none"
              stroke="#171717"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Hover indicator: vertical guide + dot */}
          {hoverIdx !== null && n > 1 && (
            <>
              <line
                x1={px(hoverIdx)} y1={H * 0.02}
                x2={px(hoverIdx)} y2={H}
                stroke="#171717" strokeWidth="0.8"
                strokeDasharray="4 3" opacity="0.3"
              />
              <circle
                cx={px(hoverIdx)} cy={py(rows[hoverIdx].value)}
                r={4} fill="white" stroke="#171717" strokeWidth="2"
              />
            </>
          )}
        </svg>

        {/* Date axis */}
        {n >= 2 && (
          <div className="flex justify-between text-[10px] text-kk-muted mt-1 px-0.5 select-none">
            <span>{fmtDate(dFirst)}</span>
            <span>{fmtDate(dMid)}</span>
            <span>{fmtDate(dLast)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── BreakdownTable ─────────────────────────────────────────────────────────────
//
// Compact GSC top-10 table. Used for both Top Queries and Top Pages.
// isPage=true: displays the path-only label, links to the full URL in a new tab.
// Empty state mirrors the SC overview sparse-data pattern.

function BreakdownTable({
  title,
  rows,
  isPage = false,
  period,
  onViewMore,
}: {
  title: string
  rows: GscBreakdownRow[]
  isPage?: boolean
  period: number
  onViewMore?: () => void
}) {
  return (
    <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
      {/* Section header — matches SC/GA4 header style */}
      <div className="bg-[#DDD9D1] px-4 py-2.5 border-b border-black/10">
        <span className="text-sm font-semibold text-kk-ink">{title}</span>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-4 flex items-center gap-3">
          <span className="text-sm text-kk-muted">
            No data in the last {period} days.
          </span>
          {onViewMore && (
            <button
              onClick={onViewMore}
              className="text-sm font-semibold text-kk-ink underline underline-offset-2 hover:text-kk-brand transition-colors shrink-0"
            >
              View 90 days →
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] text-sm table-fixed">
            <colgroup>
              <col />
              <col className="w-14" />
              <col className="w-16" />
              <col className="w-14" />
              <col className="w-14" />
            </colgroup>
            <thead>
              <tr className="border-b border-kk-line">
                <th className="text-left py-2 px-4 text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted">
                  {isPage ? 'Page' : 'Query'}
                </th>
                <th className="text-right py-2 px-2 text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted">
                  Clicks
                </th>
                <th className="text-right py-2 px-2 text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted">
                  Impr.
                </th>
                <th className="text-right py-2 px-2 text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted">
                  CTR
                </th>
                <th className="text-right py-2 px-2 pr-4 text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted">
                  Pos.
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const label = isPage ? shortenUrl(row.key) : row.key
                return (
                  <tr
                    key={row.key}
                    className={i < rows.length - 1 ? 'border-b border-kk-line' : ''}
                  >
                    <td className="py-2 px-4 text-kk-ink">
                      {isPage ? (
                        <a
                          href={row.key}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={row.key}
                          className="block truncate hover:text-kk-brand transition-colors"
                        >
                          {label}
                        </a>
                      ) : (
                        <span className="block truncate" title={row.key}>
                          {label}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-kk-ink">
                      {fmt(row.clicks)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-kk-ink">
                      {fmt(row.impressions)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-kk-muted">
                      {(row.ctr * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 px-2 pr-4 text-right tabular-nums text-kk-muted">
                      {row.position != null ? row.position.toFixed(1) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function GooglePageClient({
  gscRows,
  ga4Rows,
  orgRows,
  queries28,
  queries90,
  pages28,
  pages90,
}: {
  gscRows: GscRow[]
  ga4Rows: Ga4Row[]
  orgRows: OrgRow[]
  queries28: GscBreakdownRow[]
  queries90: GscBreakdownRow[]
  pages28:   GscBreakdownRow[]
  pages90:   GscBreakdownRow[]
}) {
  const [period,    setPeriod]    = useState<28 | 90>(28)
  const [scMetric,  setScMetric]  = useState<ScMetric>('impressions')
  const [scChart,   setScChart]   = useState<ChartType>('line')
  const [ga4Metric, setGa4Metric] = useState<Ga4Metric>('sessions')
  const [ga4Chart,  setGa4Chart]  = useState<ChartType>('line')

  // Hover indices (managed here so the label row can update in-place)
  const [scHover,  setScHover]  = useState<number | null>(null)
  const [ga4Hover, setGa4Hover] = useState<number | null>(null)

  // Period windows
  const curEnd   = daysAgoStr(1)
  const curStart = daysAgoStr(period)
  const priEnd   = daysAgoStr(period + 1)
  const priStart = daysAgoStr(period * 2)

  // Filter rows to windows
  const scCur = gscRows.filter((r) => r.date >= curStart && r.date <= curEnd)
  const scPri = gscRows.filter((r) => r.date >= priStart && r.date <= priEnd)
  const g4Cur = ga4Rows.filter((r) => r.date >= curStart && r.date <= curEnd)
  const g4Pri = ga4Rows.filter((r) => r.date >= priStart && r.date <= priEnd)
  const ogCur = orgRows.filter((r) => r.date >= curStart && r.date <= curEnd)
  const ogPri = orgRows.filter((r) => r.date >= priStart && r.date <= priEnd)

  // Does the 90-day window have any SC data? Used for the empty-state fallback offer.
  const sc90Start      = daysAgoStr(90)
  const scHas90DayData = period === 28 && gscRows.some((r) => r.date >= sc90Start && r.date <= curEnd)

  // ── SC aggregations ──────────────────────────────────────────────────────────

  const scCurClicks      = scCur.reduce((a, r) => a + (r.clicks ?? 0), 0)
  const scPriClicks      = scPri.reduce((a, r) => a + (r.clicks ?? 0), 0)
  const scCurImpressions = scCur.reduce((a, r) => a + (r.impressions ?? 0), 0)
  const scPriImpressions = scPri.reduce((a, r) => a + (r.impressions ?? 0), 0)
  const scCurCtr         = scCurImpressions > 0 ? (scCurClicks / scCurImpressions) * 100 : 0
  const scPriCtr         = scPriImpressions > 0 ? (scPriClicks / scPriImpressions) * 100 : 0

  // Impression-weighted average position (days missing position are excluded, not zeroed)
  const scCurPosRows = scCur.filter((r) => r.position != null && (r.impressions ?? 0) > 0)
  const scPriPosRows = scPri.filter((r) => r.position != null && (r.impressions ?? 0) > 0)
  const scCurPosImps = scCurPosRows.reduce((a, r) => a + r.impressions!, 0)
  const scPriPosImps = scPriPosRows.reduce((a, r) => a + r.impressions!, 0)
  const scCurPosition = scCurPosImps > 0
    ? scCurPosRows.reduce((a, r) => a + r.position! * r.impressions!, 0) / scCurPosImps : 0
  const scPriPosition = scPriPosImps > 0
    ? scPriPosRows.reduce((a, r) => a + r.position! * r.impressions!, 0) / scPriPosImps : 0

  // ── GA4 aggregations ─────────────────────────────────────────────────────────

  const g4CurSessions  = g4Cur.reduce((a, r) => a + (r.sessions ?? 0), 0)
  const g4PriSessions  = g4Pri.reduce((a, r) => a + (r.sessions ?? 0), 0)
  // Avg. Daily Users — summing daily total_users double-counts returning users,
  // so we report the average daily unique users across the period instead.
  const g4CurUsersDays = g4Cur.filter((r) => r.total_users != null).length
  const g4PriUsersDays = g4Pri.filter((r) => r.total_users != null).length
  const g4CurUsers     = g4CurUsersDays > 0
    ? g4Cur.reduce((a, r) => a + (r.total_users ?? 0), 0) / g4CurUsersDays : 0
  const g4PriUsers     = g4PriUsersDays > 0
    ? g4Pri.reduce((a, r) => a + (r.total_users ?? 0), 0) / g4PriUsersDays : 0
  const g4CurNewUsers  = g4Cur.reduce((a, r) => a + (r.new_users ?? 0), 0)
  const g4PriNewUsers  = g4Pri.reduce((a, r) => a + (r.new_users ?? 0), 0)
  const g4CurPageViews = g4Cur.reduce((a, r) => a + (r.page_views ?? 0), 0)
  const g4PriPageViews = g4Pri.reduce((a, r) => a + (r.page_views ?? 0), 0)
  const ogCurSessions  = ogCur.reduce((a, r) => a + r.sessions, 0)
  const ogPriSessions  = ogPri.reduce((a, r) => a + r.sessions, 0)

  // ── Metric configs ───────────────────────────────────────────────────────────

  // Compute a sensible floor for the position chart so the scale isn't zero-based
  const posChartRows = scCur.filter((r) => r.position != null).map((r) => ({ date: r.date, value: r.position! }))
  const posYMin = posChartRows.length > 0
    ? Math.max(0, Math.floor(Math.min(...posChartRows.map((r) => r.value))) - 1)
    : 0

  const scMetrics: Array<{
    key: ScMetric
    label: string
    cur: number
    pri: number
    lowerBetter: boolean
    fmtVal: (v: number) => string
    chartRows: { date: string; value: number }[]
    yMin?: number
  }> = [
    {
      key: 'impressions', label: 'Impressions',
      cur: scCurImpressions, pri: scPriImpressions, lowerBetter: false,
      fmtVal: fmt,
      chartRows: scCur.map((r) => ({ date: r.date, value: r.impressions ?? 0 })),
    },
    {
      key: 'clicks', label: 'Clicks',
      cur: scCurClicks, pri: scPriClicks, lowerBetter: false,
      fmtVal: fmt,
      chartRows: scCur.map((r) => ({ date: r.date, value: r.clicks ?? 0 })),
    },
    {
      key: 'ctr', label: 'CTR',
      cur: scCurCtr, pri: scPriCtr, lowerBetter: false,
      fmtVal: (v) => v.toFixed(2) + '%',
      // Only rows with actual CTR data — no fake zeros for missing days
      chartRows: scCur.filter((r) => r.ctr != null).map((r) => ({ date: r.date, value: r.ctr! * 100 })),
    },
    {
      key: 'position', label: 'Avg. Position',
      cur: scCurPosition, pri: scPriPosition, lowerBetter: true,
      fmtVal: (v) => v.toFixed(1),
      // Only rows with actual position data — no fake zeros for missing days
      chartRows: posChartRows,
      yMin: posYMin,
    },
  ]

  const ga4Metrics: Array<{
    key: Ga4Metric
    label: string
    cur: number
    pri: number
    fmtVal: (v: number) => string
    chartRows: { date: string; value: number }[]
  }> = [
    {
      key: 'sessions', label: 'Sessions',
      cur: g4CurSessions, pri: g4PriSessions,
      fmtVal: fmt,
      chartRows: g4Cur.map((r) => ({ date: r.date, value: r.sessions ?? 0 })),
    },
    {
      key: 'total_users', label: 'Avg. Daily Users',
      cur: g4CurUsers, pri: g4PriUsers,
      fmtVal: (v) => fmt(Math.round(v)),
      // Chart still shows daily users (correct — one unique count per day)
      chartRows: g4Cur.filter((r) => r.total_users != null).map((r) => ({ date: r.date, value: r.total_users! })),
    },
    {
      key: 'new_users', label: 'New Users',
      cur: g4CurNewUsers, pri: g4PriNewUsers,
      fmtVal: fmt,
      chartRows: g4Cur.map((r) => ({ date: r.date, value: r.new_users ?? 0 })),
    },
    {
      key: 'page_views', label: 'Page Views',
      cur: g4CurPageViews, pri: g4PriPageViews,
      fmtVal: fmt,
      chartRows: g4Cur.map((r) => ({ date: r.date, value: r.page_views ?? 0 })),
    },
    {
      key: 'organic_sessions', label: 'Organic Sessions',
      cur: ogCurSessions, pri: ogPriSessions,
      fmtVal: fmt,
      chartRows: ogCur.map((r) => ({ date: r.date, value: r.sessions })),
    },
  ]

  const scActive  = scMetrics.find((m) => m.key === scMetric)!
  const ga4Active = ga4Metrics.find((m) => m.key === ga4Metric)!

  // Guard hover indices against out-of-bounds (e.g. when metric changes chart row count)
  const scHoverRow  = scHover  != null && scHover  < scActive.chartRows.length  ? scActive.chartRows[scHover]   : null
  const ga4HoverRow = ga4Hover != null && ga4Hover < ga4Active.chartRows.length ? ga4Active.chartRows[ga4Hover] : null

  // Is there any SC data in the selected period at all?
  const scHasData = scCur.length > 0

  // Active breakdown lists for the selected period
  const activeQueries = period === 28 ? queries28 : queries90
  const activePages   = period === 28 ? pages28   : pages90

  // Show "View 90 days →" in breakdown empty states only when 90d has data
  const showQueriesViewMore = period === 28 && activeQueries.length === 0 && queries90.length > 0
  const showPagesViewMore   = period === 28 && activePages.length === 0   && pages90.length   > 0

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header + period selector */}
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Google</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            Marketing · Search Console &amp; Analytics
          </p>
        </div>
        <div className="flex items-center gap-1 bg-kk-panel border border-kk-line rounded-lg p-1">
          {([28, 90] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={[
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                period === p
                  ? 'bg-kk-ink text-white'
                  : 'text-kk-muted hover:text-kk-ink',
              ].join(' ')}
            >
              {p}d
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">

        {/* ── Search Console overview ───────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">

          <div className="bg-[#DDD9D1] px-5 py-3 flex items-center justify-between border-b border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kk-ink">Search Console</span>
              <span className="text-xs text-kk-muted">killerkebab.com</span>
            </div>
            {scHasData && <ChartToggle value={scChart} onChange={setScChart} />}
          </div>

          {/* Metric selector tabs — flex-1 fills full width evenly */}
          <div className="px-5 pt-4 pb-3 flex gap-2 border-b border-kk-line">
            {scMetrics.map((m) => (
              <button
                key={m.key}
                onClick={() => setScMetric(m.key)}
                className={[
                  'flex-1 px-3 py-2.5 rounded-lg border transition-colors text-left',
                  scMetric === m.key
                    ? 'bg-kk-brand text-white border-kk-brand'
                    : 'bg-kk-soft border-kk-line text-kk-ink hover:border-kk-muted',
                ].join(' ')}
              >
                <div className={[
                  'text-[10px] font-bold tracking-[0.07em] uppercase mb-1',
                  scMetric === m.key ? 'opacity-70' : 'text-kk-muted',
                ].join(' ')}>
                  {m.label}
                </div>
                <div className="text-2xl font-black leading-none tabular-nums">
                  {m.fmtVal(m.cur)}
                </div>
              </button>
            ))}
          </div>

          {/* Chart area — compact empty state when no rows in period */}
          {scHasData ? (
            <div className="px-5 py-4">
              {/* Label row — updates to hovered value when interacting */}
              <div className="flex items-center justify-between mb-2 ml-8">
                {scHoverRow ? (
                  <span className="text-[11px] font-semibold text-kk-ink tabular-nums">
                    {fmtDate(scHoverRow.date)} · {scActive.fmtVal(scHoverRow.value)}
                  </span>
                ) : (
                  <span className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
                    Daily {scActive.label} — {period} days
                  </span>
                )}
                <DeltaBadge
                  cur={scActive.cur}
                  pri={scActive.pri}
                  lowerBetter={scActive.lowerBetter}
                />
              </div>
              <MiniChart
                rows={scActive.chartRows}
                type={scChart}
                gid="sc-grad"
                fmtVal={scActive.fmtVal}
                hoverIdx={scHover}
                onHoverChange={setScHover}
                yMin={scActive.yMin}
              />
            </div>
          ) : (
            <div className="px-5 py-5 flex items-center gap-4">
              <span className="text-sm text-kk-muted">
                No Search Console data in the last {period} days.
              </span>
              {scHas90DayData && (
                <button
                  onClick={() => setPeriod(90)}
                  className="text-sm font-semibold text-kk-ink underline underline-offset-2 hover:text-kk-brand transition-colors shrink-0"
                >
                  View 90 days →
                </button>
              )}
            </div>
          )}
        </section>

        {/* ── Search Console breakdowns: Top Queries + Top Pages ────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <BreakdownTable
            title="Top Queries"
            rows={activeQueries}
            period={period}
            onViewMore={showQueriesViewMore ? () => setPeriod(90) : undefined}
          />
          <BreakdownTable
            title="Top Pages"
            rows={activePages}
            isPage
            period={period}
            onViewMore={showPagesViewMore ? () => setPeriod(90) : undefined}
          />
        </div>

        {/* ── Google Analytics ─────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">

          <div className="bg-[#DDD9D1] px-5 py-3 flex items-center justify-between border-b border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kk-ink">Analytics</span>
              <span className="text-xs text-kk-muted">GA4 · Property 333149501</span>
            </div>
            <ChartToggle value={ga4Chart} onChange={setGa4Chart} />
          </div>

          {/* Metric selector tabs — flex-1 fills full width evenly */}
          <div className="px-5 pt-4 pb-3 flex gap-2 border-b border-kk-line">
            {ga4Metrics.map((m) => (
              <button
                key={m.key}
                onClick={() => setGa4Metric(m.key)}
                className={[
                  'flex-1 px-3 py-2.5 rounded-lg border transition-colors text-left',
                  ga4Metric === m.key
                    ? 'bg-kk-brand text-white border-kk-brand'
                    : 'bg-kk-soft border-kk-line text-kk-ink hover:border-kk-muted',
                ].join(' ')}
              >
                <div className={[
                  'text-[10px] font-bold tracking-[0.07em] uppercase mb-1',
                  ga4Metric === m.key ? 'opacity-70' : 'text-kk-muted',
                ].join(' ')}>
                  {m.label}
                </div>
                <div className="text-2xl font-black leading-none tabular-nums">
                  {m.fmtVal(m.cur)}
                </div>
              </button>
            ))}
          </div>

          {/* Chart — compact height for GA4 */}
          <div className="px-5 py-4">
            {/* Label row — updates to hovered value when interacting */}
            <div className="flex items-center justify-between mb-2 ml-8">
              {ga4HoverRow ? (
                <span className="text-[11px] font-semibold text-kk-ink tabular-nums">
                  {fmtDate(ga4HoverRow.date)} · {ga4Active.fmtVal(ga4HoverRow.value)}
                </span>
              ) : (
                <span className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
                  Daily {ga4Active.label} — {period} days
                </span>
              )}
              <DeltaBadge cur={ga4Active.cur} pri={ga4Active.pri} />
            </div>
            <MiniChart
              rows={ga4Active.chartRows}
              type={ga4Chart}
              gid="ga4-grad"
              compact
              fmtVal={ga4Active.fmtVal}
              hoverIdx={ga4Hover}
              onHoverChange={setGa4Hover}
            />
          </div>
        </section>

      </div>
    </div>
  )
}
