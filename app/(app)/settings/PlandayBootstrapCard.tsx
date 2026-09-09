'use client'

import { useState, useTransition } from 'react'
import {
  previewPlandayBootstrap,
  savePlandayCredentials,
} from '@/lib/actions/planday-bootstrap'
import type { PlandayConnectionStatus } from '@/lib/planday/auth'
import type { ReconciliationResult, ReconciliationState } from '@/lib/planday/types'
import type { PlandayPreviewResult } from '@/lib/actions/planday-bootstrap'

// ─── State labels ────────────────────────────────────────────────────────────

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

// ─── Component ───────────────────────────────────────────────────────────────

export default function PlandayBootstrapCard({
  initialStatus,
}: {
  initialStatus: PlandayConnectionStatus
}) {
  const [status, setStatus] = useState(initialStatus)
  const [preview, setPreview] = useState<PlandayPreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [credError, setCredError] = useState<string | null>(null)
  const [credSaved, setCredSaved] = useState(false)
  const [showCredForm, setShowCredForm] = useState(!initialStatus.connected)

  const [isPreviewing, startPreview] = useTransition()
  const [isSaving, startSaving] = useTransition()

  function handleRunPreview() {
    setPreviewError(null)
    startPreview(async () => {
      const result = await previewPlandayBootstrap()
      if (result.error) {
        setPreviewError(result.error)
      } else if (result.data) {
        setPreview(result.data)
        setStatus({ connected: true as const, portalId: null, portalName: result.data.portalName })
      }
    })
  }

  function handleSaveCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCredError(null)
    setCredSaved(false)
    const fd = new FormData(e.currentTarget)
    const clientId    = (fd.get('client_id')    as string) ?? ''
    const refreshToken = (fd.get('refresh_token') as string) ?? ''
    startSaving(async () => {
      const result = await savePlandayCredentials(clientId, refreshToken)
      if (result.error) {
        setCredError(result.error)
      } else {
        setCredSaved(true)
        setStatus({ connected: true as const, portalId: null, portalName: null })
        setShowCredForm(false)
      }
    })
  }

  // Build summary counts
  const counts = preview
    ? preview.results.reduce(
        (acc, r) => {
          acc[r.state] = (acc[r.state] ?? 0) + 1
          return acc
        },
        {} as Record<ReconciliationState, number>,
      )
    : null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      {/* Header */}
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Planday Bootstrap</h2>
        <p className="text-xs text-kk-muted mt-0.5">
          Preview Planday roster against Kockpit employees. No changes are written.
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

        {/* Preview errors */}
        {previewError && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
            {previewError}
          </div>
        )}

        {/* Run preview button */}
        {status.connected && !showCredForm && (
          <button
            onClick={handleRunPreview}
            disabled={isPreviewing}
            className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {isPreviewing ? 'Fetching Planday…' : 'Run preview'}
          </button>
        )}

        {/* Preview results */}
        {preview && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="text-xs text-kk-muted">
              Fetched at{' '}
              {new Date(preview.fetchedAt).toLocaleString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
              {' '}·{' '}{preview.totalFetched} total
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ['ALREADY_LINKED', 'Already linked'],
                  ['EXACT_NAME_CANDIDATE', 'Name match'],
                  ['NEW_PERSON', 'New'],
                  ['AMBIGUOUS', 'Ambiguous'],
                ] as const
              ).map(([state, label]) => (
                <div
                  key={state}
                  className="bg-kk-soft rounded-xl px-3 py-2 text-center"
                >
                  <div className="text-lg font-black text-kk-ink">
                    {counts?.[state] ?? 0}
                  </div>
                  <div className="text-xs text-kk-muted">{label}</div>
                </div>
              ))}
            </div>

            <p className="text-xs text-kk-muted leading-relaxed">
              <span className="font-medium text-kk-ink">Linked</span> — already mapped via external ID.{' '}
              <span className="font-medium text-kk-ink">Name match</span> — unique name match, awaiting review.{' '}
              <span className="font-medium text-kk-ink">New</span> — no match, would create new person.{' '}
              <span className="font-medium text-kk-ink">Ambiguous</span> — multiple name matches, manual resolution needed.
            </p>

            {/* Roster table */}
            <div className="border border-kk-line rounded-xl overflow-hidden">
              <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-kk-soft sticky top-0 z-10">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-kk-ink">Planday name</th>
                      <th className="text-left px-3 py-2 font-semibold text-kk-ink">Status</th>
                      <th className="text-left px-3 py-2 font-semibold text-kk-ink">Match</th>
                      <th className="text-left px-3 py-2 font-semibold text-kk-ink">Kockpit employee</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-kk-line">
                    {preview.results.map((r: ReconciliationResult, i: number) => (
                      <tr key={i} className="hover:bg-kk-soft/50 transition-colors">
                        <td className="px-3 py-2 font-medium text-kk-ink">{r.record.name}</td>
                        <td className="px-3 py-2 text-kk-muted capitalize">{r.record.sourceStatus}</td>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
