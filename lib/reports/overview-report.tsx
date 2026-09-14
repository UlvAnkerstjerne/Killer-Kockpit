/**
 * lib/reports/overview-report.tsx
 *
 * React-PDF executive overview document — works across Audit, Mystery Diner,
 * and SSP/CPH systems.
 *
 * Each system passes a typed OverviewRow list; a single OverviewDocument
 * renders all of them with a shared cover, summary, score trend (2+ rows),
 * and compact per-report rows.
 *
 * Server-only — do not import from client components.
 */

import React from 'react'
import { Document, Page, View, Text, StyleSheet, Svg, Polyline, Line, Circle } from '@react-pdf/renderer'

// ─── Types ────────────────────────────────────────────────────────────────────

export type OverviewSystem = 'audit' | 'diner' | 'ssp_cph'

export interface OverviewAuditRow {
  system:        'audit'
  id:            string
  date:          string    // pre-formatted
  locationName:  string
  overallPct:    number | null
  corePct:       number | null
  redFlagCount:  number
  auditStatus:   string | null
}

export interface OverviewDinerRow {
  system:           'diner'
  id:               string
  date:             string
  locationName:     string | null
  scorePct:         number | null
  finalStatus:      string | null
  criticalFailCount: number
  goldStarCount:    number
  waitingTimeBand:  string | null
}

export interface OverviewSspRow {
  system:           'ssp_cph'
  id:               string   // timestamp key
  date:             string
  overallScore:     number
  criticalScore:    number
  criticalFailures: number
}

export type OverviewRow = OverviewAuditRow | OverviewDinerRow | OverviewSspRow

export interface OverviewInput {
  system:       OverviewSystem
  locationLabel: string   // "All locations" or specific location name
  count:        number
  rows:         OverviewRow[]
  generatedAt?: string
}

// ─── Brand colours ────────────────────────────────────────────────────────────

const C = {
  red:    '#AD3919',
  yellow: '#F5DA93',
  ink:    '#171717',
  muted:  '#6b6760',
  good:   '#2f6d4c',
  goodBg: '#e7f1eb',
  bad:    '#AD3919',
  badBg:  '#f7ebe8',
  warn:   '#8a5b16',
  warnBg: '#fdf4e1',
  border: '#d9d4cc',
  soft:   '#eceae4',
  bg:     '#f5f3ee',
  white:  '#ffffff',
  sectionBg: '#DDD9D1',
  gold:   '#AD6B1D',
} as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function systemLabel(system: OverviewSystem): string {
  switch (system) {
    case 'audit':   return 'Audit'
    case 'diner':   return 'Mystery Diner'
    case 'ssp_cph': return 'KQC SSP / CPH'
  }
}

function statusColor(status: string | null): string {
  switch (status) {
    case 'GREEN':       return C.good
    case 'LIGHT_GREEN': return '#3a7d5a'
    case 'YELLOW':      return C.warn
    case 'ORANGE':      return '#8a5220'
    case 'RED':         return C.bad
    default:            return C.muted
  }
}

