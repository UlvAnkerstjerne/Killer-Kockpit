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
  screen_page_views: number | null
}

export interface OrgRow {
  date: string
  sessions: number
}

type ScMetric  = 'impressions' | 'clicks' | 'ctr' | 'position'
type Ga4Metric = 'sessions' | 'total_users' | 'new_users' | 'screen_page_views' | 'organic_sessions'
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

function DateAxis({ rows }: { rows: { date: string }[] }) {
  if (rows.length < 2) return null
  const first = rows[0].date
  const mid   = rows[Math.floor(rows.length / 2)].date
  const last  = rows[rows.length - 1].date
  return (
    <div className="flex justify-between text-[10px] text-kk-muted mt-1 px-0.5 select-none">
      <span>{fmtDate(first)}</span>
      <span>{fmtDate(mid)}</span>
      <span>{fmtDate(last)}</span>
    </div>
  )
}

function MiniChart({
  rows,
  type,
  gid,
}: {
  rows: { date: string; value: number }[]
  type: ChartType
  gid: string
}) {
  if (rows.length === 0) {
    return (
      <div className="h-28 flex items-center justify-center text-sm text-kk-muted">
        No data for this period.
      </div>
    )
  }

  const W   = 600
  const H   = 110
  const max = Math.max(...rows.map((r) => r.value), 1)
  const n   = rows.length

  if (type === 'bar') {
    const gap = Math.max(1, (W / n) * 0.18)
    const bW  = W / n - gap
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
        {rows.map((r, i) => {
          const bH = (r.value / max) * H
          return (
            <rect
              key={r.date}
              x={(i / n) * W + gap / 2}
              y={H - bH}
              width={Math.max(bW, 1)}
              height={Math.max(bH, 1)}
              fill="#171717"
              rx={2}
            />
          )
        })}
      </svg>
    )
  }

  // Line chart
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2)
  const py = (v: number) => H - (v / max) * H * 0.93 + H * 0.02

  if (n === 1) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28">
        <circle cx={W / 2} cy={py(rows[0].value)} r={5} fill="#171717" />
      </svg>
    )
  }

  const pts  = rows.map((r, i) => `${px(i)},${py(r.value)}`).join(' ')
  const area = [
    `M${px(0)},${H}`,
    `L${px(0)},${py(rows[0].value)}`,
    ...rows.slice(1).map((r, i) => `L${px(i + 1)},${py(r.value)}`),
    `L${px(n - 1)},${H}`,
    'Z',
  ].join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#171717" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#171717" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline
        points={pts}
        fill="none"
        stroke="#171717"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function GooglePageClient({
  gscRows,
  ga4Rows,
  orgRows,
}: {
  gscRows: GscRow[]
  ga4Rows: Ga4Row[]
  orgRows: OrgRow[]
}) {
  const [period,    setPeriod]    = useState<28 | 90>(28)
  const [scMetric,  setScMetric]  = useState<ScMetric>('impressions')
  const [scChart,   setScChart]   = useState<ChartType>('line')
  const [ga4Metric, setGa4Metric] = useState<Ga4Metric>('sessions')
  const [ga4Chart,  setGa4Chart]  = useState<ChartType>('line')

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
  const g4CurPageViews = g4Cur.reduce((a, r) => a + (r.screen_page_views ?? 0), 0)
  const g4PriPageViews = g4Pri.reduce((a, r) => a + (r.screen_page_views ?? 0), 0)
  const ogCurSessions  = ogCur.reduce((a, r) => a + r.sessions, 0)
  const ogPriSessions  = ogPri.reduce((a, r) => a + r.sessions, 0)

  // ── Metric configs ───────────────────────────────────────────────────────────

  const scMetrics: Array<{
    key: ScMetric
    label: string
    cur: number
    pri: number
    lowerBetter: boolean
    fmtVal: (v: number) => string
    chartRows: { date: string; value: number }[]
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
      chartRows: scCur.filter((r) => r.position != null).map((r) => ({ date: r.date, value: r.position! })),
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
      key: 'screen_page_views', label: 'Page Views',
      cur: g4CurPageViews, pri: g4PriPageViews,
      fmtVal: fmt,
      chartRows: g4Cur.map((r) => ({ date: r.date, value: r.screen_page_views ?? 0 })),
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

        {/* ── Search Console ───────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">

          <div className="bg-[#DDD9D1] px-5 py-3 flex items-center justify-between border-b border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kk-ink">Search Console</span>
              <span className="text-xs text-kk-muted">killerkebab.com</span>
            </div>
            <ChartToggle value={scChart} onChange={setScChart} />
          </div>

          {/* Metric selector tabs */}
          <div className="px-5 pt-4 pb-3 flex gap-2 flex-wrap border-b border-kk-line">
            {scMetrics.map((m) => (
              <button
                key={m.key}
                onClick={() => setScMetric(m.key)}
                className={[
                  'px-3 py-2 rounded-lg border transition-colors text-left min-w-[90px]',
                  scMetric === m.key
                    ? 'bg-kk-brand text-white border-kk-brand'
                    : 'bg-kk-soft border-kk-line text-kk-ink hover:border-kk-muted',
                ].join(' ')}
              >
                <div className={[
                  'text-[10px] font-bold tracking-[0.07em] uppercase mb-0.5',
                  scMetric === m.key ? 'opacity-70' : 'text-kk-muted',
                ].join(' ')}>
                  {m.label}
                </div>
                <div className="text-base font-bold leading-none tabular-nums">
                  {m.fmtVal(m.cur)}
                </div>
              </button>
            ))}
          </div>

          {/* Chart */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
                Daily {scActive.label} — {period} days
              </span>
              <DeltaBadge
                cur={scActive.cur}
                pri={scActive.pri}
                lowerBetter={scActive.lowerBetter}
              />
            </div>
            <MiniChart rows={scActive.chartRows} type={scChart} gid="sc-grad" />
            <DateAxis rows={scActive.chartRows} />
          </div>
        </section>

        {/* ── Google Analytics ─────────────────────────────────────────────── */}
        <section className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">

          <div className="bg-[#DDD9D1] px-5 py-3 flex items-center justify-between border-b border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kk-ink">Analytics</span>
              <span className="text-xs text-kk-muted">GA4 · Property 333149501</span>
            </div>
            <ChartToggle value={ga4Chart} onChange={setGa4Chart} />
          </div>

          {/* Metric selector tabs */}
          <div className="px-5 pt-4 pb-3 flex gap-2 flex-wrap border-b border-kk-line">
            {ga4Metrics.map((m) => (
              <button
                key={m.key}
                onClick={() => setGa4Metric(m.key)}
                className={[
                  'px-3 py-2 rounded-lg border transition-colors text-left min-w-[90px]',
                  ga4Metric === m.key
                    ? 'bg-kk-brand text-white border-kk-brand'
                    : 'bg-kk-soft border-kk-line text-kk-ink hover:border-kk-muted',
                ].join(' ')}
              >
                <div className={[
                  'text-[10px] font-bold tracking-[0.07em] uppercase mb-0.5',
                  ga4Metric === m.key ? 'opacity-70' : 'text-kk-muted',
                ].join(' ')}>
                  {m.label}
                </div>
                <div className="text-base font-bold leading-none tabular-nums">
                  {m.fmtVal(m.cur)}
                </div>
              </button>
            ))}
          </div>

          {/* Chart */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
                Daily {ga4Active.label} — {period} days
              </span>
              <DeltaBadge cur={ga4Active.cur} pri={ga4Active.pri} />
            </div>
            <MiniChart rows={ga4Active.chartRows} type={ga4Chart} gid="ga4-grad" />
            <DateAxis rows={ga4Active.chartRows} />
          </div>
        </section>

      </div>
    </div>
  )
}
