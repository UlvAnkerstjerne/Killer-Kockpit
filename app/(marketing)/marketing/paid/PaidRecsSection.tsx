'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approvePaidRecommendation, dismissPaidRecommendation } from '@/lib/actions/marketing/paid-recommendations'
import type { PaidRecommendationRow } from '@/lib/marketing/paid-recs/types'

function urgencyBadge(urgency: string) {
  const styles: Record<string, string> = {
    high:   'bg-red-100 text-red-700',
    medium: 'bg-kk-bad-bg text-kk-bad',
    low:    'bg-kk-line text-kk-muted',
  }
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[urgency] ?? styles.low}`}>
      {urgency}
    </span>
  )
}

function signalLabel(type: string): string {
  return ({
    spend_no_results:   'Spending with no results',
    cpr_worsening:      'Cost per result worsening',
    cpr_improving:      'Cost per result improving',
    strong_performance: 'Strong performance',
  } as Record<string, string>)[type] ?? type
}

function formatCpr(value: number | null, currency: string | null, resultLabel: string | null): string {
  if (value === null) return '—'
  const curr = currency ?? 'DKK'
  const label = resultLabel === 'Impressions' ? '/1k impr.' : '/result'
  return `${value.toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${curr}${label}`
}

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

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-kk-muted">{platformLabel}</span>
            <span className="text-xs text-kk-muted">·</span>
            <span className="text-xs text-kk-muted">{signalLabel(rec.signal_type)}</span>
            <span className="text-xs text-kk-muted">·</span>
            {urgencyBadge(rec.urgency)}
          </div>
          <p className="text-sm font-medium text-kk-ink mt-1">{rec.what_changed}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-kk-muted mb-0.5">Evidence</div>
          <div className="text-kk-ink">{rec.evidence}</div>
        </div>
        <div>
          <div className="text-kk-muted mb-0.5">Interpretation</div>
          <div className="text-kk-ink">{rec.interpretation}</div>
        </div>
        <div>
          <div className="text-kk-muted mb-0.5">Recommended action</div>
          <div className="text-kk-ink font-medium">{rec.recommended_action}</div>
        </div>
      </div>

      {rec.status === 'needs_review' && canAction && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleApprove}
            disabled={isPending}
            className="rounded-lg bg-kk-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            Approve
          </button>
          <button
            onClick={handleDismiss}
            disabled={isPending}
            className="rounded-lg border border-kk-line px-3 py-1.5 text-xs font-medium text-kk-muted hover:bg-kk-line/30 disabled:opacity-50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {rec.status === 'approved' && (
        <div className="text-xs text-kk-muted">
          Approved{rec.reviewed_at ? ` · ${new Date(rec.reviewed_at).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen' })}` : ''}
        </div>
      )}
    </div>
  )
}

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
    <div className="mb-8 space-y-3">
      <h2 className="text-base font-semibold text-kk-ink">Recommendations</h2>

      {pending.length > 0 && (
        <div className="space-y-3">
          {pending.map(rec => (
            <PaidRecCard key={rec.id} rec={rec} canAction={canAction} />
          ))}
        </div>
      )}

      {approved.length > 0 && (
        <div className="space-y-3">
          {pending.length > 0 && (
            <div className="text-xs text-kk-muted pt-2">Recently approved</div>
          )}
          {approved.map(rec => (
            <PaidRecCard key={rec.id} rec={rec} canAction={false} />
          ))}
        </div>
      )}
    </div>
  )
}
