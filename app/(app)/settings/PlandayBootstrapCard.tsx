'use client'

import { useState, useTransition, useMemo, useRef } from 'react'
import {
  previewPlandayBootstrap,
  savePlandayCredentials,
} from '@/lib/actions/planday-bootstrap'
import { executeBootstrapImport } from '@/lib/actions/planday-import'
import { runPlandaySync } from '@/lib/actions/planday-sync'
import type { PlandayConnectionStatus } from '@/lib/planday/auth'
import type {
  ReconciliationResult,
  ReconciliationState,
  ImportDecision,
  ImportDecisionAction,
  ImportResult,
  SyncResult,
} from '@/lib/planday/types'
import type { PlandayPreviewResult } from '@/lib/actions/planday-bootstrap'

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<ReconciliationState, string> = {
  ALREADY_LINKED:       'Linked',
  EXACT_NAME_CANDIDATE: 'Candidate',
  NEW_PERSON:           'New',
  AMBIGUOUS:            'Ambiguous',
}

const STATE_CLASS: Record<ReconciliationState, string> = {
  ALREADY_LINKED:       'bg-kk-good-bg text-kk-good',
  EXACT_NAME_CANDIDATE: 'bg-amber-50 text-amber-700',
  NEW_PERSON:           'bg-blue-50 text-blue-700',
  AMBIGUOUS:            'bg-red-50 text-red-700',
}

type TabKey = 'all' | 'active' | 'former' | 'candidates' | 'new' | 'needs_attention'

// ─── Employee picker ──────────────────────────────────────────────────────────

