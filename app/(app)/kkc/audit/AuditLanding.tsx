'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import Link from 'next/link'
import type { AuditSubmissionRow, AuditHealthStatus, ActiveLocation } from '@/lib/audit/submissions'
import type { MatrixCheckpoint, MatrixColumn, StoreAuditMatrixResult } from '@/lib/actions/audit'
import { fetchStoreAuditMatrix } from '@/lib/actions/audit'
import StartAuditModal from './StartAuditModal'

// ── Status helpers ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<AuditHealthStatus, string> = {
  GREEN:       'Green',
  LIGHT_GREEN: 'Light Green',
  YELLOW:      'Yellow',
  ORANGE:      'Orange',
  RED:         'Red',
}

const STATUS_CLS: Record<AuditHealthStatus, string> = {
  GREEN:       'bg-kk-good-bg text-kk-good border-kk-good',
  LIGHT_GREEN: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  YELLOW:      'bg-kk-warn-bg text-kk-warn border-kk-warn',
  ORANGE:      'bg-orange-50 text-orange-600 border-orange-300',
  RED:         'bg-kk-bad-bg text-kk-bad border-kk-bad',
}

function HealthBadge({ status }: { status: AuditHealthStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_CLS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

// ── Store overview ─────────────────────────────────────────────────────────────

const STORE_OVERVIEW: { short: string; locationId: string }[] = [
  { short: 'Borgergade',     locationId: '3dc58270-f9e0-49e2-8341-1c78be950dae' },
  { short: 'Christianshavn', locationId: 'fc7fa67f-dc59-46a1-947c-f8519b642b32' },
  { short: 'Frederiksberg',  locationId: 'ac7dd67c-cc32-4bb2-aac4-295a390ea33f' },
  { short: 'Vesterbro',      locationId: '1052d6ff-22b9-43a8-b954-588c67380f5e' },
  { short: 'Fisketorvet',    locationId: '84e5038b-acbe-48e6-b74c-dc55bed32462' },
  { short: 'Nørrebro',       locationId: '06eb4453-db78-4ee7-ab0e-51b3452b3825' },
]

interface StoreCardProps {
  short: string
  submission: AuditSubmissionRow | null
  selected: boolean
  onClick: () => void
}

function StoreCard({ short, submission, selected, onClick }: StoreCardProps) {
  const borderCls = selected
    ? 'border border-kk-line ring-2 ring-kk-ink'
    : 'border border-kk-line hover:border-kk-muted'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-kk-panel rounded-xl border shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-4 py-3 transition-all cursor-pointer ${borderCls}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-sm font-bold text-kk-ink leading-tight">{short}</span>
        {submission?.audit_status ? (
          <HealthBadge status={submission.audit_status} />
        ) : submission ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-kk-soft text-kk-muted border border-kk-line">
            In progress
          </span>
        ) : null}
      </div>

      {submission ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-kk-muted w-12 shrink-0">Overall</span>
            <ScorePill value={submission.score_pct} label="Overall Score" />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-kk-muted w-12 shrink-0">Core</span>
            <ScorePill value={submission.core_score_pct} label="Core Score" />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-kk-muted w-12 shrink-0">Red flags</span>
            {submission.red_flag_count === null ? (
              <span className="text-xs text-kk-muted">—</span>
            ) : submission.red_flag_count === 0 ? (
              <span className="text-xs text-kk-muted">0</span>
            ) : (
              <span className="inline-flex items-center justify-center w-4.5 h-4.5 rounded-full bg-kk-bad-bg text-kk-bad text-[11px] font-bold leading-none px-1">
                {submission.red_flag_count}
              </span>
            )}
          </div>
          <div className="pt-0.5 text-[11px] text-kk-muted">
            {formatDate(submission.submitted_at ?? submission.created_at)}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-kk-muted mt-1">No audit yet</div>
      )}
    </button>
  )
}