function scoreColor(pct: number | null): string {
  if (pct === null) return C.muted
  if (pct >= 90) return C.good
  if (pct >= 75) return C.warn
  return C.bad
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    backgroundColor: C.bg,
    fontFamily:      'Helvetica',
    fontSize:        9,
    color:           C.ink,
    paddingBottom:   40,
  },
  redBar: {
    backgroundColor: C.red,
    height:          3,
  },
  headerContent: {
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingHorizontal: 28,
    paddingTop:        12,
    paddingBottom:     11,
    flexDirection:     'row',
    alignItems:        'flex-start',
    justifyContent:    'space-between',
  },
  headerBrand: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.red,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom:  3,
  },
  headerTitle: {
    fontSize:   15,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  headerSub: {
    fontSize:  9,
    color:     C.muted,
    marginTop: 2,
  },
  headerRight: {
    alignItems: 'flex-end',
    paddingTop: 1,
  },
  headerDate: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  headerGen: {
    fontSize:  8,
    color:     C.muted,
    marginTop: 2,
  },
  body: {
    paddingHorizontal: 28,
    paddingTop:        14,
  },
  summaryCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    marginBottom:    10,
    overflow:        'hidden',
  },
  summaryHeader: {
    backgroundColor:   C.sectionBg,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingHorizontal: 10,
    paddingVertical:   5,
  },
  summaryTitle: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  summaryRow: {
    flexDirection:   'row',
    flexWrap:        'wrap',
    gap:             0,
    padding:         10,
  },
  summaryItem: {
    width:      '25%',
    paddingRight: 8,
    marginBottom: 4,
  },
  summaryLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  2,
  },
  summaryValue: {
    fontSize:   11,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  trendCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    marginBottom:    10,
    overflow:        'hidden',
  },
  trendHeader: {
    backgroundColor:   C.sectionBg,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingHorizontal: 10,
    paddingVertical:   5,
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
  },
  trendTitle: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  trendLegend: {
    flexDirection: 'row',
    gap:           10,
  },
  trendLegendItem: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  },
  trendLegendDot: {
    width:           6,
    height:          6,
    borderRadius:    3,
  },
  trendLegendText: {
    fontSize: 7,
    color:    C.muted,
  },
  trendBody: {
    paddingHorizontal: 10,
    paddingVertical:   8,
  },
  rowCard: {
    backgroundColor: C.white,
    borderRadius:    4,
    borderWidth:     1,
    borderColor:     C.border,
    marginBottom:    5,
    flexDirection:   'row',
    alignItems:      'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap:             8,
  },
  rowDate: {
    fontSize:   7.5,
    color:      C.muted,
    width:      54,
    fontFamily: 'Helvetica-Bold',
  },
  rowLocation: {
    fontSize: 8,
    color:    C.ink,
    flex:     1,
  },
  rowScore: {
    fontSize:   10,
    fontFamily: 'Helvetica-Bold',
    width:      36,
    textAlign:  'right',
  },
  rowStatus: {
    fontSize:   7.5,
    fontFamily: 'Helvetica-Bold',
    width:      52,
    textAlign:  'center',
  },
  rowMetric: {
    fontSize:  7.5,
    color:     C.muted,
    width:     30,
    textAlign: 'right',
  },
  footer: {
    position:          'absolute',
    bottom:            0,
    left:              0,
    right:             0,
    backgroundColor:   C.white,
    borderTopWidth:    1,
    borderTopColor:    C.border,
    paddingVertical:   8,
    paddingHorizontal: 28,
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
  },
  footerText: {
    fontSize: 7,
    color:    C.muted,
  },
  footerBrand: {
    fontSize:   7,
    fontFamily: 'Helvetica-Bold',
    color:      C.red,
  },
})

// ─── Score trend (react-pdf Svg) ──────────────────────────────────────────────

