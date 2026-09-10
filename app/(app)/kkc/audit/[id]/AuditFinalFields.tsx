'use client'

import { useRef, useState } from 'react'
import { updateAuditFinalField } from '@/lib/actions/audit'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AuditFinalValues {
  finalDoneWell:         string
  finalFocusNext:        string
  finalOverallComments:  string
  finalModInformed:      boolean | null
  finalCorrectiveAction: string
  followUpRequested:     boolean
  followUpDate:          string
}

interface Props {
  submissionId:  string
  isReadOnly:    boolean
  initialValues: AuditFinalValues
}

const DEBOUNCE_MS = 800

// ── Debounced textarea ─────────────────────────────────────────────────────────

function DebouncedTextarea({
  label,
  field,
  submissionId,
  initialValue,
  placeholder,
  required,
}: {
  label:        string
  field:        'final_done_well' | 'final_focus_next' | 'final_overall_comments' | 'final_corrective_action'
  submissionId: string
  initialValue: string
  placeholder?: string
  required?:    boolean
}) {
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function persist(text: string) {
    setSaving(true)
    await updateAuditFinalField(submissionId, { field, value: text })
    setSaving(false)
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value
    setValue(text)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => persist(text), DEBOUNCE_MS)
  }

  function handleBlur() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    persist(value)
  }

  return (
    <div>
      <label className="block text-sm font-semibold text-kk-ink mb-1.5">
        {label}
        {required && <span className="ml-1 text-kk-bad text-xs">*</span>}
        {saving && (
          <span className="ml-2 font-normal text-[10px] text-kk-muted">Saving…</span>
        )}
      </label>
      <textarea
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        rows={3}
        placeholder={placeholder}
        className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 resize-none placeholder:text-kk-muted/60 focus:outline-none focus:ring-1 focus:ring-[#AD3919]/40 focus:border-[#AD3919]/50 transition-colors"
      />
    </div>
  )
}

// ── Yes / No toggle ────────────────────────────────────────────────────────────