function ScorePill({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="text-xs text-kk-muted">—</span>
  const cls = value >= 90 ? 'text-kk-good' : value >= 80 ? 'text-emerald-600' : value >= 70 ? 'text-kk-warn' : value >= 60 ? 'text-orange-500' : 'text-kk-bad'
  return (
    <span title={label} className={`text-sm font-bold tabular-nums ${cls}`}>
      {value.toFixed(0)}%
    </span>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  submissions: AuditSubmissionRow[]
  locations: ActiveLocation[]
}

// ── Score trend (audit) ────────────────────────────────────────────────────────

function auditYRange(rows: AuditSubmissionRow[]): { min: number; max: number; gridStep: number } {
  const vals = rows.flatMap(r => [r.score_pct ?? 0, r.core_score_pct ?? 0])
  const dataMin  = Math.min(...vals)
  const dataMax  = Math.max(...vals)
  const dataSpan = dataMax - dataMin
  const padding  = Math.max(5, Math.ceil(dataSpan * 0.15))
  let min = Math.max(0,   Math.floor((dataMin - padding) / 5) * 5)
  let max = Math.min(100, Math.ceil( (dataMax + padding) / 5) * 5)
  if (max - min < 20) {
    const center = (dataMin + dataMax) / 2
    min = Math.max(0,   Math.floor((center - 10) / 5) * 5)
    max = Math.min(100, Math.ceil( (center + 10) / 5) * 5)
  }
  const range = max - min
  return { min, max, gridStep: range <= 30 ? 5 : 10 }
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function AuditScoreTrend({ rows }: { rows: AuditSubmissionRow[] }) {
  // rows must be ≥2 submitted audits in chronological order
  const W       = 540
  const H       = 160
  const PT      = 10
  const PB      = 18
  const LABEL_W = 34
  const PR      = 8

  const { min: minV, max: maxV, gridStep } = auditYRange(rows)
  const range  = maxV - minV
  const chartL = LABEL_W
  const chartR = W - PR
  const chartT = PT
  const chartB = H - PB

  function xPos(i: number) {
    return chartL + (i / (rows.length - 1)) * (chartR - chartL)
  }
  function yPos(v: number) {
    return chartB - ((v - minV) / range) * (chartB - chartT)
  }

  const gridVals: number[] = []
  for (let v = Math.ceil(minV / gridStep) * gridStep; v <= maxV; v += gridStep) {
    gridVals.push(v)
  }

  const thresholds = [
    { v: 90, color: '#2f6d4c' },
    { v: 75, color: '#8a5b16' },
  ].filter(t => t.v > minV && t.v < maxV)

  function polyline(vals: (number | null)[]) {
    return vals.map((v, i) => `${xPos(i).toFixed(1)},${yPos(v ?? 0).toFixed(1)}`).join(' ')
  }

  const dateLabelIdxs: number[] = (() => {
    const n = rows.length
    if (n <= 4) return rows.map((_, i) => i)
    const step = Math.floor((n - 1) / 3)
    return [0, step, step * 2, n - 1]
  })()

  const lastIdx = rows.length - 1

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 pt-4 pb-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-bold uppercase tracking-wide text-kk-muted">Score trend</div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[10px] text-kk-ink font-medium">
            <svg width="16" height="4" viewBox="0 0 16 4">
              <line x1="0" y1="2" x2="16" y2="2" stroke="#171717" strokeWidth="2.5"/>
            </svg>
            Overall
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-kk-bad font-medium">
            <svg width="16" height="4" viewBox="0 0 16 4">
              <line x1="0" y1="2" x2="16" y2="2" stroke="#8d3737" strokeWidth="1.5" strokeDasharray="4 2"/>
            </svg>
            Core
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Audit score trend">
        {gridVals.map(v => (
          <g key={v}>
            <line x1={chartL} y1={yPos(v)} x2={chartR} y2={yPos(v)} stroke="#e0dbd3" strokeWidth="1" />
            <text x={chartL - 5} y={yPos(v) + 3.5} fontSize="8.5" fill="#9e9890" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {thresholds.map(t => (
          <line
            key={t.v}
            x1={chartL} y1={yPos(t.v)} x2={chartR} y2={yPos(t.v)}
            stroke={t.color} strokeWidth="1" strokeDasharray="3 3" opacity="0.5"
          />
        ))}
        <polyline
          points={polyline(rows.map(r => r.core_score_pct))}
          fill="none" stroke="#8d3737" strokeWidth="1.5"
          strokeDasharray="4 2" strokeLinejoin="round"
        />
        <polyline
          points={polyline(rows.map(r => r.score_pct))}
          fill="none" stroke="#171717" strokeWidth="2.5" strokeLinejoin="round"
        />
        {rows.map((r, i) => (
          <g key={r.id}>
            <circle cx={xPos(i)} cy={yPos(r.score_pct ?? 0)}      r={i === lastIdx ? 4 : 3} fill="#171717" />
            <circle cx={xPos(i)} cy={yPos(r.core_score_pct ?? 0)} r={i === lastIdx ? 4 : 3} fill="#8d3737" />
          </g>
        ))}
        {dateLabelIdxs.map(i => (
          <text
            key={i}
            x={xPos(i)} y={H}
            fontSize="8.5" fill="#9e9890"
            textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}
          >
            {shortDate(rows[i].submitted_at!)}
          </text>
        ))}
      </svg>
    </div>
  )
}

// ── Store KPI panel ────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-5 py-4 flex flex-col gap-1">
      <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">{label}</div>
      <div className="text-3xl font-black tabular-nums leading-none">{value}</div>
      {sub && <div className="text-[11px] text-kk-muted">{sub}</div>}
    </div>
  )
}

function scoreColor(v: number | null) {
  if (v === null) return 'text-kk-muted'
  return v >= 90 ? 'text-kk-good' : v >= 80 ? 'text-emerald-600' : v >= 70 ? 'text-kk-warn' : v >= 60 ? 'text-orange-500' : 'text-kk-bad'
}

// ── Audit history table (shared) ───────────────────────────────────────────────

function AuditTable({ rows, showLocation }: { rows: AuditSubmissionRow[]; showLocation: boolean }) {
  const cols = showLocation
    ? 'grid-cols-[1fr_1fr_1fr_auto_auto_auto_auto]'
    : 'grid-cols-[1fr_1fr_auto_auto_auto_auto]'
  const hCols = showLocation
    ? 'grid-cols-[1fr_1fr_1fr_auto_auto_auto_auto]'
    : 'grid-cols-[1fr_1fr_auto_auto_auto_auto]'

  return (
    <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
      <div className={`hidden md:grid ${hCols} gap-4 px-4 py-2.5 border-b border-kk-line text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted`}>
        {showLocation && <span>Location</span>}
        <span>Auditor</span>
        <span>Date</span>
        <span>Overall</span>
        <span>Core</span>
        <span className="text-center">RF</span>
        <span>Status</span>
      </div>
      <div className="divide-y divide-kk-line">
        {rows.map(s => (
          <div
            key={s.id}
            className={`grid grid-cols-1 md:${cols} gap-x-4 gap-y-1 px-4 py-3 items-center hover:bg-kk-soft transition-colors`}
          >
            {showLocation && (
              <div className="font-semibold text-sm text-kk-ink truncate">{s.location_name}</div>
            )}
            <div className="text-sm text-kk-muted truncate">{s.auditor_name}</div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-kk-muted">
                {formatDate(s.submitted_at ?? s.created_at)}
              </span>
              {s.status === 'in_progress' && (
                <span className="md:hidden inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-kk-soft text-kk-muted border border-kk-line">
                  In progress
                </span>
              )}
            </div>
            <div className="flex items-center justify-end md:justify-start">
              <ScorePill value={s.score_pct} label="Overall Score" />
            </div>
            <div className="flex items-center justify-end md:justify-start">
              <ScorePill value={s.core_score_pct} label="Core Score" />
            </div>
            <div className="flex items-center justify-end md:justify-center">
              {s.red_flag_count === null ? (
                <span className="text-xs text-kk-muted">—</span>
              ) : s.red_flag_count === 0 ? (
                <span className="text-xs text-kk-muted">0</span>
              ) : (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-kk-bad-bg text-kk-bad text-[11px] font-bold">
                  {s.red_flag_count}
                </span>
              )}
            </div>
            <div className="flex items-center">
              {s.status === 'in_progress' ? (
                <span className="hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-kk-soft text-kk-muted border border-kk-line">
                  In progress
                </span>
              ) : s.audit_status ? (
                <HealthBadge status={s.audit_status} />
              ) : (
                <span className="text-xs text-kk-muted">—</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Checkpoint matrix ──────────────────────────────────────────────────────────

const CP_COL_W  = 240  // frozen checkpoint name column (px)
const AUDIT_COL_W = 88  // each audit column (px)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function parseColDate(iso: string) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1] ?? ''}` : iso.slice(0, 10)
}

function cellBg(result: 'pass' | 'fail' | 'na' | null | undefined): string {
  if (result === 'pass') return '#c8e6d0'
  if (result === 'fail') return '#f09090'
  if (result === 'na')   return '#eceae4'
  return 'transparent'
}

function MatrixIconCheck() {
  return (
    <svg width="9" height="8" viewBox="0 0 9 8" fill="none" aria-hidden="true">
      <path d="M1.5 4L3.5 6L7.5 1.5" stroke="#2f6d4c" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function MatrixIconCross() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="#6e1f1f" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function AuditCheckpointMatrix({ checkpoints, columns }: { checkpoints: MatrixCheckpoint[]; columns: MatrixColumn[] }) {
  const scrollRef       = useRef<HTMLDivElement>(null)
  const headerScrollRef = useRef<HTMLDivElement>(null)

  // Group checkpoints by section in sort_order
  const sections = useMemo(() => {
    const groups = new Map<string, MatrixCheckpoint[]>()
    for (const cp of checkpoints) {
      const key = cp.section || '(General)'
      const arr = groups.get(key) ?? []
      arr.push(cp)
      groups.set(key, arr)
    }
    return [...groups.entries()].map(([section, cps]) => ({ section, cps }))
  }, [checkpoints])

  const tableMinWidth = CP_COL_W + columns.length * AUDIT_COL_W
  const lastColId = columns[columns.length - 1]?.submissionId

  function syncHeader() {
    if (scrollRef.current && headerScrollRef.current) {
      headerScrollRef.current.scrollLeft = scrollRef.current.scrollLeft
    }
  }

  // Auto-scroll to newest (rightmost) column
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
      {columns.map(c => <col key={c.submissionId} style={{ width: AUDIT_COL_W }} />)}
    </colgroup>
  )

  const SUMMARY_BG = '#f0ede7'

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl" style={{ overflow: 'clip' }}>

      {/* Sticky column header bar (document-level sticky) */}
      <div className="sticky top-0 z-20 bg-kk-panel border-b-2 border-kk-line">
        <div ref={headerScrollRef} style={{ overflowX: 'hidden', overflowY: 'hidden' }} aria-hidden="true">
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: tableMinWidth, minWidth: tableMinWidth }}>
            <ColGroup />
            <thead>
              <tr>
                <th className="sticky left-0 z-30 bg-kk-panel border-r border-kk-line/60" style={{ width: CP_COL_W }} />
                {columns.map(col => {
                  const isLatest = col.submissionId === lastColId
                  const auditorFirst = col.auditorName.split(' ')[0]
                  return (
                    <th
                      key={col.submissionId}
                      scope="col"
                      className="px-1 pb-2 pt-2 align-bottom bg-kk-panel"
                      style={{ width: AUDIT_COL_W }}
                    >
                      <Link
                        href={`/kkc/audit/${col.submissionId}`}
                        className="flex flex-col items-center gap-0.5 hover:opacity-70 transition-opacity"
                        title={`Open audit — ${col.submittedAt.slice(0, 10)}`}
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
                          {auditorFirst}
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
          <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#c8e6d0' }}><MatrixIconCheck /></span>
          Acceptable
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: '#f09090' }}><MatrixIconCross /></span>
          Unacceptable
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="inline-block w-5 h-5 rounded border border-kk-line" style={{ backgroundColor: '#eceae4' }} />
          Not assessed
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none" style={{ backgroundColor: '#F5DA93', color: '#AD3919' }}>C</span>
          Core Standard
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-kk-muted">
          <span className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none bg-kk-bad-bg text-kk-bad">RF</span>
          Red Flag
        </div>
        <span className="text-[10px] text-kk-muted ml-auto hidden sm:block">Column header → full audit</span>
      </div>

      {/* Summary rows */}
      <div ref={scrollRef} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties} onScroll={syncHeader}>
        <table className="border-collapse" style={{ tableLayout: 'fixed', width: tableMinWidth, minWidth: tableMinWidth }} aria-label="Audit checkpoint matrix">
          <ColGroup />
          <tbody>
            {/* Overall row */}
            <tr className="border-b border-kk-line/60">
              <td className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60" style={{ minWidth: CP_COL_W, width: CP_COL_W, backgroundColor: SUMMARY_BG }}>Overall</td>
              {columns.map(col => (
                <td key={col.submissionId} className="text-center px-1 py-1.5" style={{ width: AUDIT_COL_W, backgroundColor: SUMMARY_BG }}>
                  <span className={`text-xs font-bold tabular-nums ${scoreColor(col.score_pct)}`}>
                    {col.score_pct !== null ? `${Math.round(col.score_pct)}%` : '—'}
                  </span>
                </td>
              ))}
            </tr>
            {/* Core row */}
            <tr className="border-b border-kk-line/60">
              <td className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60" style={{ minWidth: CP_COL_W, width: CP_COL_W, backgroundColor: SUMMARY_BG }}>Core</td>
              {columns.map(col => (
                <td key={col.submissionId} className="text-center px-1 py-1.5" style={{ width: AUDIT_COL_W, backgroundColor: SUMMARY_BG }}>
                  <span className={`text-xs font-bold tabular-nums ${scoreColor(col.core_score_pct)}`}>
                    {col.core_score_pct !== null ? `${Math.round(col.core_score_pct)}%` : '—'}
                  </span>
                </td>
              ))}
            </tr>
            {/* Red Flags row */}
            <tr className="border-b-2 border-kk-line">
              <td className="sticky left-0 z-10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wide text-kk-muted whitespace-nowrap border-r border-kk-line/60" style={{ minWidth: CP_COL_W, width: CP_COL_W, backgroundColor: SUMMARY_BG }}>Red Flags</td>
              {columns.map(col => (
                <td key={col.submissionId} className="text-center px-1 py-1.5" style={{ width: AUDIT_COL_W, backgroundColor: SUMMARY_BG }}>
                  <span className={`text-xs font-bold tabular-nums ${col.red_flag_count ? 'text-kk-bad' : 'text-kk-good'}`}>
                    {col.red_flag_count ?? '—'}
                  </span>
                </td>
              ))}
            </tr>

            {/* Section groups */}
            {sections.map(({ section, cps }) => (
              <React.Fragment key={section}>
                <tr>
                  <td
                    colSpan={1 + columns.length}
                    className="sticky left-0 z-10 px-3 py-1"
                    style={{ backgroundColor: SUMMARY_BG }}
                  >
                    <span className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-kk-muted">{section}</span>
                  </td>
                </tr>
                {cps.map((cp, cpIdx) => (
                  <tr
                    key={cp.id}
                    className={[
                      'group transition-colors hover:bg-kk-soft',
                      cpIdx === cps.length - 1 ? 'border-b border-kk-line' : 'border-b border-kk-line/40',
                    ].join(' ')}
                  >
                    {/* Frozen checkpoint name */}
                    <td
                      className="sticky left-0 z-10 bg-kk-panel group-hover:bg-kk-soft px-3 py-1 transition-colors overflow-hidden border-r border-kk-line/60"
                      style={{ width: CP_COL_W }}
                    >
                      <div className="flex items-center gap-1.5">
                        {cp.is_red_flag ? (
                          <span className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[8px] font-bold leading-none bg-kk-bad-bg text-kk-bad">RF</span>
                        ) : cp.is_core_standard ? (
                          <span className="shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] text-[9px] font-bold leading-none" style={{ backgroundColor: '#F5DA93', color: '#AD3919' }}>C</span>
                        ) : null}
                        <span className="text-xs text-kk-ink leading-snug truncate">{cp.title}</span>
                      </div>
                    </td>

                    {/* Result cells */}
                    {columns.map(col => {
                      const result = col.responses[cp.id] ?? null
                      return (
                        <td
                          key={col.submissionId}
                          className="px-1 py-1 group-hover:bg-kk-soft transition-colors"
                          style={{ width: AUDIT_COL_W }}
                        >
                          <Link
                            href={`/kkc/audit/${col.submissionId}`}
                            className="w-6 h-6 rounded flex items-center justify-center mx-auto hover:opacity-70 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kk-ink"
                            style={{ backgroundColor: cellBg(result) }}
                            title={result === 'pass' ? 'Acceptable' : result === 'fail' ? 'Unacceptable' : result === 'na' ? 'Not assessed' : 'No response'}
                            aria-label={`${cp.title}: ${result ?? 'no response'}`}
                          >
                            {result === 'pass' && <MatrixIconCheck />}
                            {result === 'fail' && <MatrixIconCross />}
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

// ── Component ──────────────────────────────────────────────────────────────────

export default function AuditLanding({ submissions, locations }: Props) {
  const [showModal, setShowModal] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null)
  const [matrixData, setMatrixData] = useState<StoreAuditMatrixResult | null>(null)
  const [matrixLoading, setMatrixLoading] = useState(false)

  useEffect(() => {
    if (!selectedLocationId) { setMatrixData(null); return }
    setMatrixLoading(true)
    fetchStoreAuditMatrix(selectedLocationId).then(result => {
      setMatrixData(result)
      setMatrixLoading(false)
    })
  }, [selectedLocationId])

  // Latest submitted audit per location (not in_progress)
  const latestByLocation = new Map<string, AuditSubmissionRow>()
  for (const s of submissions) {
    if (s.status !== 'submitted') continue
    const existing = latestByLocation.get(s.location_id)
    if (!existing || s.submitted_at! > (existing.submitted_at ?? '')) {
      latestByLocation.set(s.location_id, s)
    }
  }

  // Derived state for selected store
  const selectedStore = selectedLocationId
    ? STORE_OVERVIEW.find(s => s.locationId === selectedLocationId) ?? null
    : null
  const storeAllRows = selectedLocationId
    ? submissions.filter(s => s.location_id === selectedLocationId)
    : submissions
  const latestSubmitted = selectedLocationId
    ? latestByLocation.get(selectedLocationId) ?? null
    : null

  // Submitted audits for selected store in chronological order (for trend)
  const storeSubmittedChronological = selectedLocationId
    ? submissions
        .filter(s => s.location_id === selectedLocationId && s.status === 'submitted')
        .slice()
        .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    : []

  const listCount = storeAllRows.length
  const subtitle = selectedStore
    ? `${selectedStore.short} · ${listCount} ${listCount === 1 ? 'audit' : 'audits'}`
    : `Audit · ${submissions.length} ${submissions.length === 1 ? 'audit' : 'audits'}`

  return (
    <div className="max-w-4xl mx-auto space-y-5">

      {/* Store overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {STORE_OVERVIEW.map(({ short, locationId }) => (
          <StoreCard
            key={locationId}
            short={short}
            submission={latestByLocation.get(locationId) ?? null}
            selected={selectedLocationId === locationId}
            onClick={() => setSelectedLocationId(id => id === locationId ? null : locationId)}
          />
        ))}
      </div>

      {/* Store KPI panel (only when a store is selected) */}
      {selectedStore && (
        <div className="space-y-3">
          {/* Store header */}
          <div className="flex items-center gap-3">
            <h2 className="text-base font-bold text-kk-ink">{selectedStore.short}</h2>
            {latestSubmitted?.audit_status && (
              <HealthBadge status={latestSubmitted.audit_status} />
            )}
            {latestSubmitted?.submitted_at && (
              <span className="text-[11px] text-kk-muted">
                Latest audit: {formatDate(latestSubmitted.submitted_at)}
              </span>
            )}
            {storeSubmittedChronological.length === 1 && (
              <span className="text-[11px] text-kk-muted italic">· More audits needed for trend</span>
            )}
          </div>

          {latestSubmitted ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <KpiCard
                  label="Core Score"
                  value={
                    <span className={scoreColor(latestSubmitted.core_score_pct)}>
                      {latestSubmitted.core_score_pct !== null ? `${latestSubmitted.core_score_pct.toFixed(0)}%` : '—'}
                    </span>
                  }
                  sub="Critical checkpoints"
                />
                <KpiCard
                  label="Overall Score"
                  value={
                    <span className={scoreColor(latestSubmitted.score_pct)}>
                      {latestSubmitted.score_pct !== null ? `${latestSubmitted.score_pct.toFixed(0)}%` : '—'}
                    </span>
                  }
                  sub="All checkpoints"
                />
                <KpiCard
                  label="Red Flags"
                  value={
                    <span className={latestSubmitted.red_flag_count ? 'text-kk-bad' : 'text-kk-good'}>
                      {latestSubmitted.red_flag_count ?? '—'}
                    </span>
                  }
                  sub="Critical failures"
                />
              </div>

              {storeSubmittedChronological.length >= 2 && (
                <AuditScoreTrend rows={storeSubmittedChronological} />
              )}

              {/* Checkpoint matrix */}
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
                  {matrixData.columns.length > 0 ? (
                    <AuditCheckpointMatrix checkpoints={matrixData.checkpoints} columns={matrixData.columns} />
                  ) : null}
                </>
              )}
              {!matrixLoading && matrixData && !matrixData.ok && (
                <p className="text-xs text-kk-bad px-1">Matrix load failed: {matrixData.error}</p>
              )}
            </>
          ) : (
            <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-6 py-10 text-center">
              <div className="text-sm font-semibold text-kk-ink mb-1">No submitted audits for {selectedStore.short}</div>
              <div className="text-sm text-kk-muted">Start a new audit to see results here.</div>
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-kk-ink">Audit</h1>
          <p className="text-sm text-kk-muted mt-0.5">{subtitle}</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-kk-ink text-white text-sm font-semibold rounded-xl hover:opacity-80 transition-opacity"
        >
          + Start new audit
        </button>
      </div>

      {/* List */}
      {storeAllRows.length === 0 ? (
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-6 py-14 text-center">
          <div className="text-sm font-semibold text-kk-ink mb-1">No audits yet</div>
          <div className="text-sm text-kk-muted">Start a new audit to see results here.</div>
        </div>
      ) : (
        <AuditTable rows={storeAllRows} showLocation={!selectedLocationId} />
      )}

      {showModal && (
        <StartAuditModal
          locations={locations}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  )
}
