/**
 * lib/reports/kkc-report.tsx
 *
 * React-PDF document for Killer Kuality Check reports.
 *
 * Section order, checkpoint order, and display names are derived from
 * lib/kkc/presentation.ts — the same canonical source as the live dashboard —
 * so the PDF cannot drift independently.
 *
 * Sections where every checkpoint is Not assessed are compressed into a single
 * "Not assessed in this visit" summary rather than showing empty tables.
 */

import React from 'react'
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from '@react-pdf/renderer'
import { groupBySection, displaySection } from '@/lib/kkc/presentation'
import type { KKCSubmissionDetail, KKCCheckpointResult, KKCSectionComment } from '@/lib/kkc/ssp-cph'

// ─── Brand colours ────────────────────────────────────────────────────────────

const C = {
  red:       '#AD3919',   // Killer Red — branding only
  yellow:    '#F5DA93',   // Killer Yellow — critical badge bg
  ink:       '#171717',   // charcoal — body text
  muted:     '#6b6760',   // muted grey — labels, secondary text
  sectionBg: '#DDD9D1',   // warm structural grey — section headers
  good:      '#2f6d4c',   // semantic green — pass / no failures
  goodBg:    '#e7f1eb',
  bad:       '#8d3737',   // semantic red — fail / critical
  badBg:     '#f5e7e7',
  badBorder: '#d98080',
  warn:      '#8a5b16',   // semantic amber — score 75–89%
  border:    '#d9d4cc',   // card borders
  soft:      '#eceae4',   // warm grey — zebra rows, not-assessed bg
  bg:        '#f5f3ee',   // off-white page background
  white:     '#ffffff',
} as const

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    backgroundColor: C.bg,
    fontFamily:      'Helvetica',
    fontSize:        9,
    color:           C.ink,
    paddingBottom:   40,
  },

  // ── Header (fixed — appears on every page) ────────────────────────────────
  header: {
    backgroundColor: C.white,
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
    fontSize:   9,
    color:      C.muted,
    marginTop:  2,
  },
  headerDateBlock: {
    alignItems: 'flex-end',
    paddingTop: 1,
  },
  headerDate: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  headerTime: {
    fontSize:  8,
    color:     C.muted,
    marginTop: 2,
  },

  // ── Body ──────────────────────────────────────────────────────────────────
  body: {
    paddingHorizontal: 28,
    paddingTop:        14,
  },

  // ── Meta row ──────────────────────────────────────────────────────────────
  metaCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         12,
    marginBottom:    10,
    flexDirection:   'row',
    gap:             10,
  },
  metaItem: {
    flexDirection: 'column',
    flex:          1,
  },
  metaLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  2,
  },
  metaValue: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },

  // ── Score boxes ───────────────────────────────────────────────────────────
  scoreRow: {
    flexDirection: 'row',
    gap:           8,
    marginBottom:  10,
  },
  scoreBox: {
    flex:            1,
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         10,
    alignItems:      'center',
  },
  scoreLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  4,
  },
  scoreValue: {
    fontSize:   22,
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
    backgroundColor:   C.sectionBg,     // warm structural grey
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

  // ── Checkpoint row ────────────────────────────────────────────────────────
  cpRow: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderBottomWidth: 1,
    borderBottomColor: C.soft,
  },
  cpCritBadge: {
    fontSize:          6,
    fontFamily:        'Helvetica-Bold',
    color:             C.red,            // Killer Red text
    backgroundColor:   C.yellow,         // Killer Yellow bg — matches dashboard
    borderRadius:      2,
    paddingHorizontal: 3,
    paddingVertical:   1,
    marginRight:       5,
    lineHeight:        1,
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
  cpResult: {
    fontSize:          7,
    fontFamily:        'Helvetica-Bold',
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      3,
    borderWidth:       1,
    marginLeft:        8,
    textAlign:         'center',
    minWidth:          60,
  },
  resultPass: {
    color:           C.good,
    backgroundColor: C.goodBg,
    borderColor:     '#a8cfba',
  },
  resultFail: {
    color:           C.bad,
    backgroundColor: C.badBg,
    borderColor:     C.badBorder,
  },
  resultNa: {
    color:           C.muted,
    backgroundColor: C.soft,
    borderColor:     C.border,
  },

  // ── Section comment ───────────────────────────────────────────────────────
  sectionComment: {
    paddingHorizontal: 10,
    paddingVertical:   7,
    borderTopWidth:    1,
    borderTopColor:    C.soft,
  },
  sectionCommentLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom:  3,
  },
  sectionCommentText: {
    fontSize:   8,
    color:      C.ink,
    lineHeight: 1.5,
  },

  // ── Overall comments ──────────────────────────────────────────────────────
  overallCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         12,
    marginBottom:    10,
  },
  overallLabel: {
    fontSize:      7,
    fontFamily:    'Helvetica-Bold',
    color:         C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom:  5,
  },
  overallText: {
    fontSize:   9,
    color:      C.ink,
    lineHeight: 1.5,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(pct: number): string {
  if (pct >= 90) return C.good
  if (pct >= 75) return C.warn
  return C.bad
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={s.scoreBox}>
      <Text style={s.scoreLabel}>{label}</Text>
      <Text style={[s.scoreValue, { color }]}>{value}</Text>
    </View>
  )
}