function ScoreTrend({
  scores,
  secondaryScores,
  primaryLabel,
  secondaryLabel,
}: {
  scores:          number[]
  secondaryScores?: number[]
  primaryLabel:    string
  secondaryLabel?: string
}) {
  if (scores.length < 2) return null

  const W = 490, H = 80, PT = 8, PB = 14, PL = 28, PR = 8
  const chartL = PL, chartR = W - PR, chartT = PT, chartB = H - PB

  const allVals = [...scores, ...(secondaryScores ?? [])]
  const rawMin  = Math.min(...allVals)
  const rawMax  = Math.max(...allVals)
  const span    = rawMax - rawMin
  const pad     = Math.max(5, Math.ceil(span * 0.2))
  const minV    = Math.max(0,   Math.floor((rawMin - pad) / 5) * 5)
  const maxV    = Math.min(100, Math.ceil ((rawMax + pad) / 5) * 5)
  const range   = Math.max(maxV - minV, 1)

  function xPos(i: number) {
    return chartL + (i / (scores.length - 1)) * (chartR - chartL)
  }
  function yPos(v: number) {
    return chartB - ((v - minV) / range) * (chartB - chartT)
  }

  const primaryPts    = scores.map((v, i) => `${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ')
  const secondaryPts  = secondaryScores?.map((v, i) => `${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ')

  // y-axis gridlines
  const gridStep = range <= 20 ? 5 : 10
  const gridVals: number[] = []
  for (let v = Math.ceil(minV / gridStep) * gridStep; v <= maxV; v += gridStep) {
    gridVals.push(v)
  }

  const last = scores.length - 1

  return (
    <View style={s.trendBody}>
      <Svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }}>
        {/* Grid lines */}
        {gridVals.map(v => (
          <g key={v}>
            <Line x1={String(chartL)} y1={String(yPos(v))} x2={String(chartR)} y2={String(yPos(v))}
              stroke="#e0dbd3" strokeWidth="0.5" />
            {/* @ts-ignore react-pdf SVGTextProps missing fontSize */}
            <Text x={String(chartL - 3)} y={String(yPos(v) + 3)} fontSize="6" fill={C.muted}
              textAnchor="end">{v}</Text>
          </g>
        ))}
        {/* Secondary line (dashed) */}
        {secondaryPts && (
          <Polyline points={secondaryPts} fill="none" stroke={C.bad}
            strokeWidth="1.2" strokeDasharray="3 2" />
        )}
        {/* Primary line */}
        <Polyline points={primaryPts} fill="none" stroke={C.ink} strokeWidth="2" />
        {/* Dots */}
        {scores.map((v, i) => (
          <Circle key={i} cx={String(xPos(i))} cy={String(yPos(v))}
            r={i === last ? '3.5' : '2.5'} fill={C.ink} />
        ))}
        {secondaryScores?.map((v, i) => (
          <Circle key={i} cx={String(xPos(i))} cy={String(yPos(v))}
            r={i === last ? '3.5' : '2.5'} fill={C.bad} />
        ))}
        {/* Date labels at start and end */}
      </Svg>
      {/* Legend */}
      <View style={s.trendLegend}>
        <View style={s.trendLegendItem}>
          <View style={[s.trendLegendDot, { backgroundColor: C.ink }]} />
          <Text style={s.trendLegendText}>{primaryLabel}</Text>
        </View>
        {secondaryLabel && (
          <View style={s.trendLegendItem}>
            <View style={[s.trendLegendDot, { backgroundColor: C.bad }]} />
            <Text style={s.trendLegendText}>{secondaryLabel} (dashed)</Text>
          </View>
        )}
      </View>
    </View>
  )
}

// ─── Summary stats ────────────────────────────────────────────────────────────

