'use client'

import { useState } from 'react'
import type { AuditSubmissionRow, AuditHealthStatus, ActiveLocation } from '@/lib/audit/submissions'
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

// ── Component ──────────────────────────────────────────────────────────────────

export default function AuditLanding({ submissions, locations }: Props) {
  const [showModal, setShowModal] = useState(false)

  return (
    <div className="max-w-4xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-kk-ink">Operational Audit</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            Master Operational Audit · {submissions.length} {submissions.length === 1 ? 'audit' : 'audits'}
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-kk-ink text-white text-sm font-semibold rounded-xl hover:opacity-80 transition-opacity"
        >
          + Start new audit
        </button>
      </div>

      {/* List */}
      {submissions.length === 0 ? (
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-6 py-14 text-center">
          <div className="text-sm font-semibold text-kk-ink mb-1">No audits yet</div>
          <div className="text-sm text-kk-muted">Start a new audit to see results here.</div>
        </div>
      ) : (
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
          {/* Table header */}
          <div className="hidden md:grid grid-cols-[1fr_1fr_1fr_auto_auto_auto_auto] gap-4 px-4 py-2.5 border-b border-kk-line text-[11px] font-bold tracking-[0.08em] uppercase text-kk-muted">
            <span>Location</span>
            <span>Auditor</span>
            <span>Date</span>
            <span>Overall</span>
            <span>Core</span>
            <span className="text-center">RF</span>
            <span>Status</span>
          </div>

          <div className="divide-y divide-kk-line">
            {submissions.map(s => (
              <div
                key={s.id}
                className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto_auto_auto_auto] gap-x-4 gap-y-1 px-4 py-3 items-center hover:bg-kk-soft transition-colors"
              >
                <div className="font-semibold text-sm text-kk-ink truncate">{s.location_name}</div>
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
