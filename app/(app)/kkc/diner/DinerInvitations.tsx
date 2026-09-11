'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createDinerInvitation, cancelDinerInvitation } from '@/lib/actions/diner-invitations'
import type { DinerInvitationRow } from './page'

// ─── Constants ────────────────────────────────────────────────────────────────

const LOCATIONS = [
  { id: '3dc58270-f9e0-49e2-8341-1c78be950dae', name: 'Borgergade' },
  { id: 'fc7fa67f-dc59-46a1-947c-f8519b642b32', name: 'Christianshavn' },
  { id: 'ac7dd67c-cc32-4bb2-aac4-295a390ea33f', name: 'Frederiksberg' },
  { id: '1052d6ff-22b9-43a8-b954-588c67380f5e', name: 'Vesterbro' },
  { id: '84e5038b-acbe-48e6-b74c-dc55bed32462', name: 'Fisketorvet' },
  { id: '06eb4453-db78-4ee7-ab0e-51b3452b3825', name: 'Nørrebro' },
]

const EXPIRY_OPTIONS = [
  { value: 24,  label: '24 hours' },
  { value: 48,  label: '48 hours' },
  { value: 72,  label: '72 hours (default)' },
  { value: 168, label: '7 days' },
]

// ─── Status badge ─────────────────────────────────────────────────────────────

type InvStatus = 'pending' | 'active' | 'submitted' | 'expired'

const STATUS_LABEL: Record<InvStatus, string> = {
  pending:   'Pending',
  active:    'Active',
  submitted: 'Submitted',
  expired:   'Expired',
}

const STATUS_CLS: Record<InvStatus, string> = {
  pending:   'bg-kk-warn-bg text-kk-warn border-kk-warn',
  active:    'bg-blue-50 text-blue-600 border-blue-300',
  submitted: 'bg-kk-good-bg text-kk-good border-kk-good',
  expired:   'bg-kk-soft text-kk-muted border-kk-line',
}

