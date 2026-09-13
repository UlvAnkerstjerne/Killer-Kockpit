/**
 * lib/reports/audit-report.tsx
 *
 * React-PDF document for internal Audit reports.
 * Server-only — do not import from client components.
 *
 * Visual language matches kkc-report.tsx: same brand colours, header bar,
 * score box grid, and footer.
 */

import React from 'react'
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditReportTopAction {
  sort_order: number
  action:     string
  owner:      string | null
  deadline:   string | null
}

export interface AuditReportInput {
  submissionId:         string
  locationName:         string
  auditorName:          string
  date:                 string    // pre-formatted, e.g. "10 Sep 2026"
  overallPct:           number
  corePct:              number
  redFlagCount:         number
  auditStatus:          string    // e.g. "GREEN", "YELLOW"
  topActions:           AuditReportTopAction[]
  finalDoneWell:        string | null
  finalFocusNext:       string | null
  finalOverallComments: string | null
  generatedAt?:         string
}

// ─── Brand colours ────────────────────────────────────────────────────────────

const C = {
  red:       '#AD3919',
  yellow:    '#F5DA93',
  ink:       '#171717',
  muted:     '#6b6760',
  good:      '#2f6d4c',
  goodBg:    '#e7f1eb',
  goodBdr:   '#7bbf9a',
  bad:       '#8d3737',
  badBg:     '#f5e7e7',
  badBdr:    '#d98080',
  warn:      '#8a5b16',
  warnBg:    '#fdf4e1',
  warnBdr:   '#d4a030',
  border:    '#d9d4cc',
  soft:      '#eceae4',
  bg:        '#f5f3ee',
  white:     '#ffffff',
  sectionBg: '#DDD9D1',
} as const

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'GREEN':       return C.good
    case 'LIGHT_GREEN': return '#3a7d5a'
    case 'YELLOW':      return C.warn
    case 'ORANGE':      return '#8a5220'
    case 'RED':         return C.bad
    default:            return C.muted
  }
}

