'use client'

import React, { useState } from 'react'
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
    ? 'border-kk-ink ring-2 ring-kk-ink ring-offset-1'
    : 'border-kk-line hover:border-kk-muted'

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

// ── Component ──────────────────────────────────────────────────────────────────

export default function AuditLanding({ submissions, locations }: Props) {
  const [showModal, setShowModal] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null)

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

  const listCount = storeAllRows.length
  const subtitle = selectedStore
    ? `${selectedStore.short} · ${listCount} ${listCount === 1 ? 'audit' : 'audits'}`
    : `Master Operational Audit · ${submissions.length} ${submissions.length === 1 ? 'audit' : 'audits'}`

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
          </div>

          {latestSubmitted ? (
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
          <h1 className="text-xl font-bold text-kk-ink">Operational Audit</h1>
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
