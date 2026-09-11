'use client'

/**
 * DinerForm — interactive Mystery Diner questionnaire.
 *
 * Features:
 *   - Mobile-first layout with large tap targets
 *   - Autosave on every answer (immediate for discrete, 800 ms debounce for text)
 *   - Refresh-safe: initial state seeded from server; no answers lost on reload
 *   - Conditional checkpoints 11 + 12 hidden until waiting time > 15 min
 *   - Critical and Gold Star labels visible but non-alarming
 *   - Two-step submit confirmation; submitted form becomes read-only
 *   - No Kockpit login required; auth is via signed session cookie
 */

import { useState, useCallback, useRef } from 'react'
import type { DinerCheckpoint, DinerResponsesMap, DinerResponseValue } from '@/lib/diner/types'
import { WAITING_TIME_BANDS } from '@/lib/diner/types'
import {
  shouldShowConditional,
  computeProgress,
  groupCheckpointsBySection,
  getWaitingTimeBand,
  isWaitingTimeCritical,
} from '@/lib/diner/form-utils'

// ─── Props ────────────────────────────────────────────────────────────────────

interface DinerFormProps {
  checkpoints:      DinerCheckpoint[]
  initialResponses: DinerResponsesMap
  submissionId:     string
  submissionStatus: 'in_progress' | 'submitted'
  dimerName:        string
  locationName:     string | null
}

// ─── Save status ──────────────────────────────────────────────────────────────

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// ─── Root component ───────────────────────────────────────────────────────────

