'use client'

import React, { useState, useEffect, useRef, useMemo, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createDinerAccess, resendDinerAccessEmail, disableDiner, enableDiner } from '@/lib/actions/diner-diners'
import { fetchDinerStoreMatrix } from '@/lib/actions/diner-results'
import type { DinerMatrixCheckpoint, DinerMatrixColumn, DinerStoreMatrixResult } from '@/lib/actions/diner-results'
import { computeDinerStatus, dinerScoreColor, DINER_STATUS_CLS, DINER_STATUS_LABEL } from '@/lib/diner/scoring'
import type { DinerStatus } from '@/lib/diner/scoring'
import type { DinerRosterRow, DinerResultRow, DinerEmailStatus } from './page'

// ─── Constants ────────────────────────────────────────────────────────────────

const STORE_OVERVIEW = [
  { short: 'Borgergade',     locationId: '3dc58270-f9e0-49e2-8341-1c78be950dae' },
  { short: 'Christianshavn', locationId: 'fc7fa67f-dc59-46a1-947c-f8519b642b32' },
  { short: 'Frederiksberg',  locationId: 'ac7dd67c-cc32-4bb2-aac4-295a390ea33f' },
  { short: 'Vesterbro',      locationId: '1052d6ff-22b9-43a8-b954-588c67380f5e' },
  { short: 'Fisketorvet',    locationId: '84e5038b-acbe-48e6-b74c-dc55bed32462' },
  { short: 'Nørrebro',       locationId: '06eb4453-db78-4ee7-ab0e-51b3452b3825' },
]

const LOCATIONS = STORE_OVERVIEW.map(s => ({ id: s.locationId, name: s.short }))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' })
}
function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('da-DK', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function DinerStatusBadge({ status }: { status: DinerStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${DINER_STATUS_CLS[status]}`}>
      {DINER_STATUS_LABEL[status]}
    </span>
  )
}

// ─── Diner status badge ───────────────────────────────────────────────────────

const DINER_ACCESS_STATUS_CLS: Record<'active' | 'disabled', string> = {
  active:   'bg-kk-good-bg text-kk-good border-kk-good',
  disabled: 'bg-kk-soft text-kk-muted border-kk-line',
}

function DinerAccessBadge({ status }: { status: 'active' | 'disabled' }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${DINER_ACCESS_STATUS_CLS[status]}`}>
      {status === 'active' ? 'Active' : 'Disabled'}
    </span>
  )
}

// ─── Email status pill ────────────────────────────────────────────────────────

const EMAIL_STATUS_CLS: Record<DinerEmailStatus, string> = {
  sent:     'text-kk-good',
  failed:   'text-kk-bad',
  not_sent: 'text-kk-muted',
}
const EMAIL_STATUS_LABEL: Record<DinerEmailStatus, string> = {
  sent:     'Link sent',
  failed:   'Send failed',
  not_sent: 'Not sent',
}

function EmailStatusPill({ status }: { status: DinerEmailStatus }) {
  return (
    <span className={`text-[10px] font-medium ${EMAIL_STATUS_CLS[status]}`}>
      {EMAIL_STATUS_LABEL[status]}
    </span>
  )
}

// ─── Store card ───────────────────────────────────────────────────────────────

