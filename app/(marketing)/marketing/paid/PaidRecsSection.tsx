'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approvePaidRecommendation, dismissPaidRecommendation } from '@/lib/actions/marketing/paid-recommendations'
import type { PaidRecommendationRow } from '@/lib/marketing/paid-recs/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

const URGENCY_CFG: Record<string, { bg: string; text: string; dot: string }> = {
  high:   { bg: 'bg-red-50',    text: 'text-red-700',    dot: 'bg-red-500' },
  medium: { bg: 'bg-kk-bad-bg', text: 'text-kk-bad',     dot: 'bg-kk-brand' },
  low:    { bg: 'bg-kk-soft',   text: 'text-kk-muted',   dot: 'bg-kk-muted' },
}

const SIGNAL_ICONS: Record<string, string> = {
  spend_no_results:   '\u26A0',
  cpr_worsening:      '\u2198',
  cpr_improving:      '\u2197',
  strong_performance: '\u2B50',
}

function signalLabel(type: string): string {
  return ({
    spend_no_results:   'Spending with no results',
    cpr_worsening:      'Cost per result worsening',
    cpr_improving:      'Cost per result improving',
    strong_performance: 'Strong performance',
  } as Record<string, string>)[type] ?? type
}

// ── Card ─────────────────────────────────────────────────────────────────────