export default function DinerForm({
  checkpoints,
  initialResponses,
  submissionId,
  submissionStatus,
  dimerName,
  locationName,
}: DinerFormProps) {
  const [responses,        setResponses]        = useState<DinerResponsesMap>(initialResponses)
  const [saveStatus,       setSaveStatus]       = useState<SaveStatus>('idle')
  const [submitted,        setSubmitted]        = useState(submissionStatus === 'submitted')
  const [confirmingSubmit, setConfirmingSubmit] = useState(false)
  const [submitError,      setSubmitError]      = useState<string | null>(null)
  const [submitting,       setSubmitting]       = useState(false)

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const savingCount    = useRef(0)

  // ── Derived state ──────────────────────────────────────────────────────────
  const waitingTimeBand  = getWaitingTimeBand(checkpoints, responses)
  const showConditionals = shouldShowConditional(waitingTimeBand)
  const progress         = computeProgress(checkpoints, responses, showConditionals)
  const sections         = groupCheckpointsBySection(checkpoints)

  // ── Autosave ───────────────────────────────────────────────────────────────

  const saveResponse = useCallback(async (checkpointId: string, value: DinerResponseValue) => {
    savingCount.current += 1
    setSaveStatus('saving')
    try {
      const res = await fetch('/api/diner/response', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          checkpointId,
          result: value.result ?? null,
          notes:  value.notes.trim() || null,
        }),
      })
      savingCount.current -= 1
      if (savingCount.current === 0) {
        setSaveStatus(res.ok ? 'saved' : 'error')
      }
    } catch {
      savingCount.current -= 1
      if (savingCount.current === 0) setSaveStatus('error')
    }
  }, [])

  const handleChange = useCallback((
    checkpointId: string,
    value:        DinerResponseValue,
    debounce     = false,
  ) => {
    setResponses(prev => ({ ...prev, [checkpointId]: value }))

    if (debounce) {
      clearTimeout(debounceTimers.current[checkpointId])
      debounceTimers.current[checkpointId] = setTimeout(() => {
        saveResponse(checkpointId, value)
      }, 800)
    } else {
      saveResponse(checkpointId, value)
    }
  }, [saveResponse])

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res  = await fetch('/api/diner/submit', { method: 'POST' })
      const data = await res.json() as { error?: string }
      if (res.ok) {
        setSubmitted(true)
        setConfirmingSubmit(false)
      } else {
        setSubmitError(data.error ?? 'Submission failed. Please try again.')
      }
    } catch {
      setSubmitError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Submitted state ────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm text-center">
          <div className="mb-4 text-4xl">&#10003;</div>
          <h1 className="mb-2 text-xl font-semibold">Audit submitted</h1>
          <p className="text-sm text-gray-500">
            Thank you{dimerName ? `, ${dimerName}` : ''}. Your Mystery Diner audit has been recorded.
          </p>
        </div>
      </main>
    )
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-svh bg-gray-50 pb-36">

      {/* ── Sticky progress header ─────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-100 px-4 pt-3 pb-2 shadow-sm">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Mystery Diner Audit
            {locationName ? ` — ${locationName}` : ''}
          </span>
          <SaveIndicator status={saveStatus} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gray-800 transition-all duration-300"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
          <span className="text-xs text-gray-400 shrink-0">
            {progress.answered}/{progress.total}
          </span>
        </div>
      </div>

      {/* ── Diner instructions ─────────────────────────────────────────── */}
      <InstructionsCard />

      {/* ── Sections ──────────────────────────────────────────────────── */}
      <div className="px-4 space-y-2">
        {[...sections.entries()].map(([section, cps]) => (
          <Section
            key={section}
            section={section}
            checkpoints={cps}
            responses={responses}
            showConditionals={showConditionals}
            waitingTimeBand={waitingTimeBand}
            onChange={handleChange}
            readOnly={false}
          />
        ))}
      </div>

      {/* ── Fixed submit footer ─────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 px-4 py-4 shadow-lg">
        {!confirmingSubmit ? (
          <button
            onClick={() => setConfirmingSubmit(true)}
            className="w-full rounded-xl bg-gray-900 py-3.5 text-base font-semibold text-white active:opacity-80"
          >
            Submit Audit
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-center text-sm text-gray-500">
              Once submitted, your audit cannot be changed.
            </p>
            {submitError && (
              <p className="text-center text-sm text-red-500">{submitError}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => { setConfirmingSubmit(false); setSubmitError(null) }}
                className="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-medium text-gray-700 active:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 rounded-xl bg-gray-900 py-3 text-sm font-semibold text-white disabled:opacity-60 active:opacity-80"
              >
                {submitting ? 'Submitting…' : 'Confirm'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Save indicator ───────────────────────────────────────────────────────────

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null
  return (
    <span className={`text-xs ${
      status === 'saving' ? 'text-gray-400' :
      status === 'saved'  ? 'text-green-600' :
                            'text-red-500'
    }`}>
      {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save error'}
    </span>
  )
}

// ─── Instructions card ────────────────────────────────────────────────────────

function InstructionsCard() {
  return (
    <div className="mx-4 my-4 rounded-xl bg-amber-50 border border-amber-200 p-4">
      <p className="mb-2 text-sm font-semibold text-amber-900">Before you start</p>
      <ul className="space-y-1.5 text-sm text-amber-800">
        <li>&#8226; Initially order <strong>ONE roll only.</strong></li>
        <li>&#8226; Give staff the opportunity to offer the combo. If they offer it, accept it. If not, add the combo yourself before completing the order.</li>
        <li>&#8226; Give staff an opportunity to offer lemonade.</li>
        <li>&#8226; Ask one reasonable menu/product question to assess product knowledge.</li>
        <li>&#8226; After eating, return to the bar and thank staff for the food. <strong>Do not mention reviews.</strong></li>
        <li>&#8226; Shazam one song during your visit and record the artist and track name.</li>
      </ul>
    </div>
  )
}

// ─── Section ──────────────────────────────────────────────────────────────────

interface SectionProps {
  section:          string
  checkpoints:      DinerCheckpoint[]
  responses:        DinerResponsesMap
  showConditionals: boolean
  waitingTimeBand:  string | null
  onChange:         (id: string, value: DinerResponseValue, debounce?: boolean) => void
  readOnly:         boolean
}

function Section({
  section,
  checkpoints,
  responses,
  showConditionals,
  waitingTimeBand,
  onChange,
  readOnly,
}: SectionProps) {
  const isGoldStarSection = section === 'Gold Stars'

  return (
    <div className="mt-4">
      {/* Section header */}
      <div className="mb-2 flex items-center gap-2">
        {isGoldStarSection && (
          <span className="text-amber-500 text-sm font-bold">&#9733;</span>
        )}
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400">
          {section}
        </h2>
      </div>

      {/* Checkpoints */}
      <div className="space-y-2">
        {checkpoints.map(cp => {
          if (cp.is_conditional && !showConditionals) return null
          return (
            <CheckpointCard
              key={cp.id}
              checkpoint={cp}
              value={responses[cp.id] ?? { result: null, notes: '' }}
              waitingTimeBand={waitingTimeBand}
              onChange={onChange}
              readOnly={readOnly}
            />
          )
        })}
      </div>
    </div>
  )
}

// ─── Checkpoint card ──────────────────────────────────────────────────────────

interface CheckpointCardProps {
  checkpoint:      DinerCheckpoint
  value:           DinerResponseValue
  waitingTimeBand: string | null
  onChange:        (id: string, value: DinerResponseValue, debounce?: boolean) => void
  readOnly:        boolean
}

