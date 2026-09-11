/**
 * lib/reports/diner-report.tsx
 *
 * React-PDF document for Mystery Diner result reports.
 *
 * Reuses the same brand colours and structural design language as kkc-report.tsx.
 * Data flows in as pre-loaded DinerPdfInput — no DB calls here.
 *
 * Checkpoint rendering rules:
 *   scored       — Pass / Fail / N/A badge; Critical badge where applicable
 *   gold_star    — ★ Gold Star / Not achieved / N/A
 *   waiting_time — time band value (e.g. "16-20 min"); critical if 20+
 *   informational — label shown in muted italic; notes value shown right-side
 *   conditional  — omitted from PDF when waiting band is ≤15 min
 *
 * Server-only — never import from client components.
 */

import React from 'react'
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from '@react-pdf/renderer'
import { shouldShowConditional } from '@/lib/diner/form-utils'
import type { DinerPdfInput, DinerPdfCheckpoint, DinerPdfResponse } from './generate-diner-pdf'

// ─── Brand colours (shared vocabulary with kkc-report.tsx) ────────────────────

const C = {
  red:        '#AD3919',
  yellow:     '#F5DA93',
  ink:        '#171717',
  muted:      '#6b6760',
  sectionBg:  '#DDD9D1',
  good:       '#2f6d4c',
  goodBg:     '#e7f1eb',
  goodBorder: '#a8cfba',
  bad:        '#8d3737',
  badBg:      '#f5e7e7',
  badBorder:  '#d98080',
  warn:       '#8a5b16',
  warnBg:     '#fdf5e0',
  warnBorder: '#e0bf80',
  gold:       '#AD6B1D',
  goldBg:     '#fdf5e0',
  goldBorder: '#e0c070',
  border:     '#d9d4cc',
  soft:       '#eceae4',
  bg:         '#f5f3ee',
  white:      '#ffffff',
} as const

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function scoreColor(pct: number | null): string {
  if (pct === null) return C.muted
  if (pct >= 86) return C.good
  if (pct >= 67) return C.warn
  return C.bad
}

function statusFg(status: string | null): string {
  switch (status) {
    case 'GREEN':  return C.good
    case 'YELLOW': return C.warn
    case 'RED':    return C.bad
    default:       return C.muted
  }
}

function statusBg(status: string | null): string {
  switch (status) {
    case 'GREEN':  return C.goodBg
    case 'YELLOW': return C.warnBg
    case 'RED':    return C.badBg
    default:       return C.soft
  }
}