function StatusBadge({ status }: { status: InvStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_CLS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('da-DK', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── Create Invitation Modal ──────────────────────────────────────────────────

interface CreateModalProps {
  onClose: () => void
  onCreated: () => void
}

function CreateInvitationModal({ onClose, onCreated }: CreateModalProps) {
  const [isPending, startTransition] = useTransition()
  const [locationId, setLocationId]     = useState('')
  const [dinerName, setDinerName]       = useState('')
  const [dinerEmail, setDinerEmail]     = useState('')
  const [expiresIn, setExpiresIn]       = useState(72)
  const [error, setError]               = useState<string | null>(null)
  const [createdUrl, setCreatedUrl]     = useState<string | null>(null)
  const [copied, setCopied]             = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await createDinerInvitation({
        dinerName,
        dinerEmail: dinerEmail.trim() || null,
        locationId: locationId || null,
        expiresInHours: expiresIn,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setCreatedUrl(result.data!.inviteUrl)
    })
  }

  async function handleCopy() {
    if (!createdUrl) return
    try {
      await navigator.clipboard.writeText(createdUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback — select input text
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(23,23,23,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (!createdUrl && e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-kk-panel border border-kk-line rounded-2xl shadow-2xl w-full max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-diner-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
          <h2 id="create-diner-title" className="text-base font-bold text-kk-ink">
            New Mystery Diner Invitation
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-kk-muted hover:text-kk-ink transition-colors rounded-lg"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {createdUrl ? (
          /* ── Success: show invite URL once ── */
          <div className="px-5 py-5 space-y-4">
            <div className="bg-kk-good-bg border border-kk-good rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-kk-good mb-1">Invitation created</p>
              <p className="text-xs text-kk-muted">
                Copy this link and send it to the diner. It will not be shown again.
              </p>
            </div>

            <div className="flex gap-2">
              <input
                readOnly
                value={createdUrl}
                className="flex-1 min-w-0 text-xs bg-kk-soft border border-kk-line rounded-xl px-3 py-2.5 text-kk-ink font-mono outline-none"
                onFocus={e => e.target.select()}
              />
              <button
                onClick={handleCopy}
                className="shrink-0 px-3 py-2.5 bg-kk-ink text-white text-xs font-semibold rounded-xl hover:opacity-80 transition-opacity"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <button
              onClick={() => { onCreated(); onClose() }}
              className="w-full py-2.5 text-sm bg-kk-ink text-white font-semibold rounded-xl hover:opacity-80 transition-opacity"
            >
              Done
            </button>
          </div>
        ) : (
          /* ── Create form ── */
          <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
            {/* Location */}
            <div>
              <label htmlFor="diner-location" className="block text-xs font-semibold text-kk-ink mb-1.5">
                Location
              </label>
              <select
                id="diner-location"
                value={locationId}
                onChange={e => setLocationId(e.target.value)}
                disabled={isPending}
                className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink disabled:opacity-50"
              >
                <option value="">No specific location</option>
                {LOCATIONS.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>

            {/* Diner name */}
            <div>
              <label htmlFor="diner-name" className="block text-xs font-semibold text-kk-ink mb-1.5">
                Diner name <span className="text-kk-bad">*</span>
              </label>
              <input
                id="diner-name"
                type="text"
                value={dinerName}
                onChange={e => setDinerName(e.target.value)}
                placeholder="Full name"
                maxLength={100}
                disabled={isPending}
                required
                autoFocus
                className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink placeholder:text-kk-muted disabled:opacity-50"
              />
            </div>

            {/* Email (optional) */}
            <div>
              <label htmlFor="diner-email" className="block text-xs font-semibold text-kk-ink mb-1.5">
                Email <span className="text-kk-muted font-normal">(optional)</span>
              </label>
              <input
                id="diner-email"
                type="email"
                value={dinerEmail}
                onChange={e => setDinerEmail(e.target.value)}
                placeholder="diner@example.com"
                maxLength={200}
                disabled={isPending}
                className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink placeholder:text-kk-muted disabled:opacity-50"
              />
            </div>

            {/* Expiry */}
            <div>
              <label htmlFor="diner-expiry" className="block text-xs font-semibold text-kk-ink mb-1.5">
                Link valid for
              </label>
              <select
                id="diner-expiry"
                value={expiresIn}
                onChange={e => setExpiresIn(Number(e.target.value))}
                disabled={isPending}
                className="w-full text-sm bg-white border border-kk-line rounded-xl px-3 py-2.5 outline-none focus:border-kk-ink transition-colors text-kk-ink disabled:opacity-50"
              >
                {EXPIRY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {error && (
              <p className="text-xs text-kk-bad">{error}</p>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={isPending}
                className="flex-1 py-2.5 text-sm border border-kk-line rounded-xl text-kk-muted hover:text-kk-ink hover:border-kk-ink transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending || !dinerName.trim()}
                className="flex-1 py-2.5 text-sm bg-kk-ink text-white font-semibold rounded-xl disabled:opacity-40 hover:opacity-80 transition-opacity"
              >
                {isPending ? 'Creating…' : 'Create invitation'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Cancel confirm modal ─────────────────────────────────────────────────────

interface CancelModalProps {
  invitation: DinerInvitationRow
  onClose: () => void
  onCancelled: () => void
}

function CancelInvitationModal({ invitation, onClose, onCancelled }: CancelModalProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleCancel() {
    startTransition(async () => {
      const result = await cancelDinerInvitation(invitation.id)
      if (result.error) { setError(result.error); return }
      onCancelled()
      onClose()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(23,23,23,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-kk-panel border border-kk-line rounded-2xl shadow-2xl w-full max-w-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-diner-title"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
          <h2 id="cancel-diner-title" className="text-base font-bold text-kk-ink">
            Cancel invitation
          </h2>
          <button onClick={onClose} className="p-1.5 text-kk-muted hover:text-kk-ink transition-colors rounded-lg" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-kk-ink">
            Cancel the invitation for <strong>{invitation.diner_name}</strong>?
            The link will immediately stop working.
          </p>
          {error && <p className="text-xs text-kk-bad">{error}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="flex-1 py-2.5 text-sm border border-kk-line rounded-xl text-kk-muted hover:text-kk-ink hover:border-kk-ink transition-colors disabled:opacity-40"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isPending}
              className="flex-1 py-2.5 text-sm bg-kk-bad text-white font-semibold rounded-xl disabled:opacity-40 hover:opacity-80 transition-opacity"
            >
              {isPending ? 'Cancelling…' : 'Cancel invitation'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  invitations: DinerInvitationRow[]
}

export default function DinerInvitations({ invitations: initial }: Props) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<DinerInvitationRow | null>(null)

  function refresh() {
    router.refresh()
  }

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-kk-ink">Mystery Diner</h1>
          <p className="text-sm text-kk-muted mt-0.5">Manage mystery diner invitations</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-kk-ink text-white text-sm font-semibold rounded-xl hover:opacity-80 transition-opacity"
        >
          New invitation
        </button>
      </div>

      {/* Invitations table */}
      <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
        {initial.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-kk-muted">No invitations yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-kk-line">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Diner</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Location</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Expires</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Submitted</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-kk-muted">Score</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-kk-line">
                {initial.map(inv => (
                  <tr key={inv.id} className="hover:bg-kk-soft transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-kk-ink">{inv.diner_name}</div>
                      {inv.diner_email && (
                        <div className="text-xs text-kk-muted mt-0.5">{inv.diner_email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-kk-muted">
                      {inv.location_name ?? <span className="italic text-kk-line">—</span>}
                    </td>
                    <td className="px-4 py-3 text-kk-muted whitespace-nowrap">
                      {fmtDate(inv.created_at)}
                    </td>
                    <td className="px-4 py-3 text-kk-muted whitespace-nowrap">
                      {fmtDate(inv.expires_at)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={inv.status} />
                    </td>
                    <td className="px-4 py-3 text-kk-muted whitespace-nowrap">
                      {inv.submitted_at ? fmtDateTime(inv.submitted_at) : <span className="text-kk-line">—</span>}
                    </td>
                    <td className="px-4 py-3 text-kk-muted">
                      {inv.score_pct != null
                        ? <span className="font-semibold text-kk-ink">{inv.score_pct}%</span>
                        : <span className="text-kk-line">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(inv.status === 'pending' || inv.status === 'active') && (
                        <button
                          onClick={() => setCancelTarget(inv)}
                          className="text-xs text-kk-muted hover:text-kk-bad transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateInvitationModal
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      )}
      {cancelTarget && (
        <CancelInvitationModal
          invitation={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={refresh}
        />
      )}
    </div>
  )
}