function scoreColor(pct: number): string {
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
  headerLocation: {
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
  headerAuditor: {
    fontSize:  8,
    color:     C.muted,
    marginTop: 2,
  },
  body: {
    paddingHorizontal: 28,
    paddingTop:        14,
  },
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
  statusValue: {
    fontSize:   14,
    fontFamily: 'Helvetica-Bold',
  },
  sectionCard: {
    backgroundColor: C.white,
    borderRadius:    5,
    borderWidth:     1,
    borderColor:     C.border,
    marginBottom:    8,
    overflow:        'hidden',
  },
  sectionHeader: {
    backgroundColor:   C.sectionBg,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingHorizontal: 10,
    paddingVertical:   5,
  },
  sectionTitle: {
    fontSize:   9,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  sectionBody: {
    padding: 10,
  },
  sectionText: {
    fontSize:   8.5,
    color:      C.ink,
    lineHeight: 1.5,
  },
  actionRow: {
    flexDirection:     'row',
    borderBottomWidth: 1,
    borderBottomColor: C.soft,
    paddingVertical:   5,
    paddingHorizontal: 10,
    alignItems:        'flex-start',
    gap:               8,
  },
  actionNum: {
    fontSize:   8,
    fontFamily: 'Helvetica-Bold',
    color:      C.muted,
    width:      14,
  },
  actionText: {
    flex:       1,
    fontSize:   8.5,
    color:      C.ink,
    lineHeight: 1.4,
  },
  actionMeta: {
    fontSize:  7.5,
    color:     C.muted,
    marginTop: 2,
  },
  footer: {
    position:        'absolute',
    bottom:          0,
    left:            0,
    right:           0,
    backgroundColor: C.white,
    borderTopWidth:  1,
    borderTopColor:  C.border,
    paddingVertical: 8,
    paddingHorizontal: 28,
    flexDirection:   'row',
    justifyContent:  'space-between',
    alignItems:      'center',
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

// ─── Document ─────────────────────────────────────────────────────────────────

export function AuditReportDocument({ input }: { input: AuditReportInput }) {
  const {
    locationName, auditorName, date, overallPct, corePct, redFlagCount,
    auditStatus, topActions, finalDoneWell, finalFocusNext, finalOverallComments,
    generatedAt,
  } = input

  const genStr = generatedAt
    ? new Date(generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <Document title={`Audit — ${locationName} — ${date}`} author="Killer Kockpit">
      <Page size="A4" style={s.page}>

        {/* ── Red bar + header ── */}
        <View fixed>
          <View style={s.redBar} />
          <View style={s.headerContent}>
            <View>
              <Text style={s.headerBrand}>KILLER KEBAB</Text>
              <Text style={s.headerTitle}>Audit Report</Text>
              <Text style={s.headerLocation}>{locationName}</Text>
            </View>
            <View style={s.headerRight}>
              <Text style={s.headerDate}>{date}</Text>
              <Text style={s.headerAuditor}>Auditor: {auditorName}</Text>
            </View>
          </View>
        </View>

        <View style={s.body}>

          {/* ── Score boxes ── */}
          <View style={s.scoreRow}>
            <View style={s.scoreBox}>
              <Text style={s.scoreLabel}>Overall</Text>
              <Text style={[s.scoreValue, { color: scoreColor(overallPct) }]}>{overallPct}%</Text>
            </View>
            <View style={s.scoreBox}>
              <Text style={s.scoreLabel}>Core Standards</Text>
              <Text style={[s.scoreValue, { color: scoreColor(corePct) }]}>{corePct}%</Text>
            </View>
            <View style={s.scoreBox}>
              <Text style={s.scoreLabel}>Red Flags</Text>
              <Text style={[s.scoreValue, { color: redFlagCount > 0 ? C.bad : C.good }]}>
                {redFlagCount}
              </Text>
            </View>
            <View style={s.scoreBox}>
              <Text style={s.scoreLabel}>Status</Text>
              <Text style={[s.statusValue, { color: statusColor(auditStatus) }]}>
                {auditStatus.replace('_', ' ')}
              </Text>
            </View>
          </View>

          {/* ── Top 3 actions ── */}
          {topActions.length > 0 && (
            <View style={s.sectionCard}>
              <View style={s.sectionHeader}>
                <Text style={s.sectionTitle}>Top Actions</Text>
              </View>
              {topActions.map((a, i) => (
                <View
                  key={i}
                  style={[
                    s.actionRow,
                    i === topActions.length - 1 ? { borderBottomWidth: 0 } : {},
                  ]}
                >
                  <Text style={s.actionNum}>{a.sort_order}.</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.actionText}>{a.action || '—'}</Text>
                    {(a.owner || a.deadline) && (
                      <Text style={s.actionMeta}>
                        {[a.owner, a.deadline].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* ── Done well ── */}
          {finalDoneWell && (
            <View style={s.sectionCard}>
              <View style={s.sectionHeader}>
                <Text style={s.sectionTitle}>Done Well</Text>
              </View>
              <View style={s.sectionBody}>
                <Text style={s.sectionText}>{finalDoneWell}</Text>
              </View>
            </View>
          )}

          {/* ── Focus next ── */}
          {finalFocusNext && (
            <View style={s.sectionCard}>
              <View style={s.sectionHeader}>
                <Text style={s.sectionTitle}>Focus Next Visit</Text>
              </View>
              <View style={s.sectionBody}>
                <Text style={s.sectionText}>{finalFocusNext}</Text>
              </View>
            </View>
          )}

          {/* ── Overall comments ── */}
          {finalOverallComments && (
            <View style={s.sectionCard}>
              <View style={s.sectionHeader}>
                <Text style={s.sectionTitle}>Overall Comments</Text>
              </View>
              <View style={s.sectionBody}>
                <Text style={s.sectionText}>{finalOverallComments}</Text>
              </View>
            </View>
          )}

        </View>

        {/* ── Footer ── */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>Killer Kockpit</Text>
          <Text style={s.footerText}>Generated {genStr} · Internal use only</Text>
        </View>

      </Page>
    </Document>
  )
}
