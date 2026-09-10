'use client'

import { useState } from 'react'
import { upsertTopAction, deleteTopAction } from '@/lib/actions/audit'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SavedTopAction {
  id:        string
  sortOrder: 1 | 2 | 3
  action:    string
  owner:     string
  deadline:  string  // 'YYYY-MM-DD'
}

type ActionSlot = {
  dbId:      string | null  // null = not yet persisted
  sortOrder: 1 | 2 | 3
  action:    string
  owner:     string
  deadline:  string
  saving:    boolean
}

interface Props {
  submissionId: string
  isReadOnly:   boolean
  initialRows:  SavedTopAction[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SORT_ORDERS = [1, 2, 3] as const

function nextSortOrder(slots: ActionSlot[]): (1 | 2 | 3) | null {
  const used = new Set(slots.map(s => s.sortOrder))
  return SORT_ORDERS.find(n => !used.has(n)) ?? null
}

function formatDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ── Editable row ───────────────────────────────────────────────────────────────

function EditableRow({
  slot,
  onFieldChange,
  onBlurSave,
  onDelete,
}: {
  slot:          ActionSlot
  onFieldChange: (sortOrder: 1 | 2 | 3, field: 'action' | 'owner' | 'deadline', value: string) => void
  onBlurSave:    (sortOrder: 1 | 2 | 3) => void
  onDelete:      (sortOrder: 1 | 2 | 3) => void
}) {
  return (
    <div className="px-4 py-4 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold text-kk-muted uppercase tracking-[0.07em]">
          Action {slot.sortOrder}
        </span>
        <div className="flex items-center gap-2">
          {slot.saving && (
            <span className="text-[10px] text-kk-muted">Saving…</span>
          )}
          <button
            type="button"
            onClick={() => onDelete(slot.sortOrder)}
            className="text-kk-muted hover:text-kk-bad transition-colors text-lg leading-none px-1"
            aria-label={`Remove action ${slot.sortOrder}`}
          >
            ×
          </button>
        </div>
      </div>

      {/* Action */}
      <div>
        <label className="block text-xs text-kk-muted mb-1">Action</label>
        <textarea
          rows={2}
          value={slot.action}
          onChange={e => onFieldChange(slot.sortOrder, 'action', e.target.value)}
          onBlur={() => onBlurSave(slot.sortOrder)}
          placeholder="Describe the action to take…"
          className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 resize-none placeholder:text-kk-muted/60 focus:outline-none focus:ring-1 focus:ring-[#AD3919]/40 focus:border-[#AD3919]/50 transition-colors"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Owner */}
        <div>
          <label className="block text-xs text-kk-muted mb-1">Owner</label>
          <input
            type="text"
            value={slot.owner}
            onChange={e => onFieldChange(slot.sortOrder, 'owner', e.target.value)}
            onBlur={() => onBlurSave(slot.sortOrder)}
            placeholder="Responsible person…"
            className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 placeholder:text-kk-muted/60 focus:outline-none focus:ring-1 focus:ring-[#AD3919]/40 focus:border-[#AD3919]/50 transition-colors"
          />
        </div>

        {/* Deadline */}
        <div>
          <label className="block text-xs text-kk-muted mb-1">Deadline</label>
          <input
            type="date"
            value={slot.deadline}
            onChange={e => onFieldChange(slot.sortOrder, 'deadline', e.target.value)}
            onBlur={() => onBlurSave(slot.sortOrder)}
            className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[#AD3919]/40 focus:border-[#AD3919]/50 transition-colors"
          />
        </div>
      </div>

      {/* Incomplete hint */}
      {(slot.action || slot.owner || slot.deadline) &&
        !(slot.action && slot.owner && slot.deadline) && (
        <p className="text-[11px] text-kk-muted">
          All three fields are required to save this action.
        </p>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AuditTopActions({ submissionId, isReadOnly, initialRows }: Props) {
  const [slots, setSlots] = useState<ActionSlot[]>(() =>
    initialRows.map(r => ({
      dbId:      r.id,
      sortOrder: r.sortOrder,
      action:    r.action,
      owner:     r.owner,
      deadline:  r.deadline,
      saving:    false,
    }))
  )

  // ── Field change (local only) ────────────────────────────────────────────────

  function handleFieldChange(sortOrder: 1 | 2 | 3, field: 'action' | 'owner' | 'deadline', value: string) {
    setSlots(prev => prev.map(s =>
      s.sortOrder === sortOrder ? { ...s, [field]: value } : s
    ))
  }

  // ── Save on blur if all three fields filled ──────────────────────────────────

  async function handleBlurSave(sortOrder: 1 | 2 | 3) {
    const slot = slots.find(s => s.sortOrder === sortOrder)
    if (!slot) return
    if (!slot.action.trim() || !slot.owner.trim() || !slot.deadline) return

    setSlots(prev => prev.map(s => s.sortOrder === sortOrder ? { ...s, saving: true } : s))
    const res = await upsertTopAction(submissionId, sortOrder, slot.action, slot.owner, slot.deadline)
    setSlots(prev => prev.map(s =>
      s.sortOrder === sortOrder
        ? { ...s, saving: false, dbId: res.data?.id ?? s.dbId }
        : s
    ))
  }

  // ── Add ─────────────────────────────────────────────────────────────────────

  function handleAdd() {
    const next = nextSortOrder(slots)
    if (next === null) return
    setSlots(prev => [
      ...prev,
      { dbId: null, sortOrder: next, action: '', owner: '', deadline: '', saving: false },
    ].sort((a, b) => a.sortOrder - b.sortOrder))
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async function handleDelete(sortOrder: 1 | 2 | 3) {
    const slot = slots.find(s => s.sortOrder === sortOrder)
    if (!slot) return

    // Remove from local state immediately
    setSlots(prev => prev.filter(s => s.sortOrder !== sortOrder))

    // Delete from DB only if it was persisted
    if (slot.dbId) {
      await deleteTopAction(submissionId, sortOrder)
    }
  }

  // Sentinel read by AuditSubmitBar to detect partially-filled rows
  const hasPartial = slots.some(s => {
    const hasAny = s.action.trim() || s.owner.trim() || s.deadline
    const hasAll = s.action.trim() && s.owner.trim() && s.deadline
    return Boolean(hasAny && !hasAll)
  })

  // ── Read-only view ───────────────────────────────────────────────────────────

  if (isReadOnly) {
    if (slots.length === 0) return null
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
          <div className="px-4 py-3 border-b border-kk-line bg-kk-soft">
            <h2 className="text-sm font-bold text-kk-ink">Top Actions</h2>
          </div>
          <div className="divide-y divide-kk-line">
            {slots.map(slot => (
              <div key={slot.sortOrder} className="px-5 py-4 space-y-1.5">
                <p className="text-[11px] font-bold text-kk-muted uppercase tracking-[0.07em]">
                  Action {slot.sortOrder}
                </p>
                <p className="text-sm text-kk-ink">{slot.action}</p>
                <div className="flex items-center gap-4 text-sm text-kk-muted">
                  <span>{slot.owner}</span>
                  <span>·</span>
                  <span>{formatDate(slot.deadline)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ── Editable view ────────────────────────────────────────────────────────────

  const canAdd = nextSortOrder(slots) !== null

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
        <div className="px-4 py-3 border-b border-kk-line bg-kk-soft">
          <h2 className="text-sm font-bold text-kk-ink">Top Actions</h2>
          <p className="text-[11px] text-kk-muted mt-0.5">Up to 3 follow-up actions</p>
        </div>

        {slots.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-kk-muted">
            No actions added yet.
          </div>
        ) : (
          <div className="divide-y divide-kk-line">
            {slots.map(slot => (
              <EditableRow
                key={slot.sortOrder}
                slot={slot}
                onFieldChange={handleFieldChange}
                onBlurSave={handleBlurSave}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {canAdd && (
          <div className={`px-4 py-3 ${slots.length > 0 ? 'border-t border-kk-line' : ''}`}>
            <button
              type="button"
              onClick={handleAdd}
              className="text-sm font-semibold text-kk-ink hover:opacity-70 transition-opacity"
            >
              + Add action
            </button>
          </div>
        )}
      </div>
      {/* Sentinel for AuditSubmitBar partial-action check */}
      <span
        id="audit-partial-action-sentinel"
        data-partial={String(hasPartial)}
        className="sr-only"
        aria-hidden="true"
      />
    </div>
  )
}
