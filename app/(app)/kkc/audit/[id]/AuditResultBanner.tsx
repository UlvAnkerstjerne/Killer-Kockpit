// Server component — no state needed

const STATUS_LABEL: Record<string, string> = {
  GREEN:       'Green',
  LIGHT_GREEN: 'Light Green',
  YELLOW:      'Yellow',
  ORANGE:      'Orange',
  RED:         'Red',
}

const STATUS_RING_CLS: Record<string, string> = {
  GREEN:       'bg-kk-good-bg border-kk-good text-kk-good',
  LIGHT_GREEN: 'bg-emerald-50 border-emerald-300 text-emerald-700',
  YELLOW:      'bg-kk-warn-bg border-kk-warn text-kk-warn',
  ORANGE:      'bg-orange-50 border-orange-300 text-orange-600',
  RED:         'bg-kk-bad-bg border-kk-bad text-kk-bad',
}

const SCORE_CLS = (pct: number) =>
  pct >= 90 ? 'text-kk-good'
  : pct >= 80 ? 'text-emerald-600'
  : pct >= 70 ? 'text-kk-warn'
  : pct >= 60 ? 'text-orange-500'
  : 'text-kk-bad'

interface Props {
  auditStatus:            string | null
  scorePct:               number | null
  coreScorePct:           number | null
  redFlagCount:           number | null
  managerWarningRequired: boolean
  submittedAt:            string | null
}

export default function AuditResultBanner({
  auditStatus,
  scorePct,
  coreScorePct,
  redFlagCount,
  managerWarningRequired,
  submittedAt,
}: Props) {
  const statusCls = auditStatus ? (STATUS_RING_CLS[auditStatus] ?? 'bg-kk-soft border-kk-line text-kk-muted') : ''
  const statusLabel = auditStatus ? (STATUS_LABEL[auditStatus] ?? auditStatus) : '—'

  const submittedStr = submittedAt
    ? new Date(submittedAt).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : null

  return (
    <div className="max-w-2xl mx-auto">
      <div className={`border rounded-xl overflow-hidden ${statusCls}`}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-current/20">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.08em] opacity-70 mb-0.5">
                Audit submitted
              </p>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold">{statusLabel}</span>
              </div>
            </div>
            {submittedStr && (
              <p className="text-xs opacity-60 shrink-0">{submittedStr}</p>
            )}
          </div>
        </div>

        {/* Scores */}
        <div className="px-5 py-4 grid grid-cols-3 gap-4">
          <div className="text-center">
            <p className="text-xs font-semibold opacity-60 mb-0.5">Overall</p>
            {scorePct !== null ? (
              <p className={`text-2xl font-bold tabular-nums ${SCORE_CLS(scorePct)}`}>
                {scorePct.toFixed(0)}%
              </p>
            ) : (
              <p className="text-xl font-bold opacity-40">—</p>
            )}
          </div>
          <div className="text-center">
            <p className="text-xs font-semibold opacity-60 mb-0.5">Core Standards</p>
            {coreScorePct !== null ? (
              <p className={`text-2xl font-bold tabular-nums ${SCORE_CLS(coreScorePct)}`}>
                {coreScorePct.toFixed(0)}%
              </p>
            ) : (
              <p className="text-xl font-bold opacity-40">—</p>
            )}
          </div>
          <div className="text-center">
            <p className="text-xs font-semibold opacity-60 mb-0.5">Red Flags</p>
            <p className={`text-2xl font-bold tabular-nums ${redFlagCount ? 'text-kk-bad' : 'inherit'}`}>
              {redFlagCount ?? '—'}
            </p>
          </div>
        </div>

        {/* Manager warning */}
        {managerWarningRequired && (
          <div className="mx-5 mb-4 px-3 py-2.5 bg-kk-bad-bg border border-kk-bad/30 rounded-lg">
            <p className="text-xs font-bold text-kk-bad">
              Store Manager notification required — 2 or more Red Flags recorded.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