function PaidRecCard({
  rec,
  canAction,
}: {
  rec: PaidRecommendationRow
  canAction: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleApprove = () => {
    startTransition(async () => {
      await approvePaidRecommendation(rec.id)
      router.refresh()
    })
  }

  const handleDismiss = () => {
    startTransition(async () => {
      await dismissPaidRecommendation(rec.id)
      router.refresh()
    })
  }

  const platformLabel = rec.platform === 'meta' ? 'Meta' : 'Google Ads'
  const urgency = URGENCY_CFG[rec.urgency] ?? URGENCY_CFG.low
  const icon = SIGNAL_ICONS[rec.signal_type] ?? '\u2022'

  return (
    <div className="bg-white border border-kk-line rounded-2xl overflow-hidden" style={{ boxShadow: '0 2px 8px rgba(23,23,23,0.05)' }}>
      {/* Header */}
      <div className={`px-5 py-3 flex items-center justify-between gap-3 ${urgency.bg}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-4xl">{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-kk-ink">{signalLabel(rec.signal_type)}</span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${urgency.bg} ${urgency.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${urgency.dot}`} />
                {rec.urgency}
              </span>
            </div>
            <div className="text-xs text-kk-muted mt-0.5">{platformLabel} {'\u00B7'} {rec.campaign_name ?? 'Account-level'}</div>
          </div>
        </div>
        {rec.status === 'approved' && rec.execution_status === 'in_motion' && (
          <span className="shrink-0 text-[10px] font-semibold text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">
            In motion
          </span>
        )}
        {rec.status === 'approved' && rec.execution_status === 'completed' && (
          <span className="shrink-0 text-[10px] font-semibold text-kk-good bg-kk-good-bg rounded-full px-2 py-0.5">
            Completed
          </span>
        )}
        {rec.status === 'approved' && (rec.execution_status === 'failed' || rec.execution_status === 'needs_attention') && (
          <span className="shrink-0 text-[10px] font-semibold text-kk-bad bg-kk-bad-bg rounded-full px-2 py-0.5">
            {rec.execution_status === 'failed' ? 'Failed' : 'Needs attention'}
          </span>
        )}
      </div>

      {/* What changed */}
      <div className="px-5 py-3 border-b border-kk-line">
        <p className="text-base font-semibold text-kk-ink leading-snug">{rec.what_changed}</p>
      </div>

      {/* Detail sub-cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-kk-line">
        <div className="px-4 py-3">
          <div className="text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted mb-1">Evidence</div>
          <p className="text-sm text-kk-ink leading-relaxed">{rec.evidence}</p>
        </div>
        <div className="px-4 py-3">
          <div className="text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted mb-1">Interpretation</div>
          <p className="text-sm text-kk-ink leading-relaxed">{rec.interpretation}</p>
        </div>
        <div className="px-4 py-3">
          <div className="text-[10px] font-bold tracking-[0.07em] uppercase text-kk-muted mb-1">Recommended action</div>
          <p className="text-sm font-medium text-kk-ink leading-relaxed">{rec.recommended_action}</p>
        </div>
      </div>

      {/* Actions — needs_review */}
      {rec.status === 'needs_review' && canAction && (
        <div className="flex gap-2 px-5 py-3 border-t border-kk-line bg-kk-soft/50">
          <button
            onClick={handleApprove}
            disabled={isPending}
            className="rounded-full bg-kk-brand px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {isPending ? 'Starting\u2026' : 'Approve & start'}
          </button>
          <button
            onClick={handleDismiss}
            disabled={isPending}
            className="rounded-full border border-kk-line bg-white px-4 py-1.5 text-xs font-semibold text-kk-muted hover:bg-kk-soft hover:text-kk-ink disabled:opacity-50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Execution status — in_motion / completed / failed / needs_attention */}
      {rec.execution_status && rec.execution_status !== 'pending_approval' && (
        <div className="px-5 py-3 border-t border-kk-line space-y-2">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
              rec.execution_status === 'in_motion' ? 'bg-blue-50 text-blue-700'
              : rec.execution_status === 'completed' ? 'bg-kk-good-bg text-kk-good'
              : rec.execution_status === 'failed' ? 'bg-red-50 text-red-700'
              : 'bg-kk-bad-bg text-kk-bad'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                rec.execution_status === 'in_motion' ? 'bg-blue-500 animate-pulse'
                : rec.execution_status === 'completed' ? 'bg-green-500'
                : 'bg-red-500'
              }`} />
              {rec.execution_status === 'in_motion' ? 'In motion'
                : rec.execution_status === 'completed' ? 'Completed'
                : rec.execution_status === 'failed' ? 'Failed'
                : 'Needs attention'}
            </span>
            {rec.execution_started_at && (
              <span className="text-[10px] text-kk-muted">
                Started {new Date(rec.execution_started_at).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short' })}
              </span>
            )}
          </div>

          {/* Linked task */}
          {rec.linked_task_id && (
            <a
              href={`/tasks/${rec.linked_task_id}`}
              className="flex items-center gap-1.5 text-xs font-medium text-kk-brand hover:underline"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
                <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {String((rec.execution_result as Record<string, unknown>)?.task_title ?? 'View linked task')}
            </a>
          )}

          {/* Monitoring */}
          {rec.execution_result?.monitoring && (() => {
            const m = rec.execution_result.monitoring
            const monitorEnd = m.monitor_end
            const outcome = m.outcome
            const isActive = rec.execution_status === 'in_motion'
            return (
              <div className="flex items-center gap-3 text-xs text-kk-muted">
                <span>Monitoring until {new Date(monitorEnd).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short' })}</span>
                {outcome && (
                  <span className={`font-semibold ${
                    outcome === 'improved' ? 'text-kk-good'
                    : outcome === 'needs_attention' ? 'text-kk-bad'
                    : 'text-kk-muted'
                  }`}>
                    {outcome === 'improved' ? 'Improved' : outcome === 'needs_attention' ? 'Needs attention' : 'Unchanged'}
                  </span>
                )}
                {isActive && !outcome && <span className="text-blue-600">Monitoring active</span>}
              </div>
            )
          })()}

          {/* Error */}
          {rec.execution_result?.error && (
            <p className="text-xs text-kk-bad">{rec.execution_result.error}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Section ──────────────────────────────────────────────────────────────────

export default function PaidRecsSection({
  recommendations,
  canAction,
}: {
  recommendations: PaidRecommendationRow[]
  canAction: boolean
}) {
  if (recommendations.length === 0) return null

  const pending  = recommendations.filter(r => r.status === 'needs_review')
  const approved = recommendations.filter(r => r.status === 'approved')

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-xl font-black tracking-tight text-kk-ink">Recommendations</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-kk-brand px-2 py-0.5 text-[10px] font-bold text-white tabular-nums">
            {pending.length}
          </span>
        )}
      </div>

      {pending.length > 0 && (
        <div className="space-y-3">
          {pending.map(rec => (
            <PaidRecCard key={rec.id} rec={rec} canAction={canAction} />
          ))}
        </div>
      )}

      {approved.length > 0 && (
        <div className="space-y-3 mt-4">
          {pending.length > 0 && (
            <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">Recently approved</div>
          )}
          {approved.map(rec => (
            <PaidRecCard key={rec.id} rec={rec} canAction={false} />
          ))}
        </div>
      )}
    </div>
  )
}