function StoreCard({ short, result, selected, onClick }: {
  short:    string
  result:   DinerResultRow | null
  selected: boolean
  onClick:  () => void
}) {
  const status = result
    ? (result.final_status ?? computeDinerStatus(result.score_pct, result.critical_fail_count ?? 0))
    : null

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-kk-panel rounded-xl border shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-4 py-3 transition-all cursor-pointer ${
        selected ? 'border-kk-line ring-2 ring-kk-ink' : 'border-kk-line hover:border-kk-muted'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-sm font-bold text-kk-ink leading-tight">{short}</span>
        {status && <DinerStatusBadge status={status} />}
      </div>

      {result ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold tabular-nums ${dinerScoreColor(result.score_pct)}`}>
              {result.score_pct !== null ? `${result.score_pct.toFixed(0)}%` : '—'}
            </span>
            {(result.critical_fail_count ?? 0) > 0 && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-kk-bad-bg text-kk-bad text-[10px] font-bold">
                {result.critical_fail_count}
              </span>
            )}
            {(result.gold_star_count ?? 0) > 0 && (
              <span className="text-[11px] font-semibold" style={{ color: '#AD6B1D' }}>
                {'★'.repeat(result.gold_star_count!)}
              </span>
            )}
          </div>
          <div className="text-[11px] text-kk-muted">{fmtDate(result.submitted_at)}</div>
        </div>
      ) : (
        <div className="text-[11px] text-kk-muted mt-1">No visits yet</div>
      )}
    </button>
  )
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-5 py-4 flex flex-col gap-1">
      <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">{label}</div>
      <div className="text-3xl font-black tabular-nums leading-none">{value}</div>
      {sub && <div className="text-[11px] text-kk-muted">{sub}</div>}
    </div>
  )
}

// ─── Score trend ──────────────────────────────────────────────────────────────

function DinerScoreTrend({ rows }: { rows: DinerResultRow[] }) {
  const W = 540, H = 160, PT = 10, PB = 18, LABEL_W = 34, PR = 8

  const scores = rows.map(r => r.score_pct ?? 0)
  const dataMin = Math.min(...scores)
  const dataMax = Math.max(...scores)
  const span    = dataMax - dataMin
  const padding = Math.max(5, Math.ceil(span * 0.15))
  let minV = Math.max(0,   Math.floor((dataMin - padding) / 5) * 5)
  let maxV = Math.min(100, Math.ceil( (dataMax + padding) / 5) * 5)
  if (maxV - minV < 20) {
    const center = (dataMin + dataMax) / 2
    minV = Math.max(0,   Math.floor((center - 10) / 5) * 5)
    maxV = Math.min(100, Math.ceil( (center + 10) / 5) * 5)
  }
  const range    = maxV - minV
  const gridStep = range <= 30 ? 5 : 10
  const chartL = LABEL_W, chartR = W - PR, chartT = PT, chartB = H - PB

  const xPos = (i: number) => chartL + (i / (rows.length - 1)) * (chartR - chartL)
  const yPos = (v: number) => chartB - ((v - minV) / range) * (chartB - chartT)

  const gridVals: number[] = []
  for (let v = Math.ceil(minV / gridStep) * gridStep; v <= maxV; v += gridStep) gridVals.push(v)

  const thresholds = [
    { v: 86, color: '#2f6d4c' },
    { v: 67, color: '#8a5b16' },
  ].filter(t => t.v > minV && t.v < maxV)

  const points = rows.map((r, i) => `${xPos(i).toFixed(1)},${yPos(r.score_pct ?? 0).toFixed(1)}`).join(' ')

  const dateLabelIdxs: number[] = (() => {
    const n = rows.length
    if (n <= 4) return rows.map((_, i) => i)
    const step = Math.floor((n - 1) / 3)
    return [0, step, step * 2, n - 1]
  })()

  const lastIdx = rows.length - 1

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 pt-4 pb-5">
      <div className="text-xs font-bold uppercase tracking-wide text-kk-muted mb-3">Score trend</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Diner score trend">
        {gridVals.map(v => (
          <g key={v}>
            <line x1={chartL} y1={yPos(v)} x2={chartR} y2={yPos(v)} stroke="#e0dbd3" strokeWidth="1" />
            <text x={chartL - 5} y={yPos(v) + 3.5} fontSize="8.5" fill="#9e9890" textAnchor="end">{v}</text>
          </g>
        ))}
        {thresholds.map(t => (
          <line key={t.v} x1={chartL} y1={yPos(t.v)} x2={chartR} y2={yPos(t.v)}
            stroke={t.color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
        ))}
        <polyline points={points} fill="none" stroke="#171717" strokeWidth="2.5" strokeLinejoin="round" />
        {rows.map((r, i) => (
          <circle key={r.id} cx={xPos(i)} cy={yPos(r.score_pct ?? 0)} r={i === lastIdx ? 4 : 3} fill="#171717" />
        ))}
        {dateLabelIdxs.map(i => (
          <text key={i} x={xPos(i)} y={H} fontSize="8.5" fill="#9e9890"
            textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}>
            {shortDate(rows[i].submitted_at)}
          </text>
        ))}
      </svg>
    </div>
  )
}

// ─── Checkpoint matrix ────────────────────────────────────────────────────────

const CP_COL_W   = 240
const VISIT_COL_W = 88
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const SUMMARY_BG = '#f0ede7'

function parseColDate(iso: string) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1] ?? ''}` : iso.slice(0, 10)
}

function MatrixIconCheck() {
  return <svg width="9" height="8" viewBox="0 0 9 8" fill="none" aria-hidden="true"><path d="M1.5 4L3.5 6L7.5 1.5" stroke="#2f6d4c" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
function MatrixIconCross() {
  return <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="#6e1f1f" strokeWidth="1.5" strokeLinecap="round"/></svg>
}

function scoredCellBg(result: string | null): string {
  if (result === 'pass') return '#c8e6d0'
  if (result === 'fail') return '#f09090'
  if (result === 'na')   return '#eceae4'
  return 'transparent'
}

function goldStarCellBg(result: string | null): string {
  if (result === 'pass') return '#FDF3C0'
  if (result === 'na')   return '#eceae4'
  return '#f0ede7'
}

function WaitingBandCell({ band }: { band: string | null }) {
  const cls = band === '20+'
    ? 'text-kk-bad font-bold'
    : band === '16-20'
      ? 'text-orange-500 font-semibold'
      : 'text-kk-muted'
  return (
    <div className={`text-[10px] text-center leading-none px-1 ${cls}`}>
      {band ?? '—'}
    </div>
  )
}

function DinerCheckpointMatrix({
  checkpoints,
  columns,
}: {
  checkpoints: DinerMatrixCheckpoint[]
  columns:     DinerMatrixColumn[]
}) {
  const scrollRef       = useRef<HTMLDivElement>(null)
  const headerScrollRef = useRef<HTMLDivElement>(null)

  const sections = useMemo(() => {
    const groups = new Map<string, DinerMatrixCheckpoint[]>()
    for (const cp of checkpoints) {
      const key = cp.section || '(General)'
      const arr = groups.get(key) ?? []
      arr.push(cp)
      groups.set(key, arr)
    }
    return [...groups.entries()].map(([section, cps]) => ({ section, cps }))
  }, [checkpoints])

  const tableMinWidth = CP_COL_W + columns.length * VISIT_COL_W
  const lastColId     = columns[columns.length - 1]?.submissionId

  function syncHeader() {
    if (scrollRef.current && headerScrollRef.current) {
      headerScrollRef.current.scrollLeft = scrollRef.current.scrollLeft
    }
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
      syncHeader()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length])

  const ColGroup = () => (
    <colgroup>
      <col style={{ width: CP_COL_W }} />
      {columns.map(c => <col key={c.submissionId} style={{ width: VISIT_COL_W }} />)}
    </colgroup>
  )

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl" style={{ overflow: 'clip' }}>

      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-kk-panel border-b-2 border-kk-line">
        <div ref={headerScrollRef} style={{ overflowX: 'hidden', overflowY: 'hidden' }} aria-hidden="true">
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: tableMinWidth, minWidth: tableMinWidth }}>
            <ColGroup />
            <thead>
              <tr>
                <th className="sticky left-0 z-30 bg-kk-panel border-r border-kk-line/60" style={{ width: CP_COL_W }} />
                {columns.map(col => {
                  const isLatest    = col.submissionId === lastColId
                  const dinerFirst  = col.dinerName.split(' ')[0]
                  return (
                    <th key={col.submissionId} scope="col"
                      className="px-1 pb-2 pt-2 align-bottom bg-kk-panel"
                      style={{ width: VISIT_COL_W }}>
                      <Link
                        href={`/kkc/diner/${col.submissionId}`}
                        className="flex flex-col items-center gap-0.5 hover:opacity-70 transition-opacity"
                        title={`View result — ${col.submittedAt.slice(0, 10)}`}
                      >
                        {isLatest && (
                          <span className="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 bg-kk-ink text-white rounded-full leading-none mb-0.5">
                            Latest
                          </span>
                        )}
                        <span className="text-[11px] font-semibold text-kk-ink leading-tight">
                          {parseColDate(col.submittedAt)}
                        </span>
                        <span className="text-[9px] text-kk-muted/70 leading-tight truncate max-w-full px-1">
                          {dinerFirst}
                        </span>
                      </Link>
                    </th>
                  )
                })}
              </tr>
            </thead>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-b border-kk-line flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#c8e6d0' }}><MatrixIconCheck /></span>Acceptable
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#f09090' }}><MatrixIconCross /></span>Unacceptable
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="inline-block w-5 h-5 rounded border border-kk-line" style={{ backgroundColor: '#eceae4' }} />Not assessed
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#FDF3C0' }}>
            <span className="text-[11px]" style={{ color: '#AD6B1D' }}>★</span>
          </span>Gold Star achieved
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none bg-kk-bad-bg text-kk-bad">C</span>
          Critical
        </div>
        <span className="text-[10px] text-kk-muted ml-auto hidden sm:block">Column header → full result</span>
      </div>

      {/* Matrix body */}
      <div ref={scrollRef} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties} onScroll={syncHeader}>
        <table className="border-collapse" style={{ tableLayout: 'fixed', width: tableMinWidth, minWidth: tableMinWidth }} aria-label="Mystery Diner checkpoint matrix">
          <ColGroup />
          <tbody>
            {/* Summary rows */}
            <tr className="border-b border-kk-line/60">
              <td className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60"
                style={{ minWidth: CP_COL_W, width: CP_COL_W, backgroundColor: SUMMARY_BG }}>Score</td>
              {columns.map(col => (
                <td key={col.submissionId} className="text-center px-1 py-1.5" style={{ width: VISIT_COL_W, backgroundColor: SUMMARY_BG }}>
                  <span className={`text-xs font-bold tabular-nums ${dinerScoreColor(col.score_pct)}`}>
                    {col.score_pct !== null ? `${Math.round(col.score_pct)}%` : '—'}
                  </span>
                </td>
              ))}
            </tr>
            <tr className="border-b border-kk-line/60">
              <td className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60"
                style={{ minWidth: CP_COL_W, width: CP_COL_W, backgroundColor: SUMMARY_BG }}>Criticals</td>
              {columns.map(col => (
                <td key={col.submissionId} className="text-center px-1 py-1.5" style={{ width: VISIT_COL_W, backgroundColor: SUMMARY_BG }}>
                  <span className={`text-xs font-bold tabular-nums ${(col.critical_fail_count ?? 0) > 0 ? 'text-kk-bad' : 'text-kk-muted'}`}>
                    {col.critical_fail_count ?? '—'}
                  </span>
                </td>
              ))}
            </tr>
            <tr className="border-b-2 border-kk-line">
              <td className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60"
                style={{ minWidth: CP_COL_W, width: CP_COL_W, backgroundColor: SUMMARY_BG }}>Gold Stars</td>
              {columns.map(col => (
                <td key={col.submissionId} className="text-center px-1 py-1.5" style={{ width: VISIT_COL_W, backgroundColor: SUMMARY_BG }}>
                  <span className="text-xs font-bold tabular-nums" style={{ color: (col.gold_star_count ?? 0) > 0 ? '#AD6B1D' : undefined }}>
                    {col.gold_star_count !== null ? col.gold_star_count : '—'}
                  </span>
                </td>
              ))}
            </tr>

            {/* Section groups */}
            {sections.map(({ section, cps }) => (
              <React.Fragment key={section}>
                <tr>
                  <td colSpan={1 + columns.length} className="sticky left-0 z-10 px-3 py-1" style={{ backgroundColor: SUMMARY_BG }}>
                    <span className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-kk-muted">{section}</span>
                  </td>
                </tr>
                {cps.map((cp, cpIdx) => (
                  <tr key={cp.id}
                    className={[
                      'group transition-colors hover:bg-kk-soft',
                      cpIdx === cps.length - 1 ? 'border-b border-kk-line' : 'border-b border-kk-line/40',
                    ].join(' ')}
                  >
                    {/* Frozen checkpoint label */}
                    <td className="sticky left-0 z-10 bg-kk-panel group-hover:bg-kk-soft px-3 py-1 transition-colors border-r border-kk-line/60" style={{ width: CP_COL_W }}>
                      <div className="flex items-center gap-1.5">
                        {cp.is_critical && (
                          <span className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[8px] font-bold leading-none bg-kk-bad-bg text-kk-bad">C</span>
                        )}
                        {cp.type === 'gold_star' && (
                          <span className="shrink-0 text-[12px]" style={{ color: '#AD6B1D' }}>★</span>
                        )}
                        <span className="text-xs text-kk-ink leading-snug truncate">
                          {cp.label}
                          {cp.is_conditional && <span className="text-kk-muted"> *</span>}
                        </span>
                      </div>
                    </td>

                    {/* Result cells */}
                    {columns.map(col => {
                      const resp = col.responses[cp.id] ?? null

                      if (cp.type === 'waiting_time') {
                        return (
                          <td key={col.submissionId} className="px-1 py-2 group-hover:bg-kk-soft transition-colors" style={{ width: VISIT_COL_W }}>
                            <WaitingBandCell band={resp?.notes ?? null} />
                          </td>
                        )
                      }

                      if (cp.type === 'gold_star') {
                        const bg = goldStarCellBg(resp?.result ?? null)
                        return (
                          <td key={col.submissionId} className="px-1 py-1 group-hover:bg-kk-soft transition-colors" style={{ width: VISIT_COL_W }}>
                            <Link href={`/kkc/diner/${col.submissionId}`}
                              className="w-6 h-6 rounded flex items-center justify-center mx-auto hover:opacity-70 transition-opacity"
                              style={{ backgroundColor: bg }}
                              aria-label={`${cp.label}: ${resp?.result ?? 'no response'}`}>
                              {resp?.result === 'pass' && <span className="text-[12px]" style={{ color: '#AD6B1D' }}>★</span>}
                            </Link>
                          </td>
                        )
                      }

                      // scored
                      const bg = scoredCellBg(resp?.result ?? null)
                      return (
                        <td key={col.submissionId} className="px-1 py-1 group-hover:bg-kk-soft transition-colors" style={{ width: VISIT_COL_W }}>
                          <Link href={`/kkc/diner/${col.submissionId}`}
                            className="w-6 h-6 rounded flex items-center justify-center mx-auto hover:opacity-70 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kk-ink"
                            style={{ backgroundColor: bg }}
                            aria-label={`${cp.label}: ${resp?.result ?? 'no response'}`}>
                            {resp?.result === 'pass' && <MatrixIconCheck />}
                            {resp?.result === 'fail' && <MatrixIconCross />}
                          </Link>
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
  )
}

// ─── History table ────────────────────────────────────────────────────────────

function HistoryTable({ rows }: { rows: DinerResultRow[] }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
      <div className="hidden md:grid grid-cols-[1fr_auto_auto_auto_auto_auto_40px] gap-4 px-4 py-2.5 border-b border-kk-line text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
        <span>Diner</span>
        <span>Date</span>
        <span>Score</span>
        <span>Status</span>
        <span className="text-center">Criticals</span>
        <span className="text-center">Stars</span>
        <span />
      </div>
      <div className="divide-y divide-kk-line">
        {rows.map(r => {
          const status = r.final_status ?? computeDinerStatus(r.score_pct, r.critical_fail_count ?? 0)
          return (
            <div key={r.id} className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto_auto_auto_40px] gap-x-4 gap-y-1 px-4 py-3 items-center hover:bg-kk-soft transition-colors">
              <div className="text-sm font-medium text-kk-ink">{r.diner_name}</div>
              <div className="text-sm text-kk-muted whitespace-nowrap">{fmtDate(r.submitted_at)}</div>
              <div className={`text-sm font-bold tabular-nums ${dinerScoreColor(r.score_pct)}`}>
                {r.score_pct !== null ? `${r.score_pct.toFixed(0)}%` : '—'}
              </div>
              <div>{status ? <DinerStatusBadge status={status} /> : <span className="text-xs text-kk-muted">—</span>}</div>
              <div className="flex justify-center">
                {(r.critical_fail_count ?? 0) > 0
                  ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-kk-bad-bg text-kk-bad text-[11px] font-bold">{r.critical_fail_count}</span>
                  : <span className="text-xs text-kk-muted">0</span>}
              </div>
              <div className="text-center text-sm font-semibold" style={{ color: (r.gold_star_count ?? 0) > 0 ? '#AD6B1D' : undefined }}>
                {r.gold_star_count !== null ? r.gold_star_count : '—'}
              </div>
              <div className="flex justify-end">
                <Link href={`/kkc/diner/${r.id}`} className="text-xs text-kk-muted hover:text-kk-ink transition-colors">View →</Link>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Add Mystery Diner modal ──────────────────────────────────────────────────

function AddDinerModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [isPending, startTransition] = useTransition()
  const [name,  setName]  = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done,  setDone]  = useState<{ emailStatus: 'sent' | 'failed'; emailError?: string } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await createDinerAccess({ name: name.trim(), email: email.trim() })
      if (result.error) { setError(result.error); return }
      setDone({ emailStatus: result.data!.emailStatus, emailError: result.data!.emailError })
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(23,23,23,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (!done && e.target === e.currentTarget) onClose() }}>
      <div className="bg-kk-panel border border-kk-line rounded-2xl shadow-2xl w-full max-w-md"
        role="dialog" aria-modal="true" aria-labelledby="add-diner-title">
        <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
          <h2 id="add-diner-title" className="text-base font-bold text-kk-ink">Add Mystery Diner</h2>
          <button onClick={onClose} className="p-1.5 text-kk-muted hover:text-kk-ink transition-colors rounded-lg" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {done ? (
          <div className="px-5 py-5 space-y-4">
            <div className={`border rounded-xl px-4 py-3 ${done.emailStatus === 'sent' ? 'bg-kk-good-bg border-kk-good' : 'bg-kk-warn-bg border-kk-warn'}`}>
              <p className={`text-xs font-semibold mb-1 ${done.emailStatus === 'sent' ? 'text-kk-good' : 'text-kk-warn'}`}>
                {done.emailStatus === 'sent' ? 'Diner added — access link sent' : 'Diner added — email delivery failed'}
              </p>
              <p className="text-xs text-kk-muted">
                {done.emailStatus === 'sent'
                  ? 'The diner will receive a personal link to start visits. You can resend it from the roster at any time.'
                  : `Email error: ${done.emailError ?? 'unknown'}. Use the Resend link action in the roster.`}
              </p>
            </div>
            <button onClick={() => { onCreated(); onClose() }}
              className="w-full py-2.5 text-sm bg-kk-ink text-white font-semibold rounded-xl hover:opacity-80 transition-opacity">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
            <div>
              <label htmlFor="add-dn-name" className="block text-xs font-semibold text-kk-ink mb-1.5">
                Full name <span className="text-kk-bad">*</span>
              </label>
              <input id="add-dn-name" type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Full name" maxLength={100} disabled={isPending} required autoFocus
                className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink placeholder:text-kk-muted disabled:opacity-50" />
            </div>
            <div>
              <label htmlFor="add-dn-email" className="block text-xs font-semibold text-kk-ink mb-1.5">
                Email <span className="text-kk-bad">*</span>
              </label>
              <input id="add-dn-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="diner@example.com" maxLength={200} disabled={isPending} required
                className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink placeholder:text-kk-muted disabled:opacity-50" />
            </div>
            {error && <p className="text-xs text-kk-bad">{error}</p>}
            <p className="text-xs text-kk-muted">An access link will be emailed immediately. The diner can use the same link for every future visit.</p>
            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose} disabled={isPending}
                className="flex-1 py-2.5 text-sm border border-kk-line rounded-xl text-kk-muted hover:text-kk-ink hover:border-kk-ink transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button type="submit" disabled={isPending || !name.trim() || !email.trim()}
                className="flex-1 py-2.5 text-sm bg-kk-ink text-white font-semibold rounded-xl disabled:opacity-40 hover:opacity-80 transition-opacity">
                {isPending ? 'Adding…' : 'Add diner'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Disable / Enable confirmation modal ──────────────────────────────────────

function ToggleDinerModal({ diner, onClose, onDone }: {
  diner:   DinerRosterRow
  onClose: () => void
  onDone:  () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError]            = useState<string | null>(null)
  const disabling                    = diner.status === 'active'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleToggle() {
    startTransition(async () => {
      const result = disabling ? await disableDiner(diner.id) : await enableDiner(diner.id)
      if (result.error) { setError(result.error); return }
      onDone(); onClose()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(23,23,23,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-kk-panel border border-kk-line rounded-2xl shadow-2xl w-full max-w-sm"
        role="dialog" aria-modal="true" aria-labelledby="toggle-diner-title">
        <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
          <h2 id="toggle-diner-title" className="text-base font-bold text-kk-ink">
            {disabling ? 'Disable diner' : 'Re-enable diner'}
          </h2>
          <button onClick={onClose} className="p-1.5 text-kk-muted hover:text-kk-ink transition-colors rounded-lg" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-kk-ink">
            {disabling
              ? <>Disable access for <strong>{diner.name}</strong>? Their link will immediately stop working.</>
              : <>Re-enable access for <strong>{diner.name}</strong>? Their existing link will work again.</>}
          </p>
          {error && <p className="text-xs text-kk-bad">{error}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={onClose} disabled={isPending}
              className="flex-1 py-2.5 text-sm border border-kk-line rounded-xl text-kk-muted hover:text-kk-ink hover:border-kk-ink transition-colors disabled:opacity-40">
              Cancel
            </button>
            <button type="button" onClick={handleToggle} disabled={isPending}
              className={`flex-1 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-40 hover:opacity-80 transition-opacity text-white ${disabling ? 'bg-kk-bad' : 'bg-kk-good'}`}>
              {isPending
                ? (disabling ? 'Disabling…' : 'Enabling…')
                : (disabling ? 'Disable' : 'Re-enable')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  roster:  DinerRosterRow[]
  results: DinerResultRow[]
}

export default function DinerLanding({ roster, results }: Props) {
  const router = useRouter()
  const [tab, setTab]                             = useState<'results' | 'diners'>('results')
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null)
  const [matrixData, setMatrixData]               = useState<DinerStoreMatrixResult | null>(null)
  const [matrixLoading, setMatrixLoading]         = useState(false)
  const [showAdd, setShowAdd]                     = useState(false)
  const [toggleTarget, setToggleTarget]           = useState<DinerRosterRow | null>(null)
  const [resendingId, setResendingId]             = useState<string | null>(null)
  const [resendErrors, setResendErrors]           = useState<Record<string, string>>({})

  // Latest submitted result per location
  const latestByLocation = useMemo(() => {
    const map = new Map<string, DinerResultRow>()
    for (const r of results) {
      if (!r.location_id) continue
      const existing = map.get(r.location_id)
      if (!existing || r.submitted_at > existing.submitted_at) map.set(r.location_id, r)
    }
    return map
  }, [results])

  // Load matrix when store selected
  useEffect(() => {
    if (!selectedLocationId) { setMatrixData(null); return }
    setMatrixLoading(true)
    fetchDinerStoreMatrix(selectedLocationId).then(data => {
      setMatrixData(data)
      setMatrixLoading(false)
    })
  }, [selectedLocationId])

  const selectedStore  = selectedLocationId ? STORE_OVERVIEW.find(s => s.locationId === selectedLocationId) ?? null : null
  const latestResult   = selectedLocationId ? latestByLocation.get(selectedLocationId) ?? null : null
  const latestStatus   = latestResult ? (latestResult.final_status ?? computeDinerStatus(latestResult.score_pct, latestResult.critical_fail_count ?? 0)) : null

  // Store results sorted chronologically (for trend)
  const storeResultsChronological = useMemo(() =>
    selectedLocationId
      ? results.filter(r => r.location_id === selectedLocationId).slice().sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
      : [],
    [results, selectedLocationId]
  )

  // Store results newest-first (for history table)
  const storeResultsNewest = useMemo(() =>
    selectedLocationId
      ? results.filter(r => r.location_id === selectedLocationId)
      : [],
    [results, selectedLocationId]
  )

  function refresh() { router.refresh() }

  async function handleResendLink(diner: DinerRosterRow) {
    setResendingId(diner.id)
    setResendErrors(prev => { const next = { ...prev }; delete next[diner.id]; return next })
    const result = await resendDinerAccessEmail(diner.id)
    setResendingId(null)
    if (result.error) {
      setResendErrors(prev => ({ ...prev, [diner.id]: result.error! }))
    } else {
      refresh()
    }
  }

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-6">
      {/* Page header + tabs */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-kk-ink">Mystery Diner</h1>
          <div className="mt-3 flex gap-1 p-1 bg-kk-soft rounded-xl w-fit">
            <button onClick={() => setTab('results')}
              className={`px-4 py-1.5 text-sm font-semibold rounded-lg transition-colors ${tab === 'results' ? 'bg-white text-kk-ink shadow-sm' : 'text-kk-muted hover:text-kk-ink'}`}>
              Results
            </button>
            <button onClick={() => setTab('diners')}
              className={`px-4 py-1.5 text-sm font-semibold rounded-lg transition-colors ${tab === 'diners' ? 'bg-white text-kk-ink shadow-sm' : 'text-kk-muted hover:text-kk-ink'}`}>
              Mystery Diners
            </button>
          </div>
        </div>
        {tab === 'diners' && (
          <button onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-kk-ink text-white text-sm font-semibold rounded-xl hover:opacity-80 transition-opacity">
            Add Mystery Diner
          </button>
        )}
      </div>

      {/* ── Results tab ── */}
      {tab === 'results' && (
        <div className="space-y-5">
          {/* Store cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {STORE_OVERVIEW.map(({ short, locationId }) => (
              <StoreCard
                key={locationId}
                short={short}
                result={latestByLocation.get(locationId) ?? null}
                selected={selectedLocationId === locationId}
                onClick={() => setSelectedLocationId(id => id === locationId ? null : locationId)}
              />
            ))}
          </div>

          {/* Store detail */}
          {selectedStore && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-base font-bold text-kk-ink">{selectedStore.short}</h2>
                {latestStatus && <DinerStatusBadge status={latestStatus} />}
                {latestResult?.submitted_at && (
                  <span className="text-[11px] text-kk-muted">Latest: {fmtDate(latestResult.submitted_at)}</span>
                )}
                {storeResultsChronological.length === 1 && (
                  <span className="text-[11px] text-kk-muted italic">· More visits needed for trend</span>
                )}
              </div>

              {latestResult ? (
                <>
                  {/* KPI cards */}
                  <div className="grid grid-cols-3 gap-3">
                    <KpiCard
                      label="Score"
                      value={<span className={dinerScoreColor(latestResult.score_pct)}>
                        {latestResult.score_pct !== null ? `${latestResult.score_pct.toFixed(0)}%` : '—'}
                      </span>}
                      sub="Assessed checkpoints"
                    />
                    <KpiCard
                      label="Critical failures"
                      value={<span className={(latestResult.critical_fail_count ?? 0) > 0 ? 'text-kk-bad' : 'text-kk-good'}>
                        {latestResult.critical_fail_count ?? '—'}
                      </span>}
                      sub={latestResult.waiting_time_band === '20+' ? 'Incl. wait time' : undefined}
                    />
                    <KpiCard
                      label="Gold Stars"
                      value={<span style={{ color: (latestResult.gold_star_count ?? 0) > 0 ? '#AD6B1D' : undefined }}>
                        {latestResult.gold_star_count !== null ? latestResult.gold_star_count : '—'}
                      </span>}
                      sub="of 3 achieved"
                    />
                  </div>

                  {/* Trend */}
                  {storeResultsChronological.length >= 2 && (
                    <DinerScoreTrend rows={storeResultsChronological} />
                  )}

                  {/* Matrix */}
                  {matrixLoading && (
                    <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-8 text-center">
                      <p className="text-sm text-kk-muted">Loading checkpoint matrix…</p>
                    </div>
                  )}
                  {!matrixLoading && matrixData && matrixData.ok && (
                    <>
                      {!matrixData.consistent && matrixData.inconsistencyNote && (
                        <div className="px-4 py-2 bg-kk-warn-bg border border-kk-warn rounded-lg text-xs text-kk-warn">
                          {matrixData.inconsistencyNote}
                        </div>
                      )}
                      {matrixData.columns.length > 0 && (
                        <DinerCheckpointMatrix checkpoints={matrixData.checkpoints} columns={matrixData.columns} />
                      )}
                    </>
                  )}
                  {!matrixLoading && matrixData && !matrixData.ok && (
                    <p className="text-xs text-kk-bad px-1">Matrix load failed: {matrixData.error}</p>
                  )}

                  {/* History */}
                  {storeResultsNewest.length > 0 && (
                    <HistoryTable rows={storeResultsNewest} />
                  )}
                </>
              ) : (
                <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-6 py-10 text-center">
                  <div className="text-sm font-semibold text-kk-ink mb-1">No submitted visits for {selectedStore.short}</div>
                  <div className="text-sm text-kk-muted">Create an invitation to get started.</div>
                </div>
              )}
            </div>
          )}

          {/* All-store history when no store selected */}
          {!selectedStore && results.length > 0 && (
            <HistoryTable rows={results.slice(0, 50)} />
          )}
          {!selectedStore && results.length === 0 && (
            <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-6 py-14 text-center">
              <div className="text-sm font-semibold text-kk-ink mb-1">No submitted results yet</div>
              <div className="text-sm text-kk-muted">
                Switch to the Mystery Diners tab to add a diner.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Mystery Diners tab ── */}
      {tab === 'diners' && (
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
          {roster.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm font-semibold text-kk-ink mb-1">No Mystery Diners yet</p>
              <p className="text-sm text-kk-muted">Add one to generate a reusable personal access link.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-kk-line">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Diner</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Visits</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Last visit</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Added</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-kk-line">
                  {roster.map(diner => (
                    <tr key={diner.id} className="hover:bg-kk-soft transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-kk-ink">{diner.name}</div>
                        <div className="text-xs text-kk-muted mt-0.5">{diner.email}</div>
                        <div className="mt-1 flex items-center gap-2">
                          <EmailStatusPill status={diner.email_status} />
                          {diner.email_status === 'failed' && diner.can_resend && (
                            resendErrors[diner.id]
                              ? <span className="text-[10px] text-kk-bad">{resendErrors[diner.id]}</span>
                              : (
                                <button
                                  disabled={resendingId === diner.id}
                                  onClick={() => handleResendLink(diner)}
                                  className="text-[10px] font-medium text-kk-muted underline hover:text-kk-ink transition-colors disabled:opacity-40">
                                  {resendingId === diner.id ? 'Sending…' : 'Retry'}
                                </button>
                              )
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3"><DinerAccessBadge status={diner.status} /></td>
                      <td className="px-4 py-3 font-semibold tabular-nums text-kk-ink">
                        {diner.visit_count > 0 ? diner.visit_count : <span className="text-kk-muted font-normal">0</span>}
                      </td>
                      <td className="px-4 py-3 text-kk-muted whitespace-nowrap">
                        {diner.last_visit_at ? fmtDate(diner.last_visit_at) : <span className="text-kk-line">—</span>}
                      </td>
                      <td className="px-4 py-3 text-kk-muted whitespace-nowrap">{fmtDate(diner.created_at)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-3">
                          {diner.can_resend && diner.status === 'active' && (
                            <button
                              disabled={resendingId === diner.id}
                              onClick={() => handleResendLink(diner)}
                              className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-40">
                              {resendingId === diner.id ? 'Sending…' : 'Resend link'}
                            </button>
                          )}
                          <button
                            onClick={() => setToggleTarget(diner)}
                            className={`text-xs transition-colors ${diner.status === 'active' ? 'text-kk-muted hover:text-kk-bad' : 'text-kk-muted hover:text-kk-good'}`}>
                            {diner.status === 'active' ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showAdd && (
        <AddDinerModal onClose={() => setShowAdd(false)} onCreated={refresh} />
      )}
      {toggleTarget && (
        <ToggleDinerModal
          diner={toggleTarget}
          onClose={() => setToggleTarget(null)}
          onDone={refresh}
        />
      )}
    </div>
  )
}
