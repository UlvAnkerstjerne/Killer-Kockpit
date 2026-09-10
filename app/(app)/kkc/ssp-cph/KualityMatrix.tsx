'use client'

/**
 * KualityMatrix.tsx
 *
 * Checkpoint × visit heatmap for the KKC SSP/CPH dashboard.
 *
 * Rows  = checkpoints grouped by section (Config tab order)
 * Cols  = visits ordered oldest → newest (newest rightmost)
 *
 * STICKY ARCHITECTURE
 * ───────────────────
 * CSS sticky top-0 inside an overflow-x:auto container fails because
 * overflow-x:auto computes overflow-y:auto (CSS spec) — both axes then
 * act as scroll containers and trap the sticky element inside.
 *
 * Solution: split the <thead> out of the scroll container entirely:
 *   • StickyHeaderBar  — a regular div above the scroll container,
 *                         sticky top-0 relative to the document body ✓
 *                         its inner div syncs scrollLeft with the body table
 *   • body scroll div  — overflow-x:auto, contains only <tbody>
 *
 * The card uses overflow:clip (not overflow:hidden) — clip does NOT
 * create a sticky scroll container (unlike hidden), so the sticky header
 * bar correctly sticks to the viewport.
 *
 * Left freeze: sticky left-0 on the checkpoint-name column in the body
 * and on the corner cell in the header bar.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { buildSubmissionDetail } from '@/lib/kkc/detail'
import type {
  KKCSspCphData,
  KKCResult,
  KKCConfigCheckpoint,
  KKCScoreRow,
} from '@/lib/kkc/ssp-cph'

// ── Constants ──────────────────────────────────────────────────────────────────

const SECTION_ORDER = [
  'Prep / Operations', 'Service / Staff',
  'Fries',
  'Kebab Wrap', 'Chicken Wrap', 'Falafel Wrap', 'Falafel Cup',
  'Lemonade',
]

// Display-name overrides for section headers (data keys stay unchanged)
const SECTION_DISPLAY: Record<string, string> = {
  'Kebab Wrap':   'Killer Kebab',
  'Chicken Wrap': 'Killer Kylling',
  'Falafel Wrap': 'Killer Falafel',
}
function displaySection(s: string): string {
  return SECTION_DISPLAY[s] ?? s
}

const CHECKPOINT_COL_W = 224  // px — frozen left column
const VISIT_COL_W      = 96   // px — each visit column

// ── Helpers ────────────────────────────────────────────────────────────────────

function scoreTextCls(n: number): string {
  return n >= 90 ? 'text-kk-good' : n >= 75 ? 'text-kk-warn' : 'text-kk-bad'
}

function cellBg(result: KKCResult | null): string {
  if (result === 'Acceptable')   return '#c8e6d0'
  if (result === 'Unacceptable') return '#f09090'  // higher contrast — jumps out when scanning
  return '#eceae4'
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function parseIsoDate(d: string): { year: string; month: number; day: number } | null {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? { year: m[1], month: parseInt(m[2], 10), day: parseInt(m[3], 10) } : null
}

function fmtDateLong(d: string): string {
  const p = parseIsoDate(d)
  if (!p) return d
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1] ?? ''} ${p.year}`
}

function formatColDate(d: string): string {
  const p = parseIsoDate(d)
  if (!p) return d
  return `${p.day} ${MONTHS[p.month - 1] ?? ''}`
}

// D/M-YYYY format (e.g. 9/9-2026)
function fmtDMY(d: string): string {
  const p = parseIsoDate(d)
  if (!p) return d
  return `${p.day}/${p.month}-${p.year}`
}

function formatHeading(visits: KKCScoreRow[]): string {
  if (visits.length === 0) return ''
  if (visits.length === 1)  return fmtDMY(visits[0].date)
  return `${fmtDMY(visits[0].date)} – ${fmtDMY(visits[visits.length - 1].date)}`
}

// ── Result matrix ──────────────────────────────────────────────────────────────

type ResultRow = Map<string, KKCResult | null>

function buildResultMatrix(data: KKCSspCphData): Map<string, ResultRow> {
  const headerIndex = new Map(data.formHeaders.map((h, i) => [h, i]))
  const matrix      = new Map<string, ResultRow>()
  for (const score of data.scores) {
    const formRow = data.formRows.find(r => r[0] === score.timestamp)
    const rowMap: ResultRow = new Map()
    for (const cp of data.config) {
      if (!formRow) {
        rowMap.set(cp.responseHeader, null)
      } else {
        const idx = headerIndex.get(cp.responseHeader)
        const raw = idx !== undefined ? (formRow[idx] ?? '').trim() : ''
        rowMap.set(
          cp.responseHeader,
          raw === 'Acceptable' ? 'Acceptable' : raw === 'Unacceptable' ? 'Unacceptable' : null,
        )
      }
    }
    matrix.set(score.timestamp, rowMap)
  }
  return matrix
}

// ── Checkpoint display order ────────────────────────────────────────────────────
// Presentation-layer only. Config order, critical flags, and source data are unchanged.

const CHECKPOINT_ORDER: Record<string, string[]> = {
  'Prep / Operations': [
    'Prep correctly dated and within date / fresh',
    'Meat weighed using scale',
    'Meat holding temperature',
    'Lid used correctly',
    'Blade properly sharp / cut straight with no mushrooming',
    'Bread baked fresh to order',
  ],
  'Service / Staff': [
    'All staff in uniform',
    'Eye contact when ordering',
    'Eye contact at pickup',
    'Verbal interaction at pickup',
  ],
  'Kebab Wrap': [
    'Meat temperature',
    'Bread temperature',
    'Bread fluffiness',
    'Bread caramelisation',
    'Meat caramelisation',
    'Meat texture / juiciness',
    'Distribution',
    'Mint yoghurt sauce',
    'Parsley',
    'Onion',
    'Dukkah',
    'Harissa',
  ],
  'Chicken Wrap': [
    'Chicken temperature',
    'Bread temperature',
    'Bread fluffiness',
    'Bread caramelisation',
    'Chicken caramelisation',
    'Chicken texture / juiciness',
    'Distribution',
    'Zhugurt',
    'Parsley',
    'Killer Cucumbers',
    'Cabbage',
    'Harissa',
  ],
  'Falafel Wrap': [
    'Falafel hot and fully cooked',
    'Bread temperature',
    'Bread fluffiness',
    'Bread caramelisation',
    'Falafel consistency',
    'Falafel size',
    'Distribution',
    'Apple',
    'Mint',
    'Truffle mayo',
    'Cabbage',
    'Harissa',
  ],
  'Falafel Cup': [
    'Falafel hot and fully cooked',
    'Falafel consistency',
    'Falafel size',
    'Quantity — 3 falafels',
    'Truffle dip',
    'Dip amount',
  ],
  'Fries': [
    'Warm',
    'Crispy',
    'Salt',
    'Dukkah present',
  ],
  'Lemonade': [
    'Available',
    'Taste',
  ],
}

function sortCheckpoints(section: string, cps: KKCConfigCheckpoint[]): KKCConfigCheckpoint[] {
  const order = CHECKPOINT_ORDER[section]
  if (!order) return cps
  const idx = new Map(order.map((name, i) => [name, i]))
  return [...cps].sort((a, b) => {
    const ai = idx.get(a.checkpoint) ?? order.length
    const bi = idx.get(b.checkpoint) ?? order.length
    return ai - bi
  })
}

// ── Section grouping ───────────────────────────────────────────────────────────

interface SectionGroup { section: string; checkpoints: KKCConfigCheckpoint[] }

function groupBySections(config: KKCConfigCheckpoint[]): SectionGroup[] {
  const sectionMap = new Map<string, KKCConfigCheckpoint[]>()
  for (const cp of config) {
    const arr = sectionMap.get(cp.section) ?? []
    arr.push(cp)
    sectionMap.set(cp.section, arr)
  }
  const result: SectionGroup[] = []
  for (const s of SECTION_ORDER) {
    if (sectionMap.has(s)) result.push({ section: s, checkpoints: sortCheckpoints(s, sectionMap.get(s)!) })
  }
  for (const [s, cps] of sectionMap) {
    if (!SECTION_ORDER.includes(s)) result.push({ section: s, checkpoints: sortCheckpoints(s, cps) })
  }
  return result
}

// ── Cell symbols ───────────────────────────────────────────────────────────────

function IconCheck() {
  return (
    <svg width="9" height="8" viewBox="0 0 9 8" fill="none" aria-hidden="true">
      <path d="M1.5 4L3.5 6L7.5 1.5" stroke="#2f6d4c" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function IconCross() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="#6e1f1f" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

// ── Cell popover ───────────────────────────────────────────────────────────────

interface CellPopoverData {
  date:           string
  time:           string
  diner:          string
  section:        string
  checkpoint:     string
  isCritical:     boolean
  result:         KKCResult | null
  sectionComment: string | null
  anchorX:        number
  anchorY:        number
}

function CellPopover({ d, onClose }: { d: CellPopoverData; onClose: () => void }) {
  const popRef = useRef<HTMLDivElement>(null)
  const POP_W  = 280
  const left   = typeof window !== 'undefined' ? Math.min(d.anchorX, window.innerWidth - POP_W - 8) : d.anchorX
  const top    = d.anchorY + 6

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const resultLabel = d.result === 'Acceptable' ? 'Acceptable'
    : d.result === 'Unacceptable' ? 'Unacceptable'
    : 'Not assessed'
  const resultCls = d.result === 'Acceptable' ? 'text-kk-good'
    : d.result === 'Unacceptable' ? 'text-kk-bad'
    : 'text-kk-muted'

  return (
    <div
      ref={popRef}
      className="bg-kk-panel border border-kk-line rounded-xl shadow-2xl p-4"
      style={{ position: 'fixed', top, left, width: POP_W, zIndex: 60 }}
    >
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-kk-muted hover:text-kk-ink transition-colors"
        aria-label="Close"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
      <div className="text-[10px] font-bold uppercase tracking-wide text-kk-muted mb-3 pr-4">
        {d.date} · {d.time}{d.diner ? ` · ${d.diner}` : ''}
      </div>
      <div className="mb-3">
        <div className="text-[9px] uppercase tracking-wide text-kk-muted mb-0.5">{d.section}</div>
        <div className="flex items-center gap-1.5 text-sm font-medium text-kk-ink leading-snug">
          {d.isCritical && (
            <span
              className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none"
              style={{ backgroundColor: '#F5DA93', color: '#AD3919' }}
            >
              C
            </span>
          )}
          {d.checkpoint}
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: cellBg(d.result) }} />
        <span className={`text-sm font-semibold ${resultCls}`}>{resultLabel}</span>
      </div>
      {d.sectionComment && (
        <div className="border-t border-kk-line pt-3">
          <div className="text-[9px] uppercase tracking-wide text-kk-muted mb-1">Comment</div>
          <p className="text-xs text-kk-ink italic leading-relaxed">&ldquo;{d.sectionComment}&rdquo;</p>
        </div>
      )}
    </div>
  )
}

// ── Summary row ────────────────────────────────────────────────────────────────

const SUMMARY_BG = '#f0ede7'

function SummaryRow({
  label, visits, render, last,
}: {
  label:   string
  visits:  KKCScoreRow[]
  render:  (v: KKCScoreRow) => React.ReactNode
  last?:   boolean
}) {
  return (
    <tr className={last ? 'border-b-2 border-kk-line' : 'border-b border-kk-line/60'}>
      <td
        className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60"
        style={{ minWidth: CHECKPOINT_COL_W, width: CHECKPOINT_COL_W, backgroundColor: SUMMARY_BG }}
      >
        {label}
      </td>
      {visits.map(visit => (
        <td
          key={visit.timestamp}
          className="text-center px-1 py-1.5"
          style={{ width: VISIT_COL_W, backgroundColor: SUMMARY_BG }}
        >
          {render(visit)}
        </td>
      ))}
    </tr>
  )
}

// ── KualityMatrix ──────────────────────────────────────────────────────────────

interface Props {
  data:         KKCSspCphData
  onVisitClick: (timestamp: string) => void
}

export default function KualityMatrix({ data, onVisitClick }: Props) {
  const [popover, setPopover] = useState<CellPopoverData | null>(null)

  // Two scroll refs: body (user-scrollable) and header (synced programmatically)
  const scrollRef       = useRef<HTMLDivElement>(null)
  const headerScrollRef = useRef<HTMLDivElement>(null)

  const visits   = data.scores
  const latestTs = visits[visits.length - 1]?.timestamp

  const resultMatrix = useMemo(() => buildResultMatrix(data), [data])
  const sections     = useMemo(() => groupBySections(data.config), [data.config])

  const tableMinWidth = CHECKPOINT_COL_W + visits.length * VISIT_COL_W

  // Sync header scrollLeft → body scrollLeft (called on body scroll)
  function syncHeader() {
    if (scrollRef.current && headerScrollRef.current) {
      headerScrollRef.current.scrollLeft = scrollRef.current.scrollLeft
    }
  }

  // Auto-scroll to newest visit on mount and sync header
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
      syncHeader()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close popover on horizontal scroll
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const close = () => setPopover(null)
    el.addEventListener('scroll', close, { passive: true })
    return () => el.removeEventListener('scroll', close)
  }, [])

  function handleCellClick(
    e: React.MouseEvent,
    visit: KKCScoreRow,
    cp: KKCConfigCheckpoint,
    result: KKCResult | null,
  ) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const detail = buildSubmissionDetail(data, visit.timestamp)
    const sectionComment = detail?.sectionComments.find(c =>
      c.header.toLowerCase().includes(cp.section.toLowerCase())
    )?.text ?? null
    setPopover({
      date: visit.date, time: visit.time, diner: visit.mysteryDiner,
      section: cp.section, checkpoint: cp.checkpoint, isCritical: cp.isCritical,
      result, sectionComment, anchorX: rect.left, anchorY: rect.bottom,
    })
  }

  // Shared colgroup — rendered in both header and body tables for pixel-perfect alignment
  const ColGroup = () => (
    <colgroup>
      <col style={{ width: CHECKPOINT_COL_W }} />
      {visits.map(v => <col key={v.timestamp} style={{ width: VISIT_COL_W }} />)}
    </colgroup>
  )

  return (
    <>
      {popover && <CellPopover d={popover} onClose={() => setPopover(null)} />}

      {/*
        Card: overflow:clip so rounded corners clip table cells, but clip does NOT
        create a sticky scroll container (unlike hidden) — the sticky header bar
        inside correctly sticks to the document body / viewport.
      */}
      <div
        className="bg-kk-panel border border-kk-line rounded-2xl"
        style={{ overflow: 'clip' }}
      >
        {/*
          STICKY HEADER BAR
          ─────────────────
          A plain div with sticky top-0 (no overflow ancestor trapped it).
          Inside: an overflow:hidden div whose scrollLeft is synced programmatically
          with the body scroll. The corner cell has sticky left-0 so it stays put
          while visit columns scroll left.
        */}
        <div className="sticky top-0 z-20 bg-kk-panel border-b-2 border-kk-line">
          <div
            ref={headerScrollRef}
            style={{ overflowX: 'hidden', overflowY: 'hidden' }}
            aria-hidden="true"
          >
            <table
              className="border-collapse"
              style={{ tableLayout: 'fixed', width: tableMinWidth, minWidth: tableMinWidth }}
            >
              <ColGroup />
              <thead>
                <tr>
                  {/* Corner — sticky left; border-r creates the column divider */}
                  <th
                    scope="col"
                    className="sticky left-0 z-30 bg-kk-panel border-r border-kk-line/60"
                    style={{ width: CHECKPOINT_COL_W }}
                  />
                  {visits.map(visit => {
                    const isLatest = visit.timestamp === latestTs
                    return (
                      <th
                        key={visit.timestamp}
                        scope="col"
                        className={[
                          'px-1.5 pb-2 pt-2 cursor-pointer transition-colors text-center align-bottom bg-kk-panel',
                          isLatest ? 'hover:bg-kk-soft' : 'hover:bg-kk-soft',
                        ].join(' ')}
                        style={{ width: VISIT_COL_W }}
                        onClick={() => onVisitClick(visit.timestamp)}
                        title={`Open full detail — ${visit.date}${visit.mysteryDiner ? ` · ${visit.mysteryDiner}` : ''}`}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          {isLatest && (
                            <span className="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 bg-kk-ink text-white rounded-full leading-none mb-0.5">
                              Latest
                            </span>
                          )}
                          <span className="text-[11px] font-semibold text-kk-ink leading-tight">
                            {formatColDate(visit.date)}
                          </span>
                          <span className="text-[9px] text-kk-muted/70 tabular-nums leading-tight">{visit.time}</span>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
            </table>
          </div>
        </div>

        {/* Legend — sits between column headers and matrix rows */}
        <div className="px-4 py-2 border-b border-kk-line flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
            <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#c8e6d0' }}>
              <IconCheck />
            </span>
            Acceptable
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
            <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#f09090' }}>
              <IconCross />
            </span>
            Unacceptable
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
            <span className="inline-block w-5 h-5 rounded border border-kk-line" style={{ backgroundColor: '#eceae4' }} />
            Not assessed
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
            <span
              className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none"
              style={{ backgroundColor: '#F5DA93', color: '#AD3919' }}
            >C</span>
            Critical
          </div>
          <span className="text-[10px] text-kk-muted ml-auto hidden sm:block">
            Click column header to view full visit detail
          </span>
        </div>

        {/*
          SCROLLABLE BODY
          ───────────────
          overflow-x:auto for horizontal scroll. No sticky elements inside —
          the header is a sibling above, not a child.
        */}
        <div
          ref={scrollRef}
          style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
          onScroll={syncHeader}
          onClick={() => setPopover(null)}
        >
          <table
            className="border-collapse"
            style={{ tableLayout: 'fixed', width: tableMinWidth, minWidth: tableMinWidth }}
            aria-label="Checkpoint quality matrix"
          >
            <ColGroup />
            <tbody>
              {/* ── Summary rows ── */}
              <SummaryRow
                label="Overall"
                visits={visits}
                render={v => (
                  <span className={`text-xs font-bold tabular-nums ${scoreTextCls(v.overallScore)}`}>
                    {v.overallScore}%
                  </span>
                )}
              />
              <SummaryRow
                label="Critical"
                visits={visits}
                render={v => (
                  <span className={`text-xs font-bold tabular-nums ${scoreTextCls(v.criticalScore)}`}>
                    {v.criticalScore}%
                  </span>
                )}
              />
              <SummaryRow
                label="Failures"
                visits={visits}
                last
                render={v => (
                  <span className={`text-xs font-bold tabular-nums ${v.criticalFailures > 0 ? 'text-kk-bad' : 'text-kk-good'}`}>
                    {v.criticalFailures}
                  </span>
                )}
              />

              {/* ── Section groups ── */}
              {sections.map(({ section, checkpoints: cps }) => (
                <React.Fragment key={section}>

                  {/* Section header row — single colSpan cell so the band is truly continuous */}
                  <tr>
                    <td
                      colSpan={1 + visits.length}
                      className="sticky left-0 z-10 px-3 py-1"
                      style={{ backgroundColor: SUMMARY_BG }}
                    >
                      <span className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-kk-muted">
                        {displaySection(section)}
                      </span>
                    </td>
                  </tr>

                  {/* Checkpoint rows */}
                  {cps.map((cp, cpIdx) => (
                    <tr
                      key={`${section}|${cp.checkpoint}`}
                      className={[
                        'group transition-colors hover:bg-kk-soft',
                        cpIdx === cps.length - 1 ? 'border-b border-kk-line' : 'border-b border-kk-line/40',
                      ].join(' ')}
                    >
                      {/* Frozen checkpoint name */}
                      <td
                        className="sticky left-0 z-10 bg-kk-panel group-hover:bg-kk-soft px-3 py-1 transition-colors overflow-hidden border-r border-kk-line/60"
                        style={{ width: CHECKPOINT_COL_W }}
                      >
                        <div className="flex items-center gap-1.5">
                          {cp.isCritical && (
                            <span
                              className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none"
                              style={{ backgroundColor: '#F5DA93', color: '#AD3919' }}
                            >
                              C
                            </span>
                          )}
                          <span className="text-xs text-kk-ink leading-snug truncate">
                            {cp.checkpoint}
                          </span>
                        </div>
                      </td>

                      {/* Result cells — fixed squares with ✓ / ✗ / blank */}
                      {visits.map(visit => {
                        const result = resultMatrix.get(visit.timestamp)?.get(cp.responseHeader) ?? null
                        return (
                          <td
                            key={visit.timestamp}
                            className="px-1 py-1 group-hover:bg-kk-soft transition-colors"
                            style={{ width: VISIT_COL_W }}
                          >
                            <button
                              type="button"
                              onClick={(e) => handleCellClick(e, visit, cp, result)}
                              className="w-6 h-6 rounded flex items-center justify-center mx-auto transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kk-ink"
                              style={{ backgroundColor: cellBg(result) }}
                              title={result ?? 'Not assessed'}
                              aria-label={`${cp.checkpoint}: ${result ?? 'Not assessed'}`}
                            >
                              {result === 'Acceptable'   && <IconCheck />}
                              {result === 'Unacceptable' && <IconCross />}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}

                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>


      </div>
    </>
  )
}