function buildSummaryItems(
  system: OverviewSystem,
  rows: OverviewRow[],
): { label: string; value: string; color?: string }[] {
  const items: { label: string; value: string; color?: string }[] = []
  items.push({ label: 'Reports', value: String(rows.length) })

  if (system === 'audit') {
    const auditRows = rows as OverviewAuditRow[]
    const scores = auditRows.map(r => r.overallPct).filter((v): v is number => v !== null)
    if (scores.length > 0) {
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      items.push({ label: 'Avg overall', value: `${avg}%`, color: scoreColor(avg) })
    }
    const coreScores = auditRows.map(r => r.corePct).filter((v): v is number => v !== null)
    if (coreScores.length > 0) {
      const avg = Math.round(coreScores.reduce((a, b) => a + b, 0) / coreScores.length)
      items.push({ label: 'Avg core', value: `${avg}%`, color: scoreColor(avg) })
    }
    const totalFlags = auditRows.reduce((sum, r) => sum + r.redFlagCount, 0)
    items.push({ label: 'Total red flags', value: String(totalFlags), color: totalFlags > 0 ? C.bad : C.good })
    const dist = { GREEN: 0, LIGHT_GREEN: 0, YELLOW: 0, ORANGE: 0, RED: 0 }
    for (const r of auditRows) {
      const k = r.auditStatus as keyof typeof dist
      if (k in dist) dist[k]++
    }
    const parts = Object.entries(dist)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k.replace('_', ' ')} ${n}`)
    if (parts.length > 0) items.push({ label: 'Status spread', value: parts.join(', ') })

  } else if (system === 'diner') {
    const dinerRows = rows as OverviewDinerRow[]
    const scores = dinerRows.map(r => r.scorePct).filter((v): v is number => v !== null)
    if (scores.length > 0) {
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      items.push({ label: 'Avg score', value: `${avg}%`, color: scoreColor(avg) })
    }
    const totalCrit = dinerRows.reduce((sum, r) => sum + r.criticalFailCount, 0)
    items.push({ label: 'Total criticals', value: String(totalCrit), color: totalCrit > 0 ? C.bad : C.good })
    const totalStars = dinerRows.reduce((sum, r) => sum + r.goldStarCount, 0)
    items.push({ label: 'Gold stars', value: String(totalStars), color: totalStars > 0 ? C.gold : C.muted })
    const dist: Record<string, number> = {}
    for (const r of dinerRows) {
      if (r.finalStatus) dist[r.finalStatus] = (dist[r.finalStatus] ?? 0) + 1
    }
    const parts = Object.entries(dist).map(([k, n]) => `${k} ${n}`)
    if (parts.length > 0) items.push({ label: 'Status spread', value: parts.join(', ') })

  } else if (system === 'ssp_cph') {
    const sspRows = rows as OverviewSspRow[]
    const overall = sspRows.map(r => r.overallScore)
    const critical = sspRows.map(r => r.criticalScore)
    if (overall.length > 0) {
      const avg = Math.round(overall.reduce((a, b) => a + b, 0) / overall.length)
      items.push({ label: 'Avg overall', value: `${avg}%`, color: scoreColor(avg) })
    }
    if (critical.length > 0) {
      const avg = Math.round(critical.reduce((a, b) => a + b, 0) / critical.length)
      items.push({ label: 'Avg critical', value: `${avg}%`, color: scoreColor(avg) })
    }
    const totalFails = sspRows.reduce((sum, r) => sum + r.criticalFailures, 0)
    items.push({ label: 'Total crit failures', value: String(totalFails), color: totalFails > 0 ? C.bad : C.good })
  }

  return items
}

// ─── Row renderers ────────────────────────────────────────────────────────────

function AuditRowCard({ row }: { row: OverviewAuditRow }) {
  return (
    <View style={s.rowCard}>
      <Text style={s.rowDate}>{row.date}</Text>
      <Text style={s.rowLocation}>{row.locationName}</Text>
      <Text style={[s.rowScore, { color: scoreColor(row.overallPct) }]}>
        {row.overallPct !== null ? `${row.overallPct}%` : '—'}
      </Text>
      <Text style={[s.rowScore, { color: scoreColor(row.corePct), fontSize: 8 }]}>
        {row.corePct !== null ? `${row.corePct}%` : '—'}
      </Text>
      <Text style={[s.rowMetric, { color: row.redFlagCount > 0 ? C.bad : C.muted }]}>
        {row.redFlagCount} RF
      </Text>
      <Text style={[s.rowStatus, { color: statusColor(row.auditStatus) }]}>
        {row.auditStatus?.replace('_', ' ') ?? '—'}
      </Text>
    </View>
  )
}

function DinerRowCard({ row }: { row: OverviewDinerRow }) {
  return (
    <View style={s.rowCard}>
      <Text style={s.rowDate}>{row.date}</Text>
      <Text style={s.rowLocation}>{row.locationName ?? '—'}</Text>
      <Text style={[s.rowScore, { color: scoreColor(row.scorePct) }]}>
        {row.scorePct !== null ? `${Math.round(row.scorePct)}%` : '—'}
      </Text>
      <Text style={[s.rowMetric, { color: row.criticalFailCount > 0 ? C.bad : C.muted }]}>
        {row.criticalFailCount} CF
      </Text>
      <Text style={[s.rowMetric, { color: row.goldStarCount > 0 ? C.gold : C.muted }]}>
        {row.goldStarCount > 0 ? `★${row.goldStarCount}` : '—'}
      </Text>
      <Text style={[s.rowStatus, { color: statusColor(row.finalStatus) }]}>
        {row.finalStatus ?? '—'}
      </Text>
    </View>
  )
}

function SspRowCard({ row }: { row: OverviewSspRow }) {
  return (
    <View style={s.rowCard}>
      <Text style={s.rowDate}>{row.date}</Text>
      <Text style={{ ...s.rowLocation, flex: 0, width: 90 }}>SSP / CPH</Text>
      <Text style={[s.rowScore, { color: scoreColor(row.overallScore) }]}>
        {row.overallScore}%
      </Text>
      <Text style={[s.rowScore, { color: scoreColor(row.criticalScore), fontSize: 8 }]}>
        {row.criticalScore}%
      </Text>
      <Text style={[s.rowMetric, { color: row.criticalFailures > 0 ? C.bad : C.muted }]}>
        {row.criticalFailures} CF
      </Text>
    </View>
  )
}

// ─── Column header ────────────────────────────────────────────────────────────

function ColumnHeader({ system }: { system: OverviewSystem }) {
  if (system === 'audit') {
    return (
      <View style={[s.rowCard, { backgroundColor: C.soft, borderColor: 'transparent', marginBottom: 2 }]}>
        <Text style={[s.rowDate, { color: C.muted, fontSize: 6.5 }]}>DATE</Text>
        <Text style={[s.rowLocation, { color: C.muted, fontSize: 6.5 }]}>LOCATION</Text>
        <Text style={[s.rowScore, { color: C.muted, fontSize: 6.5 }]}>OVERALL</Text>
        <Text style={[s.rowScore, { color: C.muted, fontSize: 6.5 }]}>CORE</Text>
        <Text style={[s.rowMetric, { color: C.muted, fontSize: 6.5 }]}>FLAGS</Text>
        <Text style={[s.rowStatus, { color: C.muted, fontSize: 6.5 }]}>STATUS</Text>
      </View>
    )
  }
  if (system === 'diner') {
    return (
      <View style={[s.rowCard, { backgroundColor: C.soft, borderColor: 'transparent', marginBottom: 2 }]}>
        <Text style={[s.rowDate, { color: C.muted, fontSize: 6.5 }]}>DATE</Text>
        <Text style={[s.rowLocation, { color: C.muted, fontSize: 6.5 }]}>LOCATION</Text>
        <Text style={[s.rowScore, { color: C.muted, fontSize: 6.5 }]}>SCORE</Text>
        <Text style={[s.rowMetric, { color: C.muted, fontSize: 6.5 }]}>CRIT</Text>
        <Text style={[s.rowMetric, { color: C.muted, fontSize: 6.5 }]}>STARS</Text>
        <Text style={[s.rowStatus, { color: C.muted, fontSize: 6.5 }]}>STATUS</Text>
      </View>
    )
  }
  return (
    <View style={[s.rowCard, { backgroundColor: C.soft, borderColor: 'transparent', marginBottom: 2 }]}>
      <Text style={[s.rowDate, { color: C.muted, fontSize: 6.5 }]}>DATE</Text>
      <Text style={{ ...s.rowLocation, flex: 0, width: 90, color: C.muted, fontSize: 6.5 }}>LOCATION</Text>
      <Text style={[s.rowScore, { color: C.muted, fontSize: 6.5 }]}>OVERALL</Text>
      <Text style={[s.rowScore, { color: C.muted, fontSize: 6.5 }]}>CRITICAL</Text>
      <Text style={[s.rowMetric, { color: C.muted, fontSize: 6.5 }]}>FAILS</Text>
    </View>
  )
}

// ─── Document ─────────────────────────────────────────────────────────────────

export function OverviewDocument({ input }: { input: OverviewInput }) {
  const { system, locationLabel, count, rows, generatedAt } = input
  const genStr = generatedAt
    ? new Date(generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  // Chronological order (oldest first for trend, most recent at top for list)
  const chronoRows = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)))

  // Date range
  const dateFrom = chronoRows.at(0)?.date ?? '—'
  const dateTo   = chronoRows.at(-1)?.date ?? '—'

  // Summary stats
  const summaryItems = buildSummaryItems(system, chronoRows)

  // Score trend data
  let primaryScores: number[] = []
  let secondaryScores: number[] | undefined
  let primaryLabel = 'Overall'
  let secondaryLabel: string | undefined

  if (system === 'audit') {
    primaryScores   = (chronoRows as OverviewAuditRow[]).map(r => r.overallPct ?? 0)
    secondaryScores = (chronoRows as OverviewAuditRow[]).map(r => r.corePct ?? 0)
    primaryLabel    = 'Overall'
    secondaryLabel  = 'Core'
  } else if (system === 'diner') {
    primaryScores   = (chronoRows as OverviewDinerRow[]).map(r => r.scorePct ?? 0)
    primaryLabel    = 'Score'
  } else if (system === 'ssp_cph') {
    primaryScores   = (chronoRows as OverviewSspRow[]).map(r => r.overallScore)
    secondaryScores = (chronoRows as OverviewSspRow[]).map(r => r.criticalScore)
    primaryLabel    = 'Overall'
    secondaryLabel  = 'Critical'
  }

  const hasTrend = chronoRows.length >= 2

  // Display rows: newest first
  const displayRows = [...chronoRows].reverse()

  return (
    <Document
      title={`${systemLabel(system)} Overview — ${locationLabel} — Last ${count}`}
      author="Killer Kockpit"
    >
      <Page size="A4" style={s.page}>

        {/* ── Header ── */}
        <View fixed>
          <View style={s.redBar} />
          <View style={s.headerContent}>
            <View>
              <Text style={s.headerBrand}>KILLER KEBAB</Text>
              <Text style={s.headerTitle}>{systemLabel(system)} Overview</Text>
              <Text style={s.headerSub}>{locationLabel} · Last {count} reports</Text>
            </View>
            <View style={s.headerRight}>
              <Text style={s.headerDate}>{dateFrom} – {dateTo}</Text>
              <Text style={s.headerGen}>Generated {genStr}</Text>
            </View>
          </View>
        </View>

        <View style={s.body}>

          {/* ── Summary ── */}
          <View style={s.summaryCard}>
            <View style={s.summaryHeader}>
              <Text style={s.summaryTitle}>Summary</Text>
            </View>
            <View style={s.summaryRow}>
              {summaryItems.map((item, i) => (
                <View key={i} style={s.summaryItem}>
                  <Text style={s.summaryLabel}>{item.label}</Text>
                  <Text style={[s.summaryValue, item.color ? { color: item.color } : {}]}>
                    {item.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* ── Score trend ── */}
          {hasTrend && (
            <View style={s.trendCard}>
              <View style={s.trendHeader}>
                <Text style={s.trendTitle}>Score Trend (chronological)</Text>
              </View>
              <ScoreTrend
                scores={primaryScores}
                secondaryScores={secondaryScores}
                primaryLabel={primaryLabel}
                secondaryLabel={secondaryLabel}
              />
            </View>
          )}

          {/* ── Report rows ── */}
          <View style={s.summaryCard}>
            <View style={s.summaryHeader}>
              <Text style={s.summaryTitle}>
                Reports ({displayRows.length}) — most recent first
              </Text>
            </View>
            <View style={{ paddingHorizontal: 6, paddingVertical: 6 }}>
              <ColumnHeader system={system} />
              {displayRows.map((row, i) => {
                if (row.system === 'audit') return <AuditRowCard key={i} row={row} />
                if (row.system === 'diner') return <DinerRowCard key={i} row={row} />
                return <SspRowCard key={i} row={row as OverviewSspRow} />
              })}
            </View>
          </View>

        </View>

        {/* ── Footer ── */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>Killer Kockpit</Text>
          <Text style={s.footerText}>
            {systemLabel(system)} Overview · {count} reports · Generated {genStr} · Internal use only
          </Text>
        </View>

      </Page>
    </Document>
  )
}
