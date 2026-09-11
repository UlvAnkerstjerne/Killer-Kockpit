// Server component — read-only Mystery Diner result detail view

import Link from 'next/link'
import { dinerScoreColor, DINER_STATUS_CLS, DINER_STATUS_LABEL } from '@/lib/diner/scoring'
import type { DinerDetailSubmission, DinerDetailCheckpoint, DinerDetailResponse } from './page'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('da-DK', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const item of arr) {
    const k = key(item)
    ;(out[k] ??= []).push(item)
  }
  return out
}

// ─── Result symbol ────────────────────────────────────────────────────────────

function ResultCell({
  type, result, isCritical, notes,
}: {
  type:       DinerDetailCheckpoint['type']
  result:     DinerDetailResponse['result']
  isCritical: boolean
  notes:      string | null
}) {
  if (type === 'informational') {
    return (
      <span className="text-sm text-kk-muted italic">
        {notes ?? '—'}
      </span>
    )
  }

  if (type === 'waiting_time') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded bg-kk-soft border border-kk-line text-xs font-semibold text-kk-ink">
        {notes ?? '—'}
      </span>
    )
  }

  if (type === 'gold_star') {
    if (result === 'pass') {
      return <span className="text-base">★</span>
    }
    if (result === 'na') {
      return <span className="text-xs text-kk-muted font-medium">N/A</span>
    }
    // fail or null
    return <span className="text-base text-kk-muted/30">★</span>
  }

  // scored
  if (result === 'pass') {
    return (
      <span className={`text-sm font-semibold ${isCritical ? 'text-kk-good' : 'text-kk-good'}`}>
        Pass
      </span>
    )
  }
  if (result === 'fail') {
    return (
      <span className={`text-sm font-bold ${isCritical ? 'text-kk-bad' : 'text-kk-bad'}`}>
        Fail
      </span>
    )
  }
  if (result === 'na') {
    return <span className="text-xs text-kk-muted font-medium">N/A</span>
  }
  return <span className="text-xs text-kk-muted">—</span>
}

// ─── Checkpoint row ───────────────────────────────────────────────────────────