function CriticalFailuresBanner({ failures }: { failures: KKCCheckpointResult[] }) {
  if (!failures.length) return null
  return (
    <View style={s.critBanner} wrap={false}>
      <Text style={s.critBannerTitle}>Critical Failures ({failures.length})</Text>
      {failures.map((f, i) => (
        <View key={i} style={s.critBannerItem}>
          <Text style={s.critBannerDot}>•</Text>
          <Text style={s.critBannerText}>{displaySection(f.section)} — {f.checkpoint}</Text>
        </View>
      ))}
    </View>
  )
}

function CheckpointRow({ cp }: { cp: KKCCheckpointResult }) {
  const isCritFail   = cp.isCritical && cp.result === 'Unacceptable'
  const resultStyle  = cp.result === 'Acceptable' ? s.resultPass
    : cp.result === 'Unacceptable' ? s.resultFail
    : s.resultNa
  const resultLabel  = cp.result ?? 'Not assessed'

  return (
    <View
      style={[s.cpRow, isCritFail ? { backgroundColor: '#fdf3f3' } : {}]}
      wrap={false}
    >
      {cp.isCritical && <Text style={s.cpCritBadge}>C</Text>}
      <Text style={isCritFail ? s.cpNameCritFail : s.cpName}>{cp.checkpoint}</Text>
      <Text style={[s.cpResult, resultStyle]}>{resultLabel}</Text>
    </View>
  )
}

function SectionCard({
  section,
  checkpoints,
  comment,
}: {
  section:    string
  checkpoints: KKCCheckpointResult[]
  comment?:   KKCSectionComment
}) {
  const assessed = checkpoints.filter(cp => cp.result !== null).length
  const label    = displaySection(section)

  return (
    <View style={s.sectionCard}>
      <View style={s.sectionHeader} wrap={false}>
        <Text style={s.sectionTitle}>{label}</Text>
        <Text style={s.sectionCount}>{assessed}/{checkpoints.length}</Text>
      </View>
      {checkpoints.map((cp, i) => (
        <CheckpointRow key={i} cp={cp} />
      ))}
      {comment && (
        <View style={s.sectionComment}>
          <Text style={s.sectionCommentLabel}>Notes</Text>
          <Text style={s.sectionCommentText}>{comment.text}</Text>
        </View>
      )}
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
          <Text key={sec} style={s.notAssessedChip}>{displaySection(sec)}</Text>
        ))}
      </View>
    </View>
  )
}

// ─── Main document ────────────────────────────────────────────────────────────

interface Props {
  detail:        KKCSubmissionDetail
  locationLabel: string
  generatedAt?:  string
}