function statusBorder(status: string | null): string {
  switch (status) {
    case 'GREEN':  return C.goodBorder
    case 'YELLOW': return C.warnBorder
    case 'RED':    return C.badBorder
    default:       return C.border
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
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

  // ── Fixed page header ─────────────────────────────────────────────────────
  header: {
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerRedBar: {
    backgroundColor: C.red,
    height:          3,
  },
  headerContent: {
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
  headerLocation: {
    fontSize:  9,
    color:     C.muted,
    marginTop: 2,
  },
  headerMeta: {
    alignItems: 'flex-end',
    paddingTop: 1,
  },
  headerDate: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  headerDiner: {
    fontSize:  8,
    color:     C.muted,
    marginTop: 2,
  },

  // ── Body ──────────────────────────────────────────────────────────────────
  body: {
    paddingHorizontal: 28,
    paddingTop:        14,
  },

  // ── Result summary card ────────────────────────────────────────────────────
  resultCard: {
    borderRadius:  5,
    borderWidth:   1,
    overflow:      'hidden',
    marginBottom:  10,
  },
  resultTop: {
    paddingHorizontal: 14,
    paddingTop:        10,
    paddingBottom:     8,
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'flex-start',
  },
  resultStatusLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  3,
    opacity:       0.7,
  },
  resultStatus: {
    fontSize:   18,
    fontFamily: 'Helvetica-Bold',
  },
  resultMetrics: {
    flexDirection:  'row',
    borderTopWidth: 1,
  },
  resultMetric: {
    flex:              1,
    alignItems:        'center',
    paddingVertical:   9,
    paddingHorizontal: 8,
    borderRightWidth:  1,
  },
  resultMetricLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  4,
  },
  resultMetricValue: {
    fontSize:   16,
    fontFamily: 'Helvetica-Bold',
  },

  // ── Critical failures banner ───────────────────────────────────────────────
  critBanner: {
    backgroundColor: C.badBg,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.badBorder,
    padding:         10,
    marginBottom:    10,
  },
  critBannerTitle: {
    fontSize:      8,
    fontFamily:    'Helvetica-Bold',
    color:         C.bad,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  6,
  },
  critBannerItem: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    marginBottom:  3,
  },
  critBannerDot: {
    fontSize:    9,
    color:       C.bad,
    marginRight: 5,
    lineHeight:  1.3,
  },
  critBannerText: {
    fontSize:   8,
    color:      C.bad,
    flex:       1,
    lineHeight: 1.4,
  },

  // ── Section card ──────────────────────────────────────────────────────────
  sectionCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    marginBottom:    7,
    overflow:        'hidden',
  },
  sectionHeader: {
    backgroundColor:   C.sectionBg,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingHorizontal: 10,
    paddingVertical:   5,
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
  },
  sectionTitle: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  sectionCount: {
    fontSize: 7,
    color:    C.muted,
  },

  // ── Checkpoint rows ───────────────────────────────────────────────────────
  cpRow: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderBottomWidth: 1,
    borderBottomColor: C.soft,
  },
  cpIdx: {
    fontSize:    7,
    color:       C.muted,
    marginRight: 6,
    minWidth:    14,
    textAlign:   'right',
  },
  cpCritBadge: {
    fontSize:          6,
    fontFamily:        'Helvetica-Bold',
    color:             C.red,
    backgroundColor:   C.yellow,
    borderRadius:      2,
    paddingHorizontal: 3,
    paddingVertical:   1,
    marginRight:       5,
    lineHeight:        1,
  },
  cpCondBadge: {
    fontSize:          6,
    fontFamily:        'Helvetica-Bold',
    color:             C.muted,
    backgroundColor:   C.soft,
    borderRadius:      2,
    paddingHorizontal: 3,
    paddingVertical:   1,
    marginRight:       5,
    lineHeight:        1,
    borderWidth:       1,
    borderColor:       C.border,
  },
  cpName: {
    flex:       1,
    fontSize:   8,
    color:      C.ink,
    lineHeight: 1.4,
  },
  cpNameCritFail: {
    flex:       1,
    fontSize:   8,
    fontFamily: 'Helvetica-Bold',
    color:      C.bad,
    lineHeight: 1.4,
  },
  cpNameGold: {
    flex:       1,
    fontSize:   8,
    color:      C.gold,
    lineHeight: 1.4,
  },
  cpNameInfo: {
    flex:       1,
    fontSize:   8,
    color:      C.muted,
    fontFamily: 'Helvetica-Oblique',
    lineHeight: 1.4,
  },

  // ── Result badges ─────────────────────────────────────────────────────────
  badge: {
    fontSize:          7,
    fontFamily:        'Helvetica-Bold',
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      3,
    borderWidth:       1,
    marginLeft:        8,
    textAlign:         'center',
    minWidth:          52,
  },
  badgePass: {
    color:           C.good,
    backgroundColor: C.goodBg,
    borderColor:     C.goodBorder,
  },
  badgeFail: {
    color:           C.bad,
    backgroundColor: C.badBg,
    borderColor:     C.badBorder,
  },
  badgeNa: {
    color:           C.muted,
    backgroundColor: C.soft,
    borderColor:     C.border,
  },
  badgeGold: {
    color:           C.gold,
    backgroundColor: C.goldBg,
    borderColor:     C.goldBorder,
  },
  badgeWait: {
    color:           C.ink,
    backgroundColor: C.soft,
    borderColor:     C.border,
  },
  badgeWaitCrit: {
    color:           C.bad,
    backgroundColor: C.badBg,
    borderColor:     C.badBorder,
  },

  // Informational notes text (no badge box)
  cpInfoNotes: {
    fontSize:   7,
    color:      C.muted,
    fontFamily: 'Helvetica-Oblique',
    marginLeft: 8,
    maxWidth:   150,
    textAlign:  'right',
  },

  // ── Not-assessed summary ──────────────────────────────────────────────────
  notAssessedCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         10,
    marginBottom:    7,
  },
  notAssessedLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  5,
  },
  notAssessedList: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           5,
  },
  notAssessedChip: {
    fontSize:          7,
    color:             C.muted,
    backgroundColor:   C.soft,
    borderRadius:      3,
    borderWidth:       1,
    borderColor:       C.border,
    paddingHorizontal: 6,
    paddingVertical:   3,
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    position:          'absolute',
    bottom:            14,
    left:              28,
    right:             28,
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
    borderTopWidth:    1,
    borderTopColor:    C.border,
    paddingTop:        5,
  },
  footerBrand: {
    fontSize:   7,
    fontFamily: 'Helvetica-Bold',
    color:      C.red,
  },
  footerText: {
    fontSize: 7,
    color:    C.muted,
  },
})

