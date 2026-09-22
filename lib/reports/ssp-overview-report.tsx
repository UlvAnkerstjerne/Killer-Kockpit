/**
 * lib/reports/ssp-overview-report.tsx
 *
 * SSP/CPH KQC Overview PDF — A4 portrait.
 *
 * A clean, printable checkpoint matrix intended for external use (e.g. SSP).
 * Content: compact brand header · inline legend · full checkpoint matrix.
 *
 * Deliberately excludes: KPI summary tiles, trend chart, recurring-failures
 * section, visit-detail pages, checker names, and internal notes.
 *
 * Server-only. Do not import from client components.
 */

import React from 'react'
import { Document, Page, View, Text } from '@react-pdf/renderer'
import { groupBySection, displaySection } from '@/lib/kkc/presentation'
import type { KKCSspCphData, KKCResult, KKCScoreRow } from '@/lib/kkc/ssp-cph'
import { buildSubmissionDetail } from '@/lib/kkc/detail'

// ─── Layout constants ──────────────────────────────────────────────────────────

// A4 portrait: 595 × 842 pt
const PM     = 15                  // left/right page margin
const USABLE = 595 - PM * 2       // 565pt usable width

const CP_COL = 185                 // checkpoint-name column width
// Visit column width is computed per chunk based on visit count

const COLS_PER_PAGE = 5           // max visits per horizontal chunk

// ─── Brand colours ─────────────────────────────────────────────────────────────

const C = {
  red:       '#AD3919',
  yellow:    '#F5DA93',
  ink:       '#171717',
  muted:     '#6b6760',
  good:      '#2f6d4c',
  warn:      '#8a5b16',
  goodCell:  '#c8e6d0',
  badCell:   '#f5cdc7',
  naCell:    '#eceae4',
  border:    '#d9d4cc',
  soft:      '#e5e1da',
  headerBg:  '#f0ede7',
  sectionBg: '#e4e0d9',
  white:     '#ffffff',
} as const

// ─── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtDateShort(d: string): string {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${parseInt(m[3])} ${MONTHS[parseInt(m[2]) - 1]}` : d
}

function scoreColor(n: number): string {
  return n >= 90 ? C.good : n >= 75 ? C.warn : C.red
}

function cellBg(r: KKCResult | null): string {
  return r === 'Acceptable' ? C.goodCell : r === 'Unacceptable' ? C.badCell : C.naCell
}