function CheckpointCard({ checkpoint: cp, value, waitingTimeBand, onChange, readOnly }: CheckpointCardProps) {
  return (
    <div className="rounded-xl bg-white border border-gray-100 shadow-sm p-4">
      {/* Label row */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-medium text-gray-900 leading-snug flex-1">
          <span className="text-gray-400 mr-1">{cp.order_index}.</span>
          {cp.label}
        </p>
        <div className="flex gap-1.5 shrink-0 mt-0.5">
          {cp.is_critical && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-red-50 text-red-600 border border-red-100">
              Critical
            </span>
          )}
          {cp.type === 'gold_star' && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-100">
              Gold Star
            </span>
          )}
        </div>
      </div>

      {/* Description (criterion) */}
      {cp.description && (
        <p className="text-xs text-gray-400 mb-3 leading-relaxed">{cp.description}</p>
      )}

      {/* Diner hint */}
      {cp.hint && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mb-3 leading-relaxed">
          {cp.hint}
        </p>
      )}

      {/* Answer control */}
      {cp.type === 'scored' && (
        <ScoredButtons
          value={value}
          onChange={v => onChange(cp.id, v)}
          readOnly={readOnly}
        />
      )}
      {cp.type === 'gold_star' && (
        <GoldStarButtons
          value={value}
          onChange={v => onChange(cp.id, v)}
          readOnly={readOnly}
        />
      )}
      {cp.type === 'waiting_time' && (
        <WaitingTimeSelector
          value={value}
          onChange={v => onChange(cp.id, v)}
          readOnly={readOnly}
        />
      )}
      {cp.type === 'informational' && (
        <InformationalInput
          value={value}
          onChange={v => onChange(cp.id, v, true)}
          hint={cp.hint}
          readOnly={readOnly}
        />
      )}
    </div>
  )
}

// ─── Scored buttons ───────────────────────────────────────────────────────────

interface ButtonsProps {
  value:    DinerResponseValue
  onChange: (v: DinerResponseValue) => void
  readOnly: boolean
}

const SCORED_OPTIONS = [
  { result: 'pass' as const, label: 'Acceptable',   active: 'border-green-500 bg-green-50 text-green-800'  },
  { result: 'fail' as const, label: 'Unacceptable', active: 'border-red-400   bg-red-50   text-red-700'    },
  { result: 'na'   as const, label: 'N/A',          active: 'border-gray-400  bg-gray-100  text-gray-600'  },
] as const

function ScoredButtons({ value, onChange, readOnly }: ButtonsProps) {
  return (
    <div className="flex gap-2">
      {SCORED_OPTIONS.map(opt => (
        <button
          key={opt.result}
          disabled={readOnly}
          onClick={() => onChange({ ...value, result: value.result === opt.result ? null : opt.result })}
          className={`flex-1 rounded-lg border py-2.5 text-xs font-medium transition-colors
            ${value.result === opt.result ? opt.active : 'border-gray-200 bg-white text-gray-500'}
            ${readOnly ? 'cursor-default opacity-70' : 'active:scale-95'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Gold Star buttons ────────────────────────────────────────────────────────

const GOLD_OPTIONS = [
  { result: 'pass' as const, label: 'Achieved',     active: 'border-amber-400 bg-amber-50  text-amber-800' },
  { result: 'fail' as const, label: 'Not achieved', active: 'border-gray-400  bg-gray-100  text-gray-600'  },
  { result: 'na'   as const, label: 'N/A',          active: 'border-gray-300  bg-gray-100  text-gray-500'  },
] as const

function GoldStarButtons({ value, onChange, readOnly }: ButtonsProps) {
  return (
    <div className="flex gap-2">
      {GOLD_OPTIONS.map(opt => (
        <button
          key={opt.result}
          disabled={readOnly}
          onClick={() => onChange({ ...value, result: value.result === opt.result ? null : opt.result })}
          className={`flex-1 rounded-lg border py-2.5 text-xs font-medium transition-colors
            ${value.result === opt.result ? opt.active : 'border-gray-200 bg-white text-gray-500'}
            ${readOnly ? 'cursor-default opacity-70' : 'active:scale-95'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Waiting time selector ────────────────────────────────────────────────────

function WaitingTimeSelector({ value, onChange, readOnly }: ButtonsProps) {
  return (
    <div className="space-y-2">
      {WAITING_TIME_BANDS.map(band => {
        const selected = value.notes === band.value
        return (
          <button
            key={band.value}
            disabled={readOnly}
            onClick={() => onChange({ result: null, notes: selected ? '' : band.value })}
            className={`w-full rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors
              ${selected
                ? band.critical
                  ? 'border-red-400 bg-red-50 text-red-700'
                  : 'border-gray-800 bg-gray-900 text-white'
                : 'border-gray-200 bg-white text-gray-600'
              }
              ${readOnly ? 'cursor-default opacity-70' : 'active:scale-[0.99]'}`}
          >
            <span>{band.label}</span>
            {band.critical && selected && (
              <span className="ml-2 text-xs font-semibold text-red-500">— Critical flag</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Informational (free text) ────────────────────────────────────────────────

function InformationalInput({
  value,
  onChange,
  readOnly,
}: {
  value:    DinerResponseValue
  onChange: (v: DinerResponseValue) => void
  hint:     string | null
  readOnly: boolean
}) {
  return (
    <textarea
      rows={3}
      disabled={readOnly}
      placeholder="Artist — Track name"
      value={value.notes}
      onChange={e => onChange({ result: null, notes: e.target.value })}
      className={`w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-gray-800
        placeholder:text-gray-300 focus:border-gray-400 focus:outline-none resize-none
        ${readOnly ? 'opacity-70 bg-gray-50' : 'bg-white'}`}
    />
  )
}