// ─── Sub-components ───────────────────────────────────────────────────────────

function ResultSummaryCard({ input }: { input: DinerPdfInput }) {
  const { finalStatus, scorePct, criticalFailCount, goldStarCount, waitingTimeBand } = input
  const fg    = statusFg(finalStatus)
  const bg    = statusBg(finalStatus)
  const brd   = statusBorder(finalStatus)
  const label = finalStatus ?? '—'

  return (
    <View style={[s.resultCard, { backgroundColor: bg, borderColor: brd }]} wrap={false}>
      <View style={s.resultTop}>
        <View>
          <Text style={[s.resultStatusLabel, { color: fg }]}>Mystery Diner result</Text>
          <Text style={[s.resultStatus,      { color: fg }]}>{label}</Text>
        </View>
      </View>
      <View style={[s.resultMetrics, { borderTopColor: brd }]}>
        <View style={[s.resultMetric, { borderRightColor: brd }]}>
          <Text style={s.resultMetricLabel}>Score</Text>
          <Text style={[s.resultMetricValue, { color: scoreColor(scorePct) }]}>
            {scorePct !== null ? `${Math.round(scorePct)}%` : '—'}
          </Text>
        </View>
        <View style={[s.resultMetric, { borderRightColor: brd }]}>
          <Text style={s.resultMetricLabel}>Criticals</Text>
          <Text style={[s.resultMetricValue, { color: criticalFailCount > 0 ? C.bad : C.good }]}>
            {String(criticalFailCount)}
          </Text>
        </View>
        <View style={[s.resultMetric, { borderRightColor: brd }]}>
          <Text style={s.resultMetricLabel}>Gold Stars</Text>
          <Text style={[s.resultMetricValue, { color: goldStarCount > 0 ? C.gold : C.muted }]}>
            {goldStarCount > 0 ? `★ ${goldStarCount}` : '0'}
          </Text>
        </View>
        <View style={[s.resultMetric, { borderRightWidth: 0 }]}>
          <Text style={s.resultMetricLabel}>Wait</Text>
          <Text style={[s.resultMetricValue, { fontSize: 12, color: C.ink }]}>
            {waitingTimeBand ? `${waitingTimeBand} min` : '—'}
          </Text>
        </View>
      </View>
    </View>
  )
}

function CriticalFailuresBanner({
  checkpoints,
  responseMap,
}: {
  checkpoints: DinerPdfCheckpoint[]
  responseMap: Map<string, DinerPdfResponse>
}) {
  const critFails = checkpoints.filter(
    cp => cp.isCritical && cp.type === 'scored' && responseMap.get(cp.id)?.result === 'fail',
  )
  if (!critFails.length) return null

  return (
    <View style={s.critBanner} wrap={false}>
      <Text style={s.critBannerTitle}>
        Critical failures ({critFails.length})
      </Text>
      {critFails.map((cp, i) => (
        <View key={i} style={s.critBannerItem}>
          <Text style={s.critBannerDot}>•</Text>
          <Text style={s.critBannerText}>#{cp.orderIndex} {cp.label}</Text>
        </View>
      ))}
    </View>
  )
}

