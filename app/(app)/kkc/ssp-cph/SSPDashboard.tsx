'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { KKCSspCphData, KKCScoreRow, KKCSubmissionDetail } from '@/lib/kkc/ssp-cph'
import { buildSubmissionDetail } from '@/lib/kkc/detail'
import KualityMatrix from './KualityMatrix'

const KKC_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSckp6OU3C_gRZnTxxdRLh3p2GfisyXXRclDwrkKgNgrGO6Y0A/viewform'

// ── Score styling ──────────────────────────────────────────────────────────────

function scoreTextCls(n: number): string {
  return n >= 90 ? 'text-kk-good' : n >= 75 ? 'text-kk-warn' : 'text-kk-bad'
}

function scoreBgCls(n: number): string {
  if (n >= 90) return 'bg-kk-good-bg border-kk-good text-kk-good'
  if (n >= 75) return 'bg-kk-warn-bg border-kk-warn text-kk-warn'
  return 'bg-kk-bad-bg border-kk-bad text-kk-bad'
}

// ── Dynamic y-axis ─────────────────────────────────────────────────────────────

function computeYRange(scores: KKCScoreRow[]): { min: number; max: number; gridStep: number } {
  const vals     = [...scores.map(s => s.overallScore), ...scores.map(s => s.criticalScore)]
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

// ── Score trend chart (multi-visit only) ──────────────────────────────────────

function ScoreTrend({ scores }: { scores: KKCScoreRow[] }) {
  if (scores.length < 2) return null

  const W       = 540
  const H       = 160
  const PT      = 10
  const PB      = 8
  const LABEL_W = 34
  const PR      = 8

  const { min: minV, max: maxV, gridStep } = computeYRange(scores)
  const range  = maxV - minV
  const chartL = LABEL_W
  const chartR = W - PR
  const chartT = PT
  const chartB = H - PB

  function xPos(i: number) {
    return chartL + (i / (scores.length - 1)) * (chartR - chartL)
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

  function polyline(arr: number[]) {
    return arr.map((v, i) => `${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ')
  }

  const dateLabelIdxs: number[] = (() => {
    const n = scores.length
    if (n <= 4) return scores.map((_, i) => i)
    const step = Math.floor((n - 1) / 3)
    return [0, step, step * 2, n - 1]
  })()

  const lastIdx = scores.length - 1

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Score trend">
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
        points={polyline(scores.map(s => s.criticalScore))}
        fill="none" stroke="#8d3737" strokeWidth="1.5"
        strokeDasharray="4 2" strokeLinejoin="round"
      />
      <polyline
        points={polyline(scores.map(s => s.overallScore))}
        fill="none" stroke="#171717" strokeWidth="2.5" strokeLinejoin="round"
      />
      {scores.map((s, i) => (
        <g key={s.timestamp}>
          <circle cx={xPos(i)} cy={yPos(s.overallScore)}  r={i === lastIdx ? 4 : 3} fill="#171717" />
          <circle cx={xPos(i)} cy={yPos(s.criticalScore)} r={i === lastIdx ? 4 : 3} fill="#8d3737" />
        </g>
      ))}
      {dateLabelIdxs.map(i => (
        <text
          key={i}
          x={xPos(i)} y={H}
          fontSize="8.5" fill="#9e9890"
          textAnchor={i === 0 ? 'start' : i === scores.length - 1 ? 'end' : 'middle'}
        >
          {scores[i].date}
        </text>
      ))}
    </svg>
  )
}

// ── Section ordering (for detail panel) ───────────────────────────────────────

const SECTION_ORDER = [
  'Kebab Wrap', 'Chicken Wrap', 'Falafel Wrap', 'Falafel Cup',
  'Fries', 'Lemonade', 'Prep / Operations', 'Service / Staff',
]

// ── Detail panel ───────────────────────────────────────────────────────────────

function DetailPanel({ detail, onClose }: { detail: KKCSubmissionDetail; onClose: () => void }) {
  const sectionMap = new Map<string, typeof detail.checkpoints>()
  for (const cp of detail.checkpoints) {
    if (cp.result === null) continue
    const existing = sectionMap.get(cp.section) ?? []
    existing.push(cp)
    sectionMap.set(cp.section, existing)
  }

  const sections = [
    ...SECTION_ORDER.filter(s => sectionMap.has(s)),
    ...[...sectionMap.keys()].filter(s => !SECTION_ORDER.includes(s)),
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-end"
      onClick={onClose}
      style={{ background: 'rgba(23,23,23,0.25)', backdropFilter: 'blur(2px)' }}
    >
      <div
        className="relative w-full max-w-lg h-full bg-kk-panel overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="sticky top-0 bg-kk-panel border-b border-kk-line px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold tracking-[0.12em] uppercase text-kk-muted">
              Check detail
            </div>
            <div className="text-xl font-black text-kk-ink mt-0.5">
              {detail.date} · {detail.time}
            </div>
            {detail.mysteryDiner && (
              <div className="text-sm text-kk-muted mt-0.5">{detail.mysteryDiner}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-kk-muted hover:text-kk-ink transition-colors mt-0.5 shrink-0"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {detail.productsOrdered && (
            <div>
              <div className="text-[10px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-1">
                Products ordered
              </div>
              <div className="text-sm text-kk-ink">{detail.productsOrdered}</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className={`rounded-xl border px-3 py-2.5 ${scoreBgCls(detail.overallScore)}`}>
              <div className="text-[9px] font-bold uppercase tracking-wider opacity-60">Overall</div>
              <div className="text-2xl font-black leading-tight mt-0.5">{detail.overallScore}%</div>
            </div>
            <div className={`rounded-xl border px-3 py-2.5 ${scoreBgCls(detail.criticalScore)}`}>
              <div className="text-[9px] font-bold uppercase tracking-wider opacity-60">Critical</div>
              <div className="text-2xl font-black leading-tight mt-0.5">{detail.criticalScore}%</div>
            </div>
          </div>

          {detail.criticalFailureDetails.length > 0 ? (
            <div className="rounded-xl bg-kk-bad-bg border border-kk-bad px-4 py-3">
              <div className="text-xs font-bold text-kk-bad uppercase tracking-wide mb-2">
                Critical failures — {detail.criticalFailureDetails.length}
              </div>
              <ul className="space-y-0.5">
                {detail.criticalFailureDetails.map(cp => (
                  <li key={`${cp.section}/${cp.checkpoint}`} className="text-sm text-kk-bad">
                    {cp.section}: {cp.checkpoint}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-kk-good">
              <span className="w-1.5 h-1.5 rounded-full bg-kk-good shrink-0" />
              No critical failures
            </div>
          )}

          {sections.length > 0 && (
            <div className="space-y-4">
              {sections.map(section => {
                const cps     = sectionMap.get(section) ?? []
                const comment = detail.sectionComments.find(c =>
                  c.header.toLowerCase().includes(section.toLowerCase())
                )
                return (
                  <div key={section}>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-kk-muted mb-1.5">
                      {section}
                    </div>
                    <div>
                      {cps.map(cp => (
                        <div
                          key={cp.checkpoint}
                          className={`flex items-center justify-between gap-3 py-1.5 px-2 rounded-lg ${
                            cp.result === 'Unacceptable' ? 'bg-kk-bad-bg' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            {cp.isCritical && (
                              <span className="shrink-0 text-[8px] font-black uppercase tracking-wide text-kk-bad border border-kk-bad rounded px-1 leading-tight py-0.5">
                                C
                              </span>
                            )}
                            <span className={`text-sm truncate ${
                              cp.result === 'Unacceptable'
                                ? 'text-kk-bad font-medium'
                                : 'text-kk-muted'
                            }`}>
                              {cp.checkpoint}
                            </span>
                          </div>
                          <span className={`shrink-0 text-xs font-semibold ${
                            cp.result === 'Unacceptable' ? 'text-kk-bad' : 'text-kk-good'
                          }`}>
                            {cp.result === 'Unacceptable' ? 'Fail' : '✓'}
                          </span>
                        </div>
                      ))}
                    </div>
                    {comment && (
                      <p className="mt-1.5 text-xs text-kk-muted bg-kk-soft rounded-lg px-3 py-2 italic">
                        {comment.text}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {detail.overallComments && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-kk-muted mb-1.5">
                Overall comments
              </div>
              <div className="bg-kk-soft rounded-xl px-4 py-3 text-sm text-kk-ink whitespace-pre-wrap">
                {detail.overallComments}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── KPI aggregation ──────────────────────────────────────────────────────────

const WINDOW_SIZE = 5

interface WindowKPIs {
  criticalPct: number
  overallPct:  number
  avgFailures: number
}

function computeWindowKPIs(
  scores:      KKCScoreRow[],
  config:      KKCSspCphData['config'],
  formHeaders: string[],
  formRows:    string[][],
): WindowKPIs {
  const headerIndex = new Map(formHeaders.map((h, i) => [h, i]))
  let acceptedCritical = 0, assessedCritical = 0
  let acceptedOverall  = 0, assessedOverall  = 0
  let totalFailures    = 0

  for (const score of scores) {
    const formRow = formRows.find(r => r[0] === score.timestamp)
    totalFailures += score.criticalFailures
    for (const cp of config) {
      const idx = headerIndex.get(cp.responseHeader)
      if (idx === undefined) continue
      const raw = (formRow?.[idx] ?? '').trim()
      if (raw !== 'Acceptable' && raw !== 'Unacceptable') continue
      assessedOverall++
      if (raw === 'Acceptable') acceptedOverall++
      if (cp.isCritical) {
        assessedCritical++
        if (raw === 'Acceptable') acceptedCritical++
      }
    }
  }

  return {
    criticalPct: assessedCritical > 0 ? Math.round((acceptedCritical / assessedCritical) * 100) : 0,
    overallPct:  assessedOverall  > 0 ? Math.round((acceptedOverall  / assessedOverall)  * 100) : 0,
    avgFailures: scores.length > 0 ? totalFailures / scores.length : 0,
  }
}

// ── KPI cards ─────────────────────────────────────────────────────────────────

function fmtAvgFailures(n: number): string {
  return (n % 1 === 0 ? String(n) : n.toFixed(1)) + ' / check'
}

function DiffLine({
  diff,
  lowerIsBetter,
  unit,
  windowSize,
}: {
  diff:          number
  lowerIsBetter: boolean
  unit:          string
  windowSize:    number
}) {
  const improved   = lowerIsBetter ? diff < 0 : diff > 0
  const sign       = diff > 0 ? '+' : ''
  const cls        = diff === 0 ? 'text-kk-muted' : improved ? 'text-kk-good' : 'text-kk-bad'
  const diffStr    = typeof diff === 'number' && !Number.isInteger(diff)
    ? diff.toFixed(1) : String(diff)
  return (
    <span className={`text-[10px] ${cls}`}>
      {sign}{diffStr}{unit} vs previous {windowSize}
    </span>
  )
}

function KpiCards({ data, allScores }: { data: KKCSspCphData; allScores: KKCScoreRow[] }) {
  const n = allScores.length
  const currentWindow  = allScores.slice(-WINDOW_SIZE)
  const previousWindow = n >= WINDOW_SIZE * 2 ? allScores.slice(-(WINDOW_SIZE * 2), -WINDOW_SIZE) : null

  const current  = computeWindowKPIs(currentWindow,  data.config, data.formHeaders, data.formRows)
  const previous = previousWindow
    ? computeWindowKPIs(previousWindow, data.config, data.formHeaders, data.formRows)
    : null

  const criticalDiff = previous !== null ? current.criticalPct - previous.criticalPct : null
  const overallDiff  = previous !== null ? current.overallPct  - previous.overallPct  : null
  const failuresDiff = previous !== null
    ? Math.round((current.avgFailures - previous.avgFailures) * 10) / 10
    : null

  const comparisonLabel = (
    <span className="text-[10px] text-kk-muted">
      Comparison after {WINDOW_SIZE * 2} visits
    </span>
  )

  const criticalCls = current.criticalPct === 100 ? 'text-kk-good' : 'text-kk-bad'
  const failuresCls = current.avgFailures === 0   ? 'text-kk-good' : 'text-kk-bad'

  return (
    <div className="grid grid-cols-3 gap-2">
      {/* Critical */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.1em] text-kk-muted mb-1.5">Critical</div>
        <div className={`text-3xl font-black tabular-nums leading-none ${criticalCls}`}>
          {current.criticalPct}%
        </div>
        <div className="mt-2 leading-none">
          {criticalDiff !== null
            ? <DiffLine diff={criticalDiff} lowerIsBetter={false} unit=" pts" windowSize={WINDOW_SIZE} />
            : comparisonLabel}
        </div>
      </div>

      {/* Overall */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.1em] text-kk-muted mb-1.5">Overall</div>
        <div className={`text-3xl font-black tabular-nums leading-none ${scoreTextCls(current.overallPct)}`}>
          {current.overallPct}%
        </div>
        <div className="mt-2 leading-none">
          {overallDiff !== null
            ? <DiffLine diff={overallDiff} lowerIsBetter={false} unit=" pts" windowSize={WINDOW_SIZE} />
            : comparisonLabel}
        </div>
      </div>

      {/* Critical failures */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.1em] text-kk-muted mb-1.5">
          Critical failures
        </div>
        <div className={`text-3xl font-black tabular-nums leading-none ${failuresCls}`}>
          {fmtAvgFailures(current.avgFailures)}
        </div>
        <div className="mt-2 leading-none">
          {failuresDiff !== null
            ? <DiffLine diff={failuresDiff} lowerIsBetter={true} unit="" windowSize={WINDOW_SIZE} />
            : comparisonLabel}
        </div>
      </div>
    </div>
  )
}

// ── Main dashboard ─────────────────────────────────────────────────────────────

interface Props {
  initialData: KKCSspCphData | null
  fetchedAt:   string | null
  error:       string | null
  userRole:    string
}

export default function SSPDashboard({
  initialData,
  fetchedAt,
  error: initialError,
  userRole,
}: Props) {
  const router  = useRouter()
  const [isPending, startTransition] = useTransition()
  const [refreshError, setRefreshError]           = useState<string | null>(null)
  const [selectedTimestamp, setSelectedTimestamp] = useState<string | null>(null)

  const data      = initialData
  const allScores = data?.scores ?? []
  const selectedDetail = selectedTimestamp && data
    ? buildSubmissionDetail(data, selectedTimestamp)
    : null

  const displayError = refreshError ?? initialError

  async function handleRefresh() {
    setRefreshError(null)
    try {
      const res = await fetch('/api/kkc/ssp-cph?force=true')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRefreshError((body as Record<string, string>).error ?? 'Refresh failed')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setRefreshError('Network error — please try again')
    }
  }

  return (
    <>
      {selectedDetail && (
        <DetailPanel detail={selectedDetail} onClose={() => setSelectedTimestamp(null)} />
      )}

      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="text-[10px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-0.5">
            Killer Kuality Check
          </div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">SSP / CPH Airport</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <div className="flex flex-col items-end gap-0.5">
            <button
              onClick={handleRefresh}
              disabled={isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-kk-ink bg-kk-soft border border-kk-line rounded-lg hover:bg-kk-line transition-colors disabled:opacity-40"
            >
              <svg
                width="11" height="11" viewBox="0 0 16 16" fill="none"
                className={isPending ? 'animate-spin' : ''}
              >
                <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 4.15 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M10.5 4.5h3.5V1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {isPending ? 'Refreshing…' : 'Refresh'}
            </button>
            {fetchedAt && (
              <span className="text-[9px] text-kk-muted leading-none">
                {new Date(fetchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <a
            href={KKC_FORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 bg-kk-ink text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            + New Kuality Check
          </a>
        </div>
      </div>

      {/* ── Error banner ── */}
      {displayError && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-kk-bad-bg border border-kk-bad text-sm text-kk-bad">
          {displayError === 'sheets_not_configured' ? (
            <>
              Sheets integration not set up.{' '}
              {userRole === 'SUPER_ADMIN' ? (
                <><a href="/settings" className="underline font-medium">Settings → Sheets</a> to enable.</>
              ) : (
                'Ask a SUPER_ADMIN to enable Sheets in Settings.'
              )}
            </>
          ) : displayError === 'sheets_api_disabled' ? (
            <>
              Google Sheets API is disabled in the GCP project.{' '}
              {userRole === 'SUPER_ADMIN'
                ? 'Enable it in Google Cloud Console → APIs & Services → Google Sheets API, then refresh.'
                : 'Ask a SUPER_ADMIN to enable the Google Sheets API.'}
            </>
          ) : displayError === 'sheets_access_denied' ? (
            <>
              Access denied to the spreadsheet.{' '}
              {userRole === 'SUPER_ADMIN'
                ? 'Verify the connected Google account has access, then refresh.'
                : 'Ask a SUPER_ADMIN to check spreadsheet access.'}
            </>
          ) : displayError === 'sheets_not_found' ? (
            'Spreadsheet not found — it may have been moved or deleted.'
          ) : displayError === 'fetch_failed' ? (
            'Failed to fetch data from Google Sheets. Try refreshing.'
          ) : (
            `Error: ${displayError}`
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {(!data || allScores.length === 0) && !displayError && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl">
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <p className="font-semibold text-kk-ink">No checks recorded yet</p>
            <p className="text-sm text-kk-muted mt-1 max-w-xs">
              Quality check results will appear here once the first form submission is made.
            </p>
            <a
              href={KKC_FORM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
            >
              + New Kuality Check
            </a>
          </div>
        </div>
      )}

      {/* ── Dashboard ── */}
      {data && allScores.length > 0 && (
        <div className="space-y-3">

          {/* Current performance KPI cards */}
          <KpiCards data={data} allScores={allScores} />

          {/* Score trend — full chart for 2+ visits, one-liner for 1 */}
          {allScores.length >= 2 ? (
            <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 pt-4 pb-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-bold uppercase tracking-wide text-kk-muted">
                  Score trend
                </div>
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
                    Critical
                  </span>
                </div>
              </div>
              <ScoreTrend scores={allScores} />
            </div>
          ) : (
            <p className="text-xs text-kk-muted px-1">Trend starts after next visit</p>
          )}

          {/* Checkpoint matrix — primary content */}
          <KualityMatrix
            data={data}
            onVisitClick={(ts) => setSelectedTimestamp(ts)}
          />

        </div>
      )}
    </>
  )
}