function CheckpointRow({
  cp, resp,
}: {
  cp:   DinerDetailCheckpoint
  resp: DinerDetailResponse | undefined
}) {
  const isFail       = resp?.result === 'fail'
  const isCritical   = cp.is_critical
  const isGoldStar   = cp.type === 'gold_star'
  const isGoldPass   = isGoldStar && resp?.result === 'pass'
  const isCritFail   = isFail && isCritical

  let rowCls = 'border-b border-kk-line/60'
  if (isCritFail)   rowCls += ' bg-kk-bad-bg/50'
  else if (isFail)  rowCls += ' bg-kk-bad-bg/20'
  else if (isGoldPass) rowCls += ' bg-yellow-50/60'

  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${rowCls}`}>
      {/* Order index */}
      <span className="shrink-0 w-7 text-right text-xs text-kk-muted tabular-nums pt-0.5">
        {cp.order_index}
      </span>

      {/* Label + tags */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
          <span className={`text-sm leading-snug ${
            isCritFail ? 'font-semibold text-kk-bad' :
            isGoldPass ? 'font-medium text-yellow-700' :
            'text-kk-ink'
          }`}>
            {cp.label}
          </span>
          {isCritical && (
            <span className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-bold bg-kk-bad-bg text-kk-bad border border-kk-bad/30 uppercase tracking-wide">
              Critical
            </span>
          )}
          {cp.is_conditional && (
            <span className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium bg-kk-soft text-kk-muted border border-kk-line uppercase tracking-wide">
              Conditional
            </span>
          )}
        </div>
        {resp?.notes && cp.type === 'scored' && (
          <p className="text-xs text-kk-muted mt-0.5 italic">{resp.notes}</p>
        )}
      </div>

      {/* Result */}
      <div className={`shrink-0 text-right min-w-[48px] ${isGoldPass ? 'text-yellow-500' : ''}`}>
        <ResultCell
          type={cp.type}
          result={resp?.result ?? null}
          isCritical={isCritical}
          notes={resp?.notes ?? null}
        />
      </div>
    </div>
  )
}

// ─── Section group ─────────────────────────────────────────────────────────────

function SectionGroup({
  section, checkpoints, responseMap,
}: {
  section:     string
  checkpoints: DinerDetailCheckpoint[]
  responseMap: Map<string, DinerDetailResponse>
}) {
  const hasAnyFail = checkpoints.some(cp => responseMap.get(cp.id)?.result === 'fail')

  return (
    <div className="bg-kk-panel rounded-xl border border-kk-line shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
      {/* Section header */}
      <div className={`px-4 py-2.5 border-b ${hasAnyFail ? 'border-kk-bad/20 bg-kk-bad-bg/30' : 'border-kk-line bg-kk-soft'}`}>
        <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-kk-muted">
          {section}
        </h3>
      </div>

      {/* Checkpoints */}
      <div>
        {checkpoints.map(cp => (
          <CheckpointRow
            key={cp.id}
            cp={cp}
            resp={responseMap.get(cp.id)}
          />
        ))}
      </div>
    </div>
  )
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-kk-panel rounded-xl border border-kk-line shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-4 py-3 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-kk-muted mb-1">{label}</p>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <p className="text-xs text-kk-muted mt-0.5">{sub}</p>}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  submission:  DinerDetailSubmission
  checkpoints: DinerDetailCheckpoint[]
  responses:   DinerDetailResponse[]
}

export default function DinerResultDetail({ submission, checkpoints, responses }: Props) {
  const responseMap = new Map(responses.map(r => [r.checkpoint_id, r]))

  // Group checkpoints by section, preserving order
  const sections: string[] = []
  const grouped = groupBy(checkpoints, cp => cp.section)
  for (const cp of checkpoints) {
    if (!sections.includes(cp.section)) sections.push(cp.section)
  }

  const { final_status, score_pct, critical_fail_count, gold_star_count, waiting_time_band } = submission

  const critFails = critical_fail_count ?? 0
  const goldStars = gold_star_count     ?? 0

  // Count critical failures for summary
  const critFailCps = checkpoints.filter(cp =>
    cp.is_critical && responseMap.get(cp.id)?.result === 'fail'
  )

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-kk-muted">
        <Link href="/kkc/diner" className="hover:text-kk-ink transition-colors">
          Mystery Diner
        </Link>
        <span>/</span>
        <span className="text-kk-ink font-medium">
          {submission.location_name ?? 'Visit'} — {submission.diner_name}
        </span>
      </div>

      {/* Result banner */}
      {final_status && (
        <div className={`rounded-xl border overflow-hidden ${DINER_STATUS_CLS[final_status]}`}>
          {/* Header row */}
          <div className="px-5 py-4 border-b border-current/20">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] opacity-70 mb-0.5">
                  Mystery Diner result
                </p>
                <p className="text-xl font-bold">{DINER_STATUS_LABEL[final_status]}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs opacity-60">{fmtDate(submission.submitted_at)}</p>
                {submission.location_name && (
                  <p className="text-xs font-semibold mt-0.5">{submission.location_name}</p>
                )}
              </div>
            </div>
          </div>

          {/* KPIs */}
          <div className="px-5 py-4 grid grid-cols-4 gap-4">
            <div className="text-center">
              <p className="text-[11px] font-semibold opacity-60 mb-0.5">Score</p>
              {score_pct !== null ? (
                <p className={`text-2xl font-bold tabular-nums ${dinerScoreColor(score_pct)}`}>
                  {score_pct.toFixed(0)}%
                </p>
              ) : (
                <p className="text-xl font-bold opacity-40">—</p>
              )}
            </div>
            <div className="text-center">
              <p className="text-[11px] font-semibold opacity-60 mb-0.5">Criticals</p>
              <p className={`text-2xl font-bold tabular-nums ${critFails > 0 ? 'text-kk-bad' : 'opacity-40'}`}>
                {critFails}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[11px] font-semibold opacity-60 mb-0.5">Gold Stars</p>
              <p className={`text-2xl font-bold tabular-nums ${goldStars > 0 ? 'text-yellow-500' : 'opacity-40'}`}>
                {goldStars > 0 ? `★ ${goldStars}` : goldStars}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[11px] font-semibold opacity-60 mb-0.5">Wait</p>
              <p className="text-xl font-bold tabular-nums opacity-80">
                {waiting_time_band ? `${waiting_time_band} min` : '—'}
              </p>
            </div>
          </div>

          {/* Critical failure callout */}
          {critFailCps.length > 0 && (
            <div className="mx-5 mb-4 px-3 py-2.5 bg-kk-bad/10 border border-kk-bad/30 rounded-lg space-y-1">
              <p className="text-[11px] font-bold uppercase tracking-wide text-kk-bad mb-1">
                Critical failures
              </p>
              {critFailCps.map(cp => (
                <p key={cp.id} className="text-xs text-kk-bad font-medium">
                  #{cp.order_index} {cp.label}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Diner meta (when no final_status banner) */}
      {!final_status && (
        <div className="bg-kk-panel rounded-xl border border-kk-line shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-5 py-4">
          <p className="text-sm font-semibold text-kk-ink">{submission.diner_name}</p>
          <p className="text-xs text-kk-muted mt-0.5">
            {submission.location_name} · {fmtDate(submission.submitted_at)}
          </p>
        </div>
      )}

      {/* Section-grouped checkpoints */}
      {sections.map(section => (
        <SectionGroup
          key={section}
          section={section}
          checkpoints={grouped[section] ?? []}
          responseMap={responseMap}
        />
      ))}

      {/* Back link */}
      <div className="pb-4">
        <Link
          href="/kkc/diner"
          className="text-sm text-kk-muted hover:text-kk-ink transition-colors"
        >
          ← Back to Mystery Diner
        </Link>
      </div>
    </div>
  )
}