function CheckpointRow({
  cp,
  resp,
  showConditionals,
}: {
  cp:               DinerPdfCheckpoint
  resp:             DinerPdfResponse | undefined
  showConditionals: boolean
}) {
  if (cp.isConditional && !showConditionals) return null

  const result     = resp?.result ?? null
  const notes      = resp?.notes  ?? null
  const isCritFail = cp.isCritical && cp.type === 'scored' && result === 'fail'
  const isGoldPass = cp.type === 'gold_star' && result === 'pass'

  // Row background tint
  let rowBg: string | undefined
  if      (isCritFail)  rowBg = '#fdf3f3'
  else if (isGoldPass)  rowBg = '#fdfaed'

  // Name style (ternary preserves union type — avoids StyleSheet literal color mismatches)
  const nameStyle =
    isCritFail                    ? s.cpNameCritFail :
    isGoldPass                    ? s.cpNameGold :
    cp.type === 'informational'   ? s.cpNameInfo :
                                    s.cpName

  // Result area
  let resultEl: React.ReactNode

  if (cp.type === 'informational') {
    // Show the notes value (e.g. Shazam track) as right-side italic text, no badge box
    resultEl = notes
      ? <Text style={s.cpInfoNotes}>{notes}</Text>
      : null
  } else if (cp.type === 'waiting_time') {
    const display   = notes ? `${notes} min` : '—'
    const isCritWt  = notes === '20+'
    resultEl = <Text style={[s.badge, isCritWt ? s.badgeWaitCrit : s.badgeWait]}>{display}</Text>
  } else if (cp.type === 'gold_star') {
    if      (result === 'pass') resultEl = <Text style={[s.badge, s.badgeGold]}>★ Gold Star</Text>
    else if (result === 'na')   resultEl = <Text style={[s.badge, s.badgeNa]}>N/A</Text>
    else if (result === 'fail') resultEl = <Text style={[s.badge, s.badgeNa]}>Not achieved</Text>
    else                        resultEl = <Text style={[s.badge, s.badgeNa]}>—</Text>
  } else {
    // scored
    if      (result === 'pass') resultEl = <Text style={[s.badge, s.badgePass]}>Pass</Text>
    else if (result === 'fail') resultEl = <Text style={[s.badge, s.badgeFail]}>Fail</Text>
    else if (result === 'na')   resultEl = <Text style={[s.badge, s.badgeNa]}>N/A</Text>
    else                        resultEl = <Text style={[s.badge, s.badgeNa]}>—</Text>
  }

  return (
    <View
      style={[s.cpRow, rowBg ? { backgroundColor: rowBg } : {}]}
      wrap={false}
    >
      <Text style={s.cpIdx}>{cp.orderIndex}</Text>
      {cp.isCritical && cp.type === 'scored' && (
        <Text style={s.cpCritBadge}>C</Text>
      )}
      {cp.isConditional && (
        <Text style={s.cpCondBadge}>IF&gt;15</Text>
      )}
      <Text style={nameStyle}>{cp.label}</Text>
      {resultEl}
    </View>
  )
}

function SectionCard({
  section,
  checkpoints,
  responseMap,
  showConditionals,
}: {
  section:          string
  checkpoints:      DinerPdfCheckpoint[]
  responseMap:      Map<string, DinerPdfResponse>
  showConditionals: boolean
}) {
  const visible = checkpoints.filter(cp => !(cp.isConditional && !showConditionals))

  // Count assessed (non-informational, has a result/notes)
  const scoredVisible  = visible.filter(cp => cp.type !== 'informational')
  const answeredCount  = scoredVisible.filter(cp => {
    const resp = responseMap.get(cp.id)
    if (!resp) return false
    return cp.type === 'waiting_time'
      ? (resp.notes ?? '').trim() !== ''
      : resp.result !== null
  }).length

  return (
    <View style={s.sectionCard}>
      <View style={s.sectionHeader} wrap={false}>
        <Text style={s.sectionTitle}>{section}</Text>
        <Text style={s.sectionCount}>{answeredCount}/{scoredVisible.length}</Text>
      </View>
      {visible.map(cp => (
        <CheckpointRow
          key={cp.id}
          cp={cp}
          resp={responseMap.get(cp.id)}
          showConditionals={showConditionals}
        />
      ))}
    </View>
  )
}