function YesNoButtons({
  label,
  value,
  onChange,
  required,
}: {
  label:    string
  value:    boolean | null
  onChange: (next: boolean) => void
  required?: boolean
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-kk-ink mb-1.5">
        {label}
        {required && <span className="ml-1 text-kk-bad text-xs">*</span>}
      </p>
      <div className="flex gap-2">
        {([true, false] as const).map(opt => {
          const isSelected = value === opt
          return (
            <button
              key={String(opt)}
              type="button"
              onClick={() => onChange(opt)}
              aria-pressed={isSelected}
              className={[
                'px-4 py-1.5 rounded-lg border text-sm font-semibold transition-colors',
                isSelected
                  ? opt
                    ? 'bg-kk-good-bg border-kk-good text-kk-good'
                    : 'bg-kk-bad-bg border-kk-bad text-kk-bad'
                  : 'border-kk-line text-kk-muted hover:border-kk-ink hover:text-kk-ink',
              ].join(' ')}
            >
              {opt ? 'Yes' : 'No'}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Read-only helpers ──────────────────────────────────────────────────────────

function ReadOnlyText({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <p className="text-[11px] font-semibold text-kk-muted uppercase tracking-[0.07em] mb-0.5">{label}</p>
      <p className="text-sm text-kk-ink whitespace-pre-wrap">{value}</p>
    </div>
  )
}

function ReadOnlyBool({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) return null
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-kk-muted">{label}</span>
      <span className={`font-semibold ${value ? 'text-kk-good' : 'text-kk-bad'}`}>
        {value ? 'Yes' : 'No'}
      </span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AuditFinalFields({ submissionId, isReadOnly, initialValues }: Props) {
  // Lifted state for fields whose value affects other fields' visibility
  const [modInformed, setModInformed]     = useState<boolean | null>(initialValues.finalModInformed)
  const [followUp, setFollowUp]           = useState(initialValues.followUpRequested)
  const [followUpDate, setFollowUpDate]   = useState(initialValues.followUpDate)
  const [dateSaving, setDateSaving]       = useState(false)

  async function handleModInformed(next: boolean) {
    setModInformed(next)
    await updateAuditFinalField(submissionId, { field: 'final_mod_informed', value: next })
  }

  async function handleFollowUp(next: boolean) {
    setFollowUp(next)
    // Server action clears follow_up_date when toggled off
    await updateAuditFinalField(submissionId, { field: 'follow_up_requested', value: next })
    if (!next) setFollowUpDate('')
  }

  async function handleDateChange(e: React.ChangeEvent<HTMLInputElement>) {
    const date = e.target.value
    setFollowUpDate(date)
    setDateSaving(true)
    await updateAuditFinalField(submissionId, { field: 'follow_up_date', value: date || null })
    setDateSaving(false)
  }

  // ── Read-only view ─────────────────────────────────────────────────────────

  if (isReadOnly) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
          <div className="px-4 py-3 border-b border-kk-line bg-kk-soft">
            <h2 className="text-sm font-bold text-kk-ink">Audit Summary</h2>
          </div>
          <div className="px-5 py-4 space-y-4">
            <ReadOnlyText label="What was done well?" value={initialValues.finalDoneWell} />
            <ReadOnlyText label="Main focus before next audit" value={initialValues.finalFocusNext} />
            <ReadOnlyBool label="Manager on Duty informed" value={initialValues.finalModInformed} />
            <ReadOnlyText label="Overall comments / observations" value={initialValues.finalOverallComments} />
            <ReadOnlyText label="Corrective action taken" value={initialValues.finalCorrectiveAction} />
            {initialValues.followUpRequested && (
              <ReadOnlyBool label="Additional follow-up required" value={true} />
            )}
            {initialValues.followUpDate && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-kk-muted">Follow-up date</span>
                <span className="font-medium text-kk-ink">
                  {new Date(initialValues.followUpDate + 'T00:00:00').toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Editable view ──────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden">
        <div className="px-4 py-3 border-b border-kk-line bg-kk-soft">
          <h2 className="text-sm font-bold text-kk-ink">Audit Summary</h2>
          <p className="text-[11px] text-kk-muted mt-0.5">
            Required fields marked <span className="text-kk-bad">*</span>
          </p>
        </div>

        <div className="px-5 py-5 space-y-5">

          {/* ── Required ── */}
          <DebouncedTextarea
            label="What was done well?"
            field="final_done_well"
            submissionId={submissionId}
            initialValue={initialValues.finalDoneWell}
            placeholder="Describe what was done well during this visit…"
            required
          />
          <DebouncedTextarea
            label="Main focus before next audit"
            field="final_focus_next"
            submissionId={submissionId}
            initialValue={initialValues.finalFocusNext}
            placeholder="What should be the primary area of improvement before the next audit?…"
            required
          />
          <YesNoButtons
            label="Manager on Duty informed of the findings"
            value={modInformed}
            onChange={handleModInformed}
            required
          />

          {/* ── Divider ── */}
          <div className="border-t border-kk-line" />

          {/* ── Optional ── */}
          <DebouncedTextarea
            label="Overall comments / observations"
            field="final_overall_comments"
            submissionId={submissionId}
            initialValue={initialValues.finalOverallComments}
            placeholder="Any additional observations from the visit…"
          />
          <DebouncedTextarea
            label="Immediate corrective action taken during the visit"
            field="final_corrective_action"
            submissionId={submissionId}
            initialValue={initialValues.finalCorrectiveAction}
            placeholder="Describe any corrective actions taken on the spot…"
          />

          <YesNoButtons
            label="Additional follow-up required?"
            value={followUp ? true : followUp === false ? false : null}
            onChange={handleFollowUp}
          />

          {followUp && (
            <div>
              <label className="block text-sm font-semibold text-kk-ink mb-1.5">
                Requested follow-up date
                {dateSaving && (
                  <span className="ml-2 font-normal text-[10px] text-kk-muted">Saving…</span>
                )}
              </label>
              <input
                type="date"
                value={followUpDate}
                onChange={handleDateChange}
                className="text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[#AD3919]/40 focus:border-[#AD3919]/50 transition-colors"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
