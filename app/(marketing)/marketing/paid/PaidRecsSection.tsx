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
        {rec.status === 'approved' && (
          <span className="shrink-0 text-[10px] font-semibold text-kk-good bg-kk-good-bg rounded-full px-2 py-0.5">
            Approved
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

      {/* Actions */}
      {rec.status === 'needs_review' && canAction && (
        <div className="flex gap-2 px-5 py-3 border-t border-kk-line bg-kk-soft/50">
          <button
            onClick={handleApprove}
            disabled={isPending}
            className="rounded-full bg-kk-brand px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            Approve
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

      {rec.status === 'approved' && rec.reviewed_at && (
        <div className="px-5 py-2 border-t border-kk-line text-[10px] text-kk-muted">
          Approved {new Date(rec.reviewed_at).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short', year: 'numeric' })}
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