function NotAssessedSummary({ sections }: { sections: string[] }) {
  if (!sections.length) return null
  return (
    <View style={s.notAssessedCard} wrap={false}>
      <Text style={s.notAssessedLabel}>Not assessed in this visit</Text>
      <View style={s.notAssessedList}>
        {sections.map(sec => (
          <Text key={sec} style={s.notAssessedChip}>{sec}</Text>
        ))}
      </View>
    </View>
  )
}

// ─── Main document ────────────────────────────────────────────────────────────

interface Props {
  input:       DinerPdfInput
  generatedAt?: string
}

export function DinerReportDocument({ input, generatedAt }: Props) {
  const generatedStr = (generatedAt ? new Date(generatedAt) : new Date())
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  const dateStr = fmtDate(input.submittedAt)

  const responseMap     = new Map(input.responses.map(r => [r.checkpointId, r]))
  const showConditionals = shouldShowConditional(input.waitingTimeBand)

  // Group checkpoints by section, preserving protocol order
  const sectionOrder: string[] = []
  const sectionMap   = new Map<string, DinerPdfCheckpoint[]>()
  for (const cp of input.checkpoints) {
    if (!sectionMap.has(cp.section)) {
      sectionOrder.push(cp.section)
      sectionMap.set(cp.section, [])
    }
    sectionMap.get(cp.section)!.push(cp)
  }

  // Separate assessed sections from fully-skipped ones
  const assessedSections: string[] = []
  const skippedSections:  string[] = []

  for (const section of sectionOrder) {
    const cps     = sectionMap.get(section)!
    const visible = cps.filter(cp => !(cp.isConditional && !showConditionals))

    // A section is "assessed" if any visible, non-informational checkpoint has a response,
    // or if it contains informational checkpoints (always shown — e.g. Music/Shazam).
    const hasInformational  = visible.some(cp => cp.type === 'informational')
    const hasAnyResponse    = visible.some(cp => {
      if (cp.type === 'informational') return false
      const resp = responseMap.get(cp.id)
      if (!resp) return false
      return cp.type === 'waiting_time'
        ? (resp.notes ?? '').trim() !== ''
        : resp.result !== null
    })

    if (hasInformational || hasAnyResponse) {
      assessedSections.push(section)
    } else {
      skippedSections.push(section)
    }
  }

  return (
    <Document
      title={`Mystery Diner — ${input.locationName} — ${dateStr}`}
      author="Killer Kockpit"
      creator="Killer Kockpit"
    >
      <Page size="A4" style={s.page}>

        {/* ── Header (fixed — repeats on every page) ─────────────────────── */}
        <View style={s.header} fixed>
          <View style={s.headerRedBar} />
          <View style={s.headerContent}>
            <View>
              <Text style={s.headerBrand}>Killer Kebab</Text>
              <Text style={s.headerTitle}>Mystery Diner</Text>
              <Text style={s.headerLocation}>{input.locationName}</Text>
            </View>
            <View style={s.headerMeta}>
              <Text style={s.headerDate}>{dateStr}</Text>
              <Text style={s.headerDiner}>{input.dinerName}</Text>
            </View>
          </View>
        </View>

        <View style={s.body}>

          {/* ── Result summary ────────────────────────────────────────────── */}
          <ResultSummaryCard input={input} />

          {/* ── Critical failures list ────────────────────────────────────── */}
          <CriticalFailuresBanner checkpoints={input.checkpoints} responseMap={responseMap} />

          {/* ── Protocol sections ─────────────────────────────────────────── */}
          {assessedSections.map(section => (
            <SectionCard
              key={section}
              section={section}
              checkpoints={sectionMap.get(section)!}
              responseMap={responseMap}
              showConditionals={showConditionals}
            />
          ))}

          {/* ── Fully-skipped sections collapsed to chip list ─────────────── */}
          <NotAssessedSummary sections={skippedSections} />

        </View>

        {/* ── Footer (fixed — repeats on every page) ──────────────────────── */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>Killer Kockpit</Text>
          <Text style={s.footerText}>
            Generated {generatedStr} · Killer Kebab internal use only
          </Text>
        </View>

      </Page>
    </Document>
  )
}