export function KKCReportDocument({ detail, locationLabel, generatedAt }: Props) {
  const generated    = generatedAt ? new Date(generatedAt) : new Date()
  const generatedStr = generated.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })

  // Group checkpoints using canonical section/checkpoint order from presentation.ts
  const grouped = groupBySection(detail.checkpoints)

  // Split into fully-assessed (≥1 result) and fully-skipped (all null)
  const assessedSections: typeof grouped = []
  const skippedSectionNames: string[]    = []

  for (const g of grouped) {
    const hasAny = g.checkpoints.some(cp => cp.result !== null)
    if (hasAny) {
      assessedSections.push(g)
    } else {
      skippedSectionNames.push(g.section)
    }
  }

  // Map section comments by section name for joining
  const commentBySection = new Map<string, KKCSectionComment>()
  for (const sc of detail.sectionComments) {
    // Strip "Comments — " or "Comments (" style prefix to get section name key
    const key = sc.header
      .replace(/^Comments\s*[—–\-(]\s*/i, '')
      .replace(/\)$/, '')
      .trim()
      .toLowerCase()
    commentBySection.set(key, sc)
  }

  return (
    <Document
      title={`KQC Report — ${locationLabel} — ${detail.date}`}
      author="Killer Kockpit"
      creator="Killer Kockpit"
    >
      <Page size="A4" style={s.page}>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <View style={s.header} fixed>
          <View style={s.headerRedBar} />
          <View style={s.headerContent}>
            <View>
              <Text style={s.headerBrand}>Killer Kebab</Text>
              <Text style={s.headerTitle}>Killer Kuality Check</Text>
              <Text style={s.headerLocation}>{locationLabel}</Text>
            </View>
            <View style={s.headerDateBlock}>
              <Text style={s.headerDate}>{detail.date}</Text>
              {detail.time ? <Text style={s.headerTime}>{detail.time}</Text> : null}
            </View>
          </View>
        </View>

        <View style={s.body}>

          {/* ── Meta ─────────────────────────────────────────────────────── */}
          <View style={s.metaCard} wrap={false}>
            <View style={s.metaItem}>
              <Text style={s.metaLabel}>Mystery Diner</Text>
              <Text style={s.metaValue}>{detail.mysteryDiner || '—'}</Text>
            </View>
            <View style={s.metaItem}>
              <Text style={s.metaLabel}>Products Ordered</Text>
              <Text style={s.metaValue}>{detail.productsOrdered || '—'}</Text>
            </View>
            <View style={s.metaItem}>
              <Text style={s.metaLabel}>Date</Text>
              <Text style={s.metaValue}>{detail.date}</Text>
            </View>
            <View style={s.metaItem}>
              <Text style={s.metaLabel}>Time</Text>
              <Text style={s.metaValue}>{detail.time || '—'}</Text>
            </View>
          </View>

          {/* ── Scores ───────────────────────────────────────────────────── */}
          <View style={s.scoreRow} wrap={false}>
            <ScoreBox
              label="Overall Score"
              value={`${detail.overallScore}%`}
              color={scoreColor(detail.overallScore)}
            />
            <ScoreBox
              label="Critical Score"
              value={`${detail.criticalScore}%`}
              color={scoreColor(detail.criticalScore)}
            />
            <ScoreBox
              label="Critical Failures"
              value={String(detail.criticalFailures)}
              color={detail.criticalFailures > 0 ? C.bad : C.good}
            />
          </View>

          {/* ── Critical failure detail ───────────────────────────────────── */}
          <CriticalFailuresBanner failures={detail.criticalFailureDetails} />

          {/* ── Assessed sections ─────────────────────────────────────────── */}
          {assessedSections.map(({ section, checkpoints }) => {
            const comment = commentBySection.get(section.toLowerCase())
              ?? commentBySection.get(displaySection(section).toLowerCase())
            return (
              <SectionCard
                key={section}
                section={section}
                checkpoints={checkpoints}
                comment={comment}
              />
            )
          })}

          {/* ── Not-assessed summary ──────────────────────────────────────── */}
          <NotAssessedSummary sections={skippedSectionNames} />

          {/* ── Overall comments ──────────────────────────────────────────── */}
          {detail.overallComments && (
            <View style={s.overallCard} wrap={false}>
              <Text style={s.overallLabel}>Overall Comments / Observations</Text>
              <Text style={s.overallText}>{detail.overallComments}</Text>
            </View>
          )}

        </View>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>Killer Kockpit</Text>
          <Text style={s.footerText}>Generated {generatedStr} · Killer Kebab internal use only</Text>
        </View>

      </Page>
    </Document>
  )
}