function buildResultMatrix(
  data: KKCSspCphData,
): Map<string, Map<string, KKCResult | null>> {
  const idx = new Map(data.formHeaders.map((h, i) => [h, i]))
  const out  = new Map<string, Map<string, KKCResult | null>>()
  for (const score of data.scores) {
    const row = data.formRows.find(r => r[0] === score.timestamp)
    const map = new Map<string, KKCResult | null>()
    for (const cp of data.config) {
      const ci  = idx.get(cp.responseHeader)
      const raw = row && ci !== undefined ? (row[ci] ?? '').trim() : ''
      map.set(cp.responseHeader,
        raw === 'Acceptable'   ? 'Acceptable'   :
        raw === 'Unacceptable' ? 'Unacceptable' : null)
    }
    out.set(score.timestamp, map)
  }
  return out
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SspOverviewInput {
  data:         KKCSspCphData
  count:        number
  generatedAt?: string
}

// ─── Document ──────────────────────────────────────────────────────────────────

export function SspOverviewDocument({ input }: { input: SspOverviewInput }) {
  const { data, count, generatedAt } = input

  const genStr = (generatedAt ? new Date(generatedAt) : new Date())
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  const allVisits = data.scores.slice(-count)
  const resultMx  = buildResultMatrix(data)
  const sections  = groupBySection(data.config)

  if (allVisits.length === 0) {
    return (
      <Document title="KQC SSP / CPH Overview" author="Killer Kockpit">
        <Page size="A4" style={{ fontFamily: 'Helvetica', fontSize: 9, color: C.ink }}>
          <Text style={{ padding: 28, fontSize: 12, color: C.muted }}>No data available.</Text>
        </Page>
      </Document>
    )
  }

  const dateRange = allVisits.length === 1
    ? fmtDateShort(allVisits[0].date)
    : `${fmtDateShort(allVisits[0].date)} – ${fmtDateShort(allVisits[allVisits.length - 1].date)}`

  // Horizontal chunks (one <Page> per chunk)
  const chunks: KKCScoreRow[][] = []
  for (let i = 0; i < allVisits.length; i += COLS_PER_PAGE)
    chunks.push(allVisits.slice(i, i + COLS_PER_PAGE))

  const CELL = 11   // result cell square size (pt)

  // Build comments data for the selected visits, most recent first
  const commentsData = [...allVisits].reverse().map(visit => {
    const detail = buildSubmissionDetail(data, visit.timestamp)
    const sectionComments = detail?.sectionComments ?? []
    const overallComments = detail?.overallComments ?? null
    return { date: visit.date, time: visit.time, sectionComments, overallComments }
  }).filter(v => v.sectionComments.length > 0 || v.overallComments !== null)

  return (
    <Document
      title={`KQC SSP / CPH Overview — Last ${allVisits.length}`}
      author="Killer Kockpit"
      creator="Killer Kockpit"
    >
      {chunks.map((visits, chunkIdx) => {
        const vColW = Math.floor((USABLE - CP_COL) / visits.length)

        return (
          <Page key={chunkIdx} size="A4" style={{
            fontFamily:      'Helvetica',
            fontSize:        9,
            color:           C.ink,
            backgroundColor: C.white,
            paddingBottom:   18,
          }}>

            {/* ─────────────────────────────────────────────────────────────── */}
            {/* FIXED HEADER                                                     */}
            {/* Includes: brand/title, legend, and visit column date headers.    */}
            {/* Marked fixed so it repeats on every auto-generated continuation  */}
            {/* page for datasets that overflow a single A4 sheet.               */}
            {/* ─────────────────────────────────────────────────────────────── */}
            <View fixed style={{ backgroundColor: C.white }}>

              {/* Red accent stripe */}
              <View style={{ height: 3, backgroundColor: C.red }} />

              {/* Title bar */}
              <View style={{
                paddingHorizontal: PM,
                paddingTop:        6,
                paddingBottom:     5,
                flexDirection:     'row',
                justifyContent:    'space-between',
                alignItems:        'flex-end',
                borderBottomWidth: 0.5,
                borderBottomColor: C.border,
              }}>
                <View>
                  <Text style={{
                    fontSize: 6, fontFamily: 'Helvetica-Bold',
                    color: C.red, letterSpacing: 1.1, marginBottom: 2,
                  }}>
                    KILLER KEBAB
                  </Text>
                  <Text style={{
                    fontSize: 13, fontFamily: 'Helvetica-Bold',
                    color: C.ink, marginBottom: 2,
                  }}>
                    KQC SSP / CPH Overview
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Text style={{ fontSize: 7.5, color: C.muted }}>SSP / CPH Airport</Text>
                    <Text style={{ fontSize: 6.5, color: C.border }}>·</Text>
                    <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: C.ink }}>{dateRange}</Text>
                    <Text style={{ fontSize: 6.5, color: C.border }}>·</Text>
                    <Text style={{ fontSize: 7.5, color: C.muted }}>
                      {allVisits.length} {allVisits.length === 1 ? 'report' : 'reports'}
                    </Text>
                  </View>
                </View>
                <Text style={{ fontSize: 6.5, color: C.muted }}>Generated {genStr}</Text>
              </View>

              {/* Legend row + visit column headers — combined band */}
              <View style={{
                backgroundColor:   C.headerBg,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
              }}>
                {/* Inline legend */}
                <View style={{
                  paddingHorizontal: PM,
                  paddingVertical:   3,
                  flexDirection:     'row',
                  alignItems:        'center',
                  gap:               10,
                  borderBottomWidth: 0.5,
                  borderBottomColor: C.border,
                }}>
                  <Text style={{
                    fontSize: 5.5, fontFamily: 'Helvetica-Bold',
                    color: C.muted, letterSpacing: 0.4,
                  }}>LEGEND</Text>
                  {([
                    { bg: C.goodCell, label: 'Acceptable' },
                    { bg: C.badCell,  label: 'Unacceptable' },
                    { bg: C.naCell,   label: 'Not assessed' },
                  ] as const).map(({ bg, label }) => (
                    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      <View style={{ width: 7, height: 7, backgroundColor: bg, borderRadius: 1 }} />
                      <Text style={{ fontSize: 6, color: C.muted }}>{label}</Text>
                    </View>
                  ))}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                    <Text style={{
                      fontSize: 5, fontFamily: 'Helvetica-Bold',
                      color: C.red, backgroundColor: C.yellow,
                      borderRadius: 1, paddingHorizontal: 2, paddingVertical: 0.5, lineHeight: 1,
                    }}>C</Text>
                    <Text style={{ fontSize: 6, color: C.muted }}>Critical</Text>
                  </View>
                </View>

                {/* Visit date / time column headers */}
                <View style={{
                  paddingHorizontal: PM,
                  flexDirection:     'row',
                }}>
                  <View style={{
                    width:            CP_COL,
                    paddingVertical:  4,
                    paddingHorizontal: 5,
                  }}>
                    <Text style={{
                      fontSize: 5.5, fontFamily: 'Helvetica-Bold',
                      color: C.muted, letterSpacing: 0.4,
                    }}>CHECKPOINT</Text>
                  </View>
                  {visits.map((v, i) => (
                    <View key={v.timestamp} style={{
                      width:          vColW,
                      paddingVertical: 3,
                      alignItems:     'center',
                      borderLeftWidth: i === 0 ? 1 : 0.5,
                      borderLeftColor: C.border,
                    }}>
                      <Text style={{
                        fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: C.ink,
                      }}>
                        {fmtDateShort(v.date)}
                      </Text>
                      {v.time && (
                        <Text style={{ fontSize: 6, color: C.muted, marginTop: 0.5 }}>
                          {v.time}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              </View>
            </View>
            {/* END FIXED HEADER */}

            {/* ─────────────────────────────────────────────────────────────── */}
            {/* MATRIX BODY                                                      */}
            {/* Summary rows + all checkpoint sections, auto-paginates vertically*/}
            {/* ─────────────────────────────────────────────────────────────── */}
            <View style={{ paddingHorizontal: PM, paddingTop: 4 }}>

              {/* Summary rows: OVERALL, CRITICAL, CRIT. FAILURES */}
              <View style={{
                borderWidth:  1,
                borderColor:  C.border,
                borderRadius: 2,
                overflow:     'hidden',
                marginBottom: 3,
              }}>
                {([
                  {
                    label:  'OVERALL',
                    render: (v: KKCScoreRow) => ({ val: `${v.overallScore}%`, color: scoreColor(v.overallScore) }),
                  },
                  {
                    label:  'CRITICAL',
                    render: (v: KKCScoreRow) => ({ val: `${v.criticalScore}%`, color: scoreColor(v.criticalScore) }),
                  },
                  {
                    label:  'CRIT. FAILURES',
                    render: (v: KKCScoreRow) => ({
                      val:   String(v.criticalFailures),
                      color: v.criticalFailures > 0 ? C.red : C.good,
                    }),
                  },
                ] as const).map(({ label, render }, ri, arr) => (
                  <View key={label} style={{
                    flexDirection:     'row',
                    height:            15,
                    alignItems:        'center',
                    backgroundColor:   C.headerBg,
                    borderBottomWidth: ri < arr.length - 1 ? 0.5 : 0,
                    borderBottomColor: C.soft,
                  }}>
                    <View style={{
                      width:             CP_COL,
                      height:            15,
                      justifyContent:    'center',
                      paddingHorizontal: 5,
                      borderRightWidth:  1,
                      borderRightColor:  C.border,
                    }}>
                      <Text style={{
                        fontSize: 6, fontFamily: 'Helvetica-Bold',
                        color: C.muted, letterSpacing: 0.4,
                      }}>{label}</Text>
                    </View>
                    {visits.map((v, vi) => {
                      const { val, color } = render(v)
                      return (
                        <View key={v.timestamp} style={{
                          width:            vColW,
                          height:           15,
                          justifyContent:   'center',
                          alignItems:       'center',
                          borderLeftWidth:  vi === 0 ? 0 : 0.5,
                          borderLeftColor:  C.border,
                        }}>
                          <Text style={{
                            fontSize: 8.5, fontFamily: 'Helvetica-Bold', color,
                          }}>{val}</Text>
                        </View>
                      )
                    })}
                  </View>
                ))}
              </View>

              {/* Checkpoint matrix — all sections */}
              <View style={{
                borderWidth:  1,
                borderColor:  C.border,
                borderRadius: 2,
                overflow:     'hidden',
              }}>
                {sections.map(({ section, checkpoints: cps }) => (
                  <View key={section}>

                    {/* Section header */}
                    <View style={{
                      flexDirection:     'row',
                      backgroundColor:   C.sectionBg,
                      height:            10,
                      alignItems:        'center',
                      borderBottomWidth: 0.5,
                      borderBottomColor: C.border,
                    }}>
                      <View style={{ width: CP_COL, paddingHorizontal: 5 }}>
                        <Text style={{
                          fontSize: 5.5, fontFamily: 'Helvetica-Bold',
                          color: C.muted, letterSpacing: 0.5,
                        }}>
                          {displaySection(section).toUpperCase()}
                        </Text>
                      </View>
                      {visits.map((v, vi) => (
                        <View key={v.timestamp} style={{
                          width:           vColW,
                          height:          10,
                          borderLeftWidth: vi === 0 ? 1 : 0.5,
                          borderLeftColor: C.border,
                        }} />
                      ))}
                    </View>

                    {/* Checkpoint rows */}
                    {cps.map((cp, ci) => (
                      <View
                        key={`${section}|${cp.checkpoint}`}
                        wrap={false}
                        style={{
                          flexDirection:     'row',
                          minHeight:         13,
                          backgroundColor:   C.white,
                          borderBottomWidth: 0.5,
                          borderBottomColor: ci < cps.length - 1 ? C.soft : C.border,
                        }}
                      >
                        {/* Checkpoint name */}
                        <View style={{
                          width:             CP_COL,
                          paddingHorizontal: 5,
                          paddingVertical:   2,
                          borderRightWidth:  1,
                          borderRightColor:  C.border,
                          flexDirection:     'row',
                          alignItems:        'flex-start',
                          minHeight:         13,
                        }}>
                          {cp.isCritical && (
                            <Text style={{
                              fontSize:          5,
                              fontFamily:        'Helvetica-Bold',
                              color:             C.red,
                              backgroundColor:   C.yellow,
                              borderRadius:      1,
                              paddingHorizontal: 1.5,
                              paddingVertical:   0.5,
                              marginRight:       3,
                              marginTop:         1,
                              lineHeight:        1,
                            }}>C</Text>
                          )}
                          <Text style={{ fontSize: 7, color: C.ink, flex: 1, lineHeight: 1.3 }}>
                            {cp.checkpoint}
                          </Text>
                        </View>

                        {/* Result cells */}
                        {visits.map((visit, vi) => {
                          const result = resultMx.get(visit.timestamp)?.get(cp.responseHeader) ?? null
                          return (
                            <View key={visit.timestamp} style={{
                              width:           vColW,
                              minHeight:       13,
                              justifyContent:  'center',
                              alignItems:      'center',
                              borderLeftWidth: vi === 0 ? 0 : 0.5,
                              borderLeftColor: C.border,
                            }}>
                              <View style={{
                                width:           CELL,
                                height:          CELL,
                                borderRadius:    1.5,
                                backgroundColor: cellBg(result),
                              }} />
                            </View>
                          )
                        })}
                      </View>
                    ))}

                  </View>
                ))}
              </View>
            </View>

            {/* ── Footer ── */}
            <View fixed style={{
              position:          'absolute',
              bottom:            0, left: 0, right: 0,
              backgroundColor:   C.white,
              borderTopWidth:    0.5,
              borderTopColor:    C.border,
              paddingVertical:   4,
              paddingHorizontal: PM,
              flexDirection:     'row',
              justifyContent:    'space-between',
              alignItems:        'center',
            }}>
              <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: C.red }}>
                Killer Kockpit
              </Text>
              <Text style={{ fontSize: 6, color: C.muted }}>
                KQC SSP/CPH Overview · {allVisits.length} reports · {dateRange} · Internal use only
              </Text>
            </View>

          </Page>
        )
      })}

      {/* ─── Comments / Notes ───────────────────────────────────────────────── */}
      {commentsData.length > 0 && (
        <Page size="A4" style={{
          fontFamily:      'Helvetica',
          fontSize:        9,
          color:           C.ink,
          backgroundColor: C.white,
          paddingBottom:   18,
        }}>

          {/* Fixed page header — same brand bar as matrix pages */}
          <View fixed style={{ backgroundColor: C.white }}>
            <View style={{ height: 3, backgroundColor: C.red }} />
            <View style={{
              paddingHorizontal: PM,
              paddingTop:        6,
              paddingBottom:     5,
              flexDirection:     'row',
              justifyContent:    'space-between',
              alignItems:        'flex-end',
              borderBottomWidth: 0.5,
              borderBottomColor: C.border,
            }}>
              <View>
                <Text style={{
                  fontSize: 6, fontFamily: 'Helvetica-Bold',
                  color: C.red, letterSpacing: 1.1, marginBottom: 2,
                }}>
                  KILLER KEBAB
                </Text>
                <Text style={{
                  fontSize: 13, fontFamily: 'Helvetica-Bold',
                  color: C.ink, marginBottom: 2,
                }}>
                  KQC SSP / CPH — Comments
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Text style={{ fontSize: 7.5, color: C.muted }}>SSP / CPH Airport</Text>
                  <Text style={{ fontSize: 6.5, color: C.border }}>·</Text>
                  <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: C.ink }}>{dateRange}</Text>
                  <Text style={{ fontSize: 6.5, color: C.border }}>·</Text>
                  <Text style={{ fontSize: 7.5, color: C.muted }}>
                    {allVisits.length} {allVisits.length === 1 ? 'report' : 'reports'}
                  </Text>
                </View>
              </View>
              <Text style={{ fontSize: 6.5, color: C.muted }}>Generated {genStr}</Text>
            </View>
          </View>

          {/* Comments body */}
          <View style={{ paddingHorizontal: PM, paddingTop: 10 }}>
            {commentsData.map((vc, idx) => (
              <View key={`${vc.date}-${vc.time}-${idx}`} style={{ marginBottom: 14 }}>

                {/* Visit date / time header */}
                <View wrap={false} style={{
                  backgroundColor:   C.sectionBg,
                  paddingHorizontal: 8,
                  paddingVertical:   4,
                  borderRadius:      2,
                  marginBottom:      6,
                  flexDirection:     'row',
                  alignItems:        'center',
                  gap:               6,
                }}>
                  <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: C.ink }}>
                    {fmtDateShort(vc.date)}
                  </Text>
                  {vc.time && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <Text style={{ fontSize: 7, color: C.border }}>·</Text>
                      <Text style={{ fontSize: 8, color: C.muted }}>{vc.time}</Text>
                    </View>
                  )}
                </View>

                {/* Section comments */}
                {vc.sectionComments.map((sc, sci) => (
                  <View key={`${sc.header}-${sci}`} style={{ marginBottom: 6, paddingLeft: 8 }}>
                    <Text style={{
                      fontSize:      6.5,
                      fontFamily:    'Helvetica-Bold',
                      color:         C.muted,
                      letterSpacing: 0.3,
                      marginBottom:  2,
                    }}>
                      {sc.header.toUpperCase()}
                    </Text>
                    <Text style={{ fontSize: 8, color: C.ink, lineHeight: 1.45 }}>
                      {sc.text}
                    </Text>
                  </View>
                ))}

                {/* Overall comments */}
                {vc.overallComments && (
                  <View style={{ marginBottom: 4, paddingLeft: 8 }}>
                    <Text style={{
                      fontSize:      6.5,
                      fontFamily:    'Helvetica-Bold',
                      color:         C.muted,
                      letterSpacing: 0.3,
                      marginBottom:  2,
                    }}>
                      OVERALL COMMENTS
                    </Text>
                    <Text style={{ fontSize: 8, color: C.ink, lineHeight: 1.45 }}>
                      {vc.overallComments}
                    </Text>
                  </View>
                )}

                {/* Divider between visits */}
                {idx < commentsData.length - 1 && (
                  <View style={{ height: 0.5, backgroundColor: C.border, marginTop: 8 }} />
                )}

              </View>
            ))}
          </View>

          {/* Footer */}
          <View fixed style={{
            position:          'absolute',
            bottom:            0, left: 0, right: 0,
            backgroundColor:   C.white,
            borderTopWidth:    0.5,
            borderTopColor:    C.border,
            paddingVertical:   4,
            paddingHorizontal: PM,
            flexDirection:     'row',
            justifyContent:    'space-between',
            alignItems:        'center',
          }}>
            <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: C.red }}>
              Killer Kockpit
            </Text>
            <Text style={{ fontSize: 6, color: C.muted }}>
              KQC SSP/CPH Comments · {allVisits.length} reports · {dateRange} · Internal use only
            </Text>
          </View>

        </Page>
      )}
    </Document>
  )
}