function EmployeePicker({
  value,
  onChange,
  employees,
}: {
  value: string
  onChange: (id: string) => void
  employees: { id: string; name: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const filtered = useMemo(
    () =>
      query.trim()
        ? employees.filter((e) =>
            e.name.toLowerCase().includes(query.toLowerCase()),
          )
        : employees,
    [query, employees],
  )

  const selected = employees.find((e) => e.id === value)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left text-xs px-2 py-1 bg-kk-soft border border-kk-line rounded-lg truncate"
      >
        {selected ? selected.name : 'Select employee…'}
      </button>

      {open && (
        <div className="absolute z-20 left-0 top-full mt-1 w-56 bg-white border border-kk-line rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-kk-line">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full text-xs px-2 py-1 border border-kk-line rounded-lg focus:outline-none"
            />
          </div>
          <ul className="max-h-40 overflow-y-auto divide-y divide-kk-line">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-kk-muted">No match</li>
            )}
            {filtered.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(e.id)
                    setOpen(false)
                    setQuery('')
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-kk-soft transition-colors"
                >
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Action selector for one row ──────────────────────────────────────────────

function ActionCell({
  result,
  action,
  linkedEmployeeId,
  onAction,
  onLinked,
  employees,
}: {
  result: ReconciliationResult
  action: ImportDecisionAction
  linkedEmployeeId: string
  onAction: (a: ImportDecisionAction) => void
  onLinked: (id: string) => void
  employees: { id: string; name: string }[]
}) {
  if (result.state === 'ALREADY_LINKED') {
    return <span className="text-xs text-kk-muted">—</span>
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {(['CREATE_NEW', 'LINK_EXISTING', 'SKIP'] as const).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => onAction(a)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
              action === a
                ? 'bg-kk-ink text-white border-kk-ink'
                : 'bg-white text-kk-muted border-kk-line hover:border-kk-ink hover:text-kk-ink'
            }`}
          >
            {a === 'CREATE_NEW' ? 'Create' : a === 'LINK_EXISTING' ? 'Link' : 'Skip'}
          </button>
        ))}
      </div>
      {action === 'LINK_EXISTING' && (
        <EmployeePicker
          value={linkedEmployeeId}
          onChange={onLinked}
          employees={employees}
        />
      )}
    </div>
  )
}

// ─── Confirm modal ────────────────────────────────────────────────────────────

function ConfirmModal({
  decisions,
  alreadyLinked: linked,
  onConfirm,
  onCancel,
  isLoading,
}: {
  decisions: Map<string, ImportDecisionAction>
  alreadyLinked: number
  onConfirm: () => void
  onCancel: () => void
  isLoading: boolean
}) {
  const counts = { CREATE_NEW: 0, LINK_EXISTING: 0, SKIP: 0 }
  for (const a of decisions.values()) counts[a]++

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-80 space-y-4">
        <h3 className="font-semibold text-kk-ink">Confirm import</h3>

        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-kk-muted">Already linked</span>
            <span className="font-medium">{linked}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-kk-muted">Create new</span>
            <span className="font-medium text-blue-700">{counts.CREATE_NEW}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-kk-muted">Link existing</span>
            <span className="font-medium text-amber-700">{counts.LINK_EXISTING}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-kk-muted">Skip</span>
            <span className="font-medium text-kk-muted">{counts.SKIP}</span>
          </div>
        </div>

        <p className="text-xs text-kk-muted">
          This cannot be undone. All employees marked Create or Link will be
          written to Kockpit in a single atomic transaction.
        </p>

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="px-3 py-1.5 text-sm rounded-xl border border-kk-line text-kk-ink hover:bg-kk-soft transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="px-3 py-1.5 text-sm rounded-xl bg-kk-ink text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {isLoading ? 'Importing…' : 'Confirm import'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PlandayBootstrapCard({
  initialStatus,
  kkEmployees,
}: {
  initialStatus: PlandayConnectionStatus
  kkEmployees: { id: string; name: string }[]
}) {
  const [status, setStatus] = useState(initialStatus)
  const [preview, setPreview] = useState<PlandayPreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [credError, setCredError] = useState<string | null>(null)
  const [credSaved, setCredSaved] = useState(false)
  const [showCredForm, setShowCredForm] = useState(!initialStatus.connected)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  // per-row decision: externalId → action
  const [decisions, setDecisions] = useState<Map<string, ImportDecisionAction>>(new Map())
  // per-row link: externalId → existingEmployeeId
  const [linkedIds, setLinkedIds] = useState<Map<string, string>>(new Map())

  const [tab, setTab] = useState<TabKey>('all')
  const [search, setSearch] = useState('')

  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(
    initialStatus.connected ? initialStatus.lastSyncAt : null,
  )
  const [lastSyncStatus, setLastSyncStatus] = useState<'success' | 'error' | null>(
    initialStatus.connected ? initialStatus.lastSyncStatus : null,
  )

  const [isPreviewing, startPreview] = useTransition()
  const [isSaving, startSaving] = useTransition()
  const [isImporting, startImporting] = useTransition()
  const [isSyncing, startSync] = useTransition()

  // ── Default decisions when preview loads ────────────────────────────────────
  function applyDefaultDecisions(results: ReconciliationResult[]) {
    const newDecisions = new Map<string, ImportDecisionAction>()
    const newLinked    = new Map<string, string>()

    for (const r of results) {
      if (r.state === 'ALREADY_LINKED') continue

      if (r.state === 'EXACT_NAME_CANDIDATE' && r.matchedEmployeeId) {
        newDecisions.set(r.record.externalId, 'LINK_EXISTING')
        newLinked.set(r.record.externalId, r.matchedEmployeeId)
      } else if (r.state === 'NEW_PERSON') {
        newDecisions.set(r.record.externalId, 'CREATE_NEW')
      } else {
        // AMBIGUOUS — default to SKIP; user must resolve
        newDecisions.set(r.record.externalId, 'SKIP')
      }
    }

    setDecisions(newDecisions)
    setLinkedIds(newLinked)
  }

  function handleRunPreview() {
    setPreviewError(null)
    setImportResult(null)
    setImportError(null)
    startPreview(async () => {
      const result = await previewPlandayBootstrap()
      if (result.error) {
        setPreviewError(result.error)
      } else if (result.data) {
        setPreview(result.data)
        setStatus({ connected: true as const, portalId: null, portalName: result.data.portalName, lastSyncAt, lastSyncStatus, lastSyncError: null })
        applyDefaultDecisions(result.data.results)
      }
    })
  }

  function handleSaveCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCredError(null)
    setCredSaved(false)
    const fd           = new FormData(e.currentTarget)
    const clientId     = (fd.get('client_id')    as string) ?? ''
    const refreshToken = (fd.get('refresh_token') as string) ?? ''
    startSaving(async () => {
      const result = await savePlandayCredentials(clientId, refreshToken)
      if (result.error) {
        setCredError(result.error)
      } else {
        setCredSaved(true)
        setStatus({ connected: true as const, portalId: null, portalName: null, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null })
        setShowCredForm(false)
      }
    })
  }

  function handleImport() {
    setImportError(null)

    // Validate: all LINK_EXISTING rows must have an employee selected
    const missing = [...decisions.entries()].filter(
      ([extId, action]) => action === 'LINK_EXISTING' && !linkedIds.get(extId),
    )
    if (missing.length) {
      setImportError(`${missing.length} row(s) set to "Link" but no employee selected.`)
      return
    }

    setShowConfirm(true)
  }

  function handleConfirmImport() {
    const decisionList: ImportDecision[] = []

    if (preview) {
      for (const r of preview.results) {
        if (r.state === 'ALREADY_LINKED') continue
        const action = decisions.get(r.record.externalId) ?? 'SKIP'
        decisionList.push({
          externalId:         r.record.externalId,
          action,
          existingEmployeeId: action === 'LINK_EXISTING'
            ? linkedIds.get(r.record.externalId)
            : undefined,
        })
      }
    }

    startImporting(async () => {
      const result = await executeBootstrapImport(decisionList)
      setShowConfirm(false)
      if (result.error) {
        setImportError(result.error)
      } else if (result.data) {
        setImportResult(result.data)
        setPreview(null)
        setDecisions(new Map())
        setLinkedIds(new Map())
      }
    })
  }

  function handleSync() {
    setSyncError(null)
    setSyncResult(null)
    startSync(async () => {
      const result = await runPlandaySync()
      const now = new Date().toISOString()
      if (result.error) {
        setSyncError(result.error)
        setLastSyncAt(now)
        setLastSyncStatus('error')
      } else if (result.data) {
        setSyncResult(result.data)
        setLastSyncAt(now)
        setLastSyncStatus('success')
      }
    })
  }

  // ── Filtering ────────────────────────────────────────────────────────────────
  const filteredResults = useMemo(() => {
    if (!preview) return []
    let rows = preview.results

    if (tab === 'active')       rows = rows.filter((r) => r.record.sourceStatus === 'active')
    if (tab === 'former')       rows = rows.filter((r) => r.record.sourceStatus === 'left')
    if (tab === 'candidates')   rows = rows.filter((r) => r.state === 'EXACT_NAME_CANDIDATE')
    if (tab === 'new')          rows = rows.filter((r) => r.state === 'NEW_PERSON')
    if (tab === 'needs_attention') rows = rows.filter(
      (r) => r.state === 'AMBIGUOUS' ||
        (r.state === 'EXACT_NAME_CANDIDATE' && decisions.get(r.record.externalId) === 'SKIP') ||
        (decisions.get(r.record.externalId) === 'LINK_EXISTING' && !linkedIds.get(r.record.externalId)),
    )

    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter((r) => r.record.name.toLowerCase().includes(q))
    }

    return rows
  }, [preview, tab, search, decisions, linkedIds])

  // ── Summary counts ────────────────────────────────────────────────────────────
  const summaryCounts = useMemo(() => {
    const counts: Record<ReconciliationState, number> = {
      ALREADY_LINKED: 0, EXACT_NAME_CANDIDATE: 0, NEW_PERSON: 0, AMBIGUOUS: 0,
    }
    if (!preview) return counts
    for (const r of preview.results) counts[r.state]++
    return counts
  }, [preview])

  // ── Live decision tallies ─────────────────────────────────────────────────────
  const decisionTally = useMemo(() => {
    let create = 0, link = 0, skip = 0
    for (const a of decisions.values()) {
      if (a === 'CREATE_NEW') create++
      else if (a === 'LINK_EXISTING') link++
      else skip++
    }
    return { create, link, skip }
  }, [decisions])

  const needsAttentionCount = useMemo(() => {
    if (!preview) return 0
    return preview.results.filter((r) =>
      r.state === 'AMBIGUOUS' ||
      (r.state === 'EXACT_NAME_CANDIDATE' && decisions.get(r.record.externalId) === 'SKIP') ||
      (decisions.get(r.record.externalId) === 'LINK_EXISTING' && !linkedIds.get(r.record.externalId)),
    ).length
  }, [preview, decisions, linkedIds])

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'all',             label: 'All' },
    { key: 'active',          label: 'Active' },
    { key: 'former',          label: 'Former' },
    { key: 'candidates',      label: 'Candidates', count: summaryCounts.EXACT_NAME_CANDIDATE },
    { key: 'new',             label: 'New',        count: summaryCounts.NEW_PERSON },
    { key: 'needs_attention', label: 'Needs attention', count: needsAttentionCount || undefined },
  ]

  return (
    <>
      {showConfirm && preview && (
        <ConfirmModal
          decisions={decisions}
          alreadyLinked={summaryCounts.ALREADY_LINKED}
          onConfirm={handleConfirmImport}
          onCancel={() => setShowConfirm(false)}
          isLoading={isImporting}
        />
      )}

      <div className="bg-kk-panel border border-kk-line rounded-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-kk-line">
          <h2 className="text-sm font-semibold text-kk-ink">Planday Bootstrap</h2>
          <p className="text-xs text-kk-muted mt-0.5">
            Preview Planday roster, review each employee, then import.
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                status.connected ? 'bg-kk-good' : 'bg-kk-muted'
              }`}
            />
            <span className="text-sm text-kk-ink font-medium">
              {status.connected
                ? status.portalName
                  ? `Connected — ${status.portalName}`
                  : 'Credentials stored'
                : 'Not configured'}
            </span>
            {status.connected && (
              <button
                onClick={() => setShowCredForm((v) => !v)}
                className="ml-auto text-xs text-kk-muted hover:text-kk-ink transition-colors"
              >
                {showCredForm ? 'Cancel' : 'Update credentials'}
              </button>
            )}
          </div>

          {/* Credential form */}
          {showCredForm && (
            <form onSubmit={handleSaveCredentials} className="space-y-3 pt-1">
              <p className="text-xs text-kk-muted">
                Obtain credentials from your Planday portal:{' '}
                <span className="font-medium text-kk-ink">Settings → Integrations → API Access</span>.
              </p>
              {credError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
                  {credError}
                </div>
              )}
              {credSaved && (
                <div className="p-3 rounded-xl bg-kk-good-bg border border-kk-good text-xs text-kk-good">
                  Credentials saved.
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-kk-ink mb-1">Client ID</label>
                <input
                  name="client_id"
                  required
                  autoComplete="off"
                  placeholder="planday-client-id"
                  className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-kk-ink mb-1">Refresh Token</label>
                <input
                  name="refresh_token"
                  required
                  autoComplete="off"
                  type="password"
                  placeholder="••••••••••••"
                  className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
                />
              </div>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {isSaving ? 'Saving…' : 'Save credentials'}
              </button>
            </form>
          )}

          {/* Errors */}
          {previewError && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {previewError}
            </div>
          )}
          {importError && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {importError}
            </div>
          )}

          {/* Import result */}
          {importResult && (
            <div className="p-4 rounded-xl bg-kk-good-bg border border-kk-good space-y-2">
              <p className="text-sm font-semibold text-kk-good">Import complete</p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center">
                  <div className="text-lg font-black text-kk-ink">{importResult.created}</div>
                  <div className="text-kk-muted">Created</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-black text-kk-ink">{importResult.linked}</div>
                  <div className="text-kk-muted">Linked</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-black text-kk-ink">{importResult.skipped}</div>
                  <div className="text-kk-muted">Skipped</div>
                </div>
              </div>
              {(importResult.active_new > 0 || importResult.former_new > 0) && (
                <p className="text-xs text-kk-muted">
                  {importResult.active_new} active · {importResult.former_new} former created
                </p>
              )}
            </div>
          )}

          {/* Sync section */}
          {status.connected && !showCredForm && (
            <div className="pt-1 space-y-3">
              {/* Last sync metadata */}
              {lastSyncAt && (
                <div className="flex items-center gap-2 text-xs text-kk-muted">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      lastSyncStatus === 'success' ? 'bg-kk-good' : 'bg-red-500'
                    }`}
                  />
                  <span>
                    Last sync{' '}
                    {new Date(lastSyncAt).toLocaleString('en-GB', {
                      day: 'numeric', month: 'short',
                      hour: '2-digit', minute: '2-digit',
                    })}
                    {lastSyncStatus === 'error' && ' — failed'}
                  </span>
                </div>
              )}

              {/* Sync error */}
              {syncError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
                  {syncError}
                </div>
              )}

              {/* Sync result */}
              {syncResult && (
                <div className="p-3 rounded-xl bg-kk-good-bg border border-kk-good space-y-1.5">
                  <p className="text-xs font-semibold text-kk-good">Sync complete</p>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs text-kk-muted">
                    <span><span className="font-medium text-kk-ink">{syncResult.namesUpdated}</span> names updated</span>
                    <span><span className="font-medium text-kk-ink">{syncResult.activated}</span> reactivated</span>
                    <span><span className="font-medium text-kk-ink">{syncResult.markedLeft}</span> marked left</span>
                    <span><span className="font-medium text-kk-ink">{syncResult.mappedProcessed}</span> mapped</span>
                    <span><span className="font-medium text-kk-ink">{syncResult.unmappedCount}</span> unmapped</span>
                    {syncResult.manualInactivePreserved > 0 && (
                      <span><span className="font-medium text-kk-ink">{syncResult.manualInactivePreserved}</span> inactive preserved</span>
                    )}
                  </div>
                  {syncResult.unmappedCount > 0 && (
                    <p className="text-xs text-amber-700">
                      {syncResult.unmappedCount} Planday employee{syncResult.unmappedCount !== 1 ? 's' : ''} not yet mapped — run preview to import.
                    </p>
                  )}
                </div>
              )}

              {/* Sync now button */}
              <button
                onClick={handleSync}
                disabled={isSyncing}
                className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {isSyncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          )}

          {/* Divider */}
          {status.connected && !showCredForm && (
            <div className="border-t border-kk-line pt-3" />
          )}

          {/* Run preview button */}
          {status.connected && !showCredForm && (
            <button
              onClick={handleRunPreview}
              disabled={isPreviewing}
              className="px-4 py-2 bg-kk-soft text-kk-ink text-sm font-medium rounded-xl border border-kk-line hover:bg-kk-line transition-colors disabled:opacity-40"
            >
              {isPreviewing
                ? 'Fetching Planday…'
                : importResult
                  ? 'Run preview again'
                  : 'Run preview'}
            </button>
          )}

          {/* Preview results */}
          {preview && (
            <div className="space-y-4">
              {/* Timestamp + total */}
              <div className="text-xs text-kk-muted">
                Fetched at{' '}
                {new Date(preview.fetchedAt).toLocaleString('en-GB', {
                  day: 'numeric', month: 'short', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
                {' '}·{' '}{preview.totalFetched} total
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ['ALREADY_LINKED',       'Already linked'],
                    ['EXACT_NAME_CANDIDATE', 'Name match'],
                    ['NEW_PERSON',           'New'],
                    ['AMBIGUOUS',            'Ambiguous'],
                  ] as const
                ).map(([state, label]) => (
                  <div key={state} className="bg-kk-soft rounded-xl px-3 py-2 text-center">
                    <div className="text-lg font-black text-kk-ink">
                      {summaryCounts[state]}
                    </div>
                    <div className="text-xs text-kk-muted">{label}</div>
                  </div>
                ))}
              </div>

              {/* Live decision tally */}
              <div className="flex gap-4 text-xs text-kk-muted">
                <span><span className="font-semibold text-blue-700">{decisionTally.create}</span> create</span>
                <span><span className="font-semibold text-amber-700">{decisionTally.link}</span> link</span>
                <span><span className="font-semibold text-kk-muted">{decisionTally.skip}</span> skip</span>
                {needsAttentionCount > 0 && (
                  <span className="ml-auto text-red-600 font-medium">
                    {needsAttentionCount} need attention
                  </span>
                )}
              </div>

              {/* Filter bar */}
              <div className="flex flex-col gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name…"
                  className="w-full text-xs px-3 py-1.5 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none"
                />
                <div className="flex flex-wrap gap-1">
                  {tabs.map(({ key, label, count }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTab(key)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                        tab === key
                          ? 'bg-kk-ink text-white'
                          : 'bg-kk-soft text-kk-muted hover:text-kk-ink'
                      }`}
                    >
                      {label}
                      {count != null && count > 0 && (
                        <span className="ml-1 opacity-70">{count}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Roster table */}
              <div className="border border-kk-line rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-kk-soft sticky top-0 z-10">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-kk-ink">Planday name</th>
                        <th className="text-left px-3 py-2 font-semibold text-kk-ink">Status</th>
                        <th className="text-left px-3 py-2 font-semibold text-kk-ink">Match</th>
                        <th className="text-left px-3 py-2 font-semibold text-kk-ink">Kockpit match</th>
                        <th className="text-left px-3 py-2 font-semibold text-kk-ink">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-kk-line">
                      {filteredResults.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-3 py-4 text-center text-kk-muted">
                            No rows match.
                          </td>
                        </tr>
                      )}
                      {filteredResults.map((r) => {
                        const extId  = r.record.externalId
                        const action = decisions.get(extId) ?? 'SKIP'
                        return (
                          <tr key={extId} className="hover:bg-kk-soft/50 transition-colors">
                            <td className="px-3 py-2 font-medium text-kk-ink">{r.record.name}</td>
                            <td className="px-3 py-2 text-kk-muted capitalize">
                              {r.record.sourceStatus}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-medium ${STATE_CLASS[r.state]}`}
                              >
                                {STATE_LABEL[r.state]}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-kk-muted">
                              {r.matchedEmployeeName ?? '—'}
                            </td>
                            <td className="px-3 py-2">
                              <ActionCell
                                result={r}
                                action={action}
                                linkedEmployeeId={linkedIds.get(extId) ?? ''}
                                onAction={(a) =>
                                  setDecisions((prev) => new Map(prev).set(extId, a))
                                }
                                onLinked={(id) =>
                                  setLinkedIds((prev) => new Map(prev).set(extId, id))
                                }
                                employees={kkEmployees}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Import button */}
              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-kk-muted">
                  Review decisions above, then confirm to write to Kockpit.
                </p>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={isImporting || decisions.size === 0}
                  className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  Confirm import
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
