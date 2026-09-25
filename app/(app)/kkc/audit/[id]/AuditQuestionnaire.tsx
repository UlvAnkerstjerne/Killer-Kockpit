'use client'

import { useCallback, useMemo, useRef, useState, useTransition } from 'react'
import { upsertAuditResponse, updateResponseComment, upsertSectionComment, updateAuditFinalField, BUSYNESS_OPTIONS } from '@/lib/actions/audit'
import type { ScoringConfig } from '@/lib/audit/submissions'
import { useSaveState } from '@/lib/hooks/useSaveState'
import { SaveStatusIndicator } from '@/components/ui/SaveStatusIndicator'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string
  sort_order: number
  section: string
  title: string
  is_core_standard: boolean
  is_red_flag: boolean
}

export type AuditResult = 'pass' | 'fail' | 'na'

export interface SavedResponse {
  checkpoint_id: string
  result: AuditResult
  comment: string | null
}

interface Props {
  submissionId: string
  checkpoints: Checkpoint[]
  initialResponses: SavedResponse[]
  initialSectionComments: Record<string, string>
  isReadOnly: boolean
  locationName: string
  auditorName: string
  managerOnDuty: string | null
  busyness: string | null
  startedAt: string
  requiresFailureContext: boolean
  requiresBusyness: boolean
  requiresManagerOnDuty: boolean
  scoringConfig: ScoringConfig
}

// ── Answer button config ───────────────────────────────────────────────────────

const ANSWERS: { result: AuditResult; label: string }[] = [
  { result: 'pass', label: 'Acceptable' },
  { result: 'fail', label: 'Unacceptable' },
  { result: 'na',   label: 'Not assessed' },
]

const ANSWER_SELECTED_CLS: Record<AuditResult, string> = {
  pass: 'bg-kk-good-bg border-kk-good text-kk-good font-semibold',
  fail: 'bg-kk-bad-bg border-kk-bad text-kk-bad font-semibold',
  na:   'bg-kk-soft border-kk-line text-kk-muted font-semibold',
}

// ── Checkpoint row ─────────────────────────────────────────────────────────────

function CheckpointRow({
  cp,
  current,
  comment,
  isReadOnly,
  isPending,
  onChange,
  onCommentChange,
  scoringConfig,
}: {
  cp: Checkpoint
  current: AuditResult | null
  comment: string
  isReadOnly: boolean
  isPending: boolean
  onChange: (id: string, result: AuditResult) => void
  onCommentChange: (id: string, comment: string) => void
  scoringConfig: ScoringConfig
}) {
  return (
    <div className={`py-2 px-4 ${
      cp.is_red_flag
        ? 'border-l-2 border-kk-bad'
        : cp.is_core_standard
        ? 'border-l-2 border-amber-300/60'
        : 'border-l-2 border-transparent'
    }`}>
      {/* Desktop: text left, buttons right. Mobile: stacked. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:gap-3">

        {/* Text + classification badges */}
        <div className="flex items-baseline gap-1.5 flex-1 min-w-0 mb-2 sm:mb-0">
          <p className="text-sm text-kk-ink leading-snug">{cp.title}</p>
          {cp.is_red_flag && scoringConfig.hasRedFlags && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-kk-bad-bg text-kk-bad border border-kk-bad/30 leading-none shrink-0">
              {scoringConfig.secondaryFailShort}
            </span>
          )}
          {cp.is_core_standard && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-600 border border-amber-200 leading-none shrink-0">
              {scoringConfig.secondaryShort}
            </span>
          )}
        </div>

        {/* Answer buttons */}
        <div className="flex gap-1 shrink-0">
          {ANSWERS.map(({ result, label }) => {
            const isSelected = current === result
            return (
              <button
                key={result}
                type="button"
                onClick={() => !isReadOnly && onChange(cp.id, result)}
                disabled={isReadOnly || isPending}
                aria-pressed={isSelected}
                className={[
                  'flex-1 sm:flex-none sm:w-[90px] text-xs py-2 px-2 rounded-lg border transition-colors text-center',
                  isSelected
                    ? ANSWER_SELECTED_CLS[result]
                    : 'border-kk-line text-kk-muted hover:border-kk-ink hover:text-kk-ink',
                  isReadOnly ? 'cursor-default' : '',
                ].join(' ')}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Inline context / comment for Unacceptable checkpoints */}
      {current === 'fail' && (
        isReadOnly ? (
          comment ? (
            <div className="mt-2 ml-0.5">
              <p className="text-[11px] font-semibold text-kk-bad uppercase tracking-[0.07em] mb-0.5">Context</p>
              <p className="text-sm text-kk-ink whitespace-pre-wrap">{comment}</p>
            </div>
          ) : null
        ) : (
          <div className="mt-2 ml-0.5">
            <label className="block text-[11px] font-semibold text-kk-bad uppercase tracking-[0.07em] mb-1">
              Context / Comment <span className="text-kk-bad">*</span>
            </label>
            <textarea
              value={comment}
              onChange={e => onCommentChange(cp.id, e.target.value)}
              rows={2}
              placeholder="Explain what was observed and why this was judged Unacceptable…"
              className="w-full text-sm text-kk-ink bg-kk-bad-bg/40 border border-kk-bad/30 rounded-lg px-3 py-2 resize-none placeholder:text-kk-muted/60 focus:outline-none focus:ring-1 focus:ring-kk-bad/40 focus:border-kk-bad/50 transition-colors"
              data-fail-context={cp.id}
            />
          </div>
        )
      )}
    </div>
  )
}

// ── Section comment box ────────────────────────────────────────────────────────

const DEBOUNCE_MS = 800

function SectionCommentBox({
  submissionId,
  section,
  initialValue,
  isReadOnly,
}: {
  submissionId: string
  section: string
  initialValue: string
  isReadOnly: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const save = useSaveState()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function persist(text: string) {
    save.start()
    const result = await upsertSectionComment(submissionId, section, text)
    if (result?.error) {
      save.fail(result.error)
    } else {
      save.ok()
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value
    setValue(text)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => persist(text), DEBOUNCE_MS)
  }

  function handleBlur() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    persist(value)
  }

  if (isReadOnly) {
    if (!value) return null
    return (
      <div className="px-4 pb-3 pt-1">
        <p className="text-[11px] font-semibold text-kk-muted uppercase tracking-[0.07em] mb-1">
          Comments — {section}
        </p>
        <p className="text-sm text-kk-ink whitespace-pre-wrap">{value}</p>
      </div>
    )
  }

  return (
    <div className="px-4 pb-4 pt-2">
      <label className="block text-[11px] font-semibold text-kk-muted uppercase tracking-[0.07em] mb-1.5">
        Comments — {section}
        <span className="ml-2 normal-case font-normal">
          <SaveStatusIndicator status={save.status} errorMsg={save.errorMsg} />
        </span>
      </label>
      <textarea
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        rows={3}
        placeholder="Optional section notes…"
        className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 resize-none placeholder:text-kk-muted/60 focus:outline-none focus:ring-1 focus:ring-[#AD3919]/40 focus:border-[#AD3919]/50 transition-colors"
      />
    </div>
  )
}

// ── Visit fields editor (for drafts missing required visit-level data) ────────

function VisitFieldsEditor({
  submissionId,
  initialBusyness,
  initialManagerOnDuty,
  requiresBusyness,
  requiresManagerOnDuty,
}: {
  submissionId: string
  initialBusyness: string | null
  initialManagerOnDuty: string | null
  requiresBusyness: boolean
  requiresManagerOnDuty: boolean
}) {
  const [busynessVal, setBusynessVal] = useState(initialBusyness ?? '')
  const [modVal, setModVal] = useState(initialManagerOnDuty ?? '')
  const save = useSaveState()
  const modTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showBusyness = requiresBusyness && !initialBusyness
  const showMod = requiresManagerOnDuty && !initialManagerOnDuty

  if (!showBusyness && !showMod) return null

  async function handleBusynessChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value
    setBusynessVal(val)
    if (!val) return
    save.start()
    const res = await updateAuditFinalField(submissionId, { field: 'busyness', value: val })
    if (res?.error) save.fail(res.error)
    else save.ok()
  }

  async function persistMod(text: string) {
    save.start()
    const res = await updateAuditFinalField(submissionId, { field: 'manager_on_duty', value: text })
    if (res?.error) save.fail(res.error)
    else save.ok()
  }

  function handleModChange(e: React.ChangeEvent<HTMLInputElement>) {
    const text = e.target.value
    setModVal(text)
    if (modTimerRef.current) clearTimeout(modTimerRef.current)
    modTimerRef.current = setTimeout(() => persistMod(text), DEBOUNCE_MS)
  }

  function handleModBlur() {
    if (modTimerRef.current) { clearTimeout(modTimerRef.current); modTimerRef.current = null }
    persistMod(modVal)
  }

  return (
    <div className="mt-3 pt-3 border-t border-kk-line space-y-3">
      <p className="text-[11px] font-semibold text-kk-bad uppercase tracking-[0.07em]">
        Required visit information
        <span className="ml-2 normal-case font-normal">
          <SaveStatusIndicator status={save.status} errorMsg={save.errorMsg} />
        </span>
      </p>

      {showBusyness && (
        <div>
          <label htmlFor="visit-busyness" className="block text-xs font-semibold text-kk-ink mb-1">
            Busyness <span className="text-kk-bad">*</span>
          </label>
          <select
            id="visit-busyness"
            value={busynessVal}
            onChange={handleBusynessChange}
            className="w-full text-sm bg-white border border-kk-line rounded-lg px-3 py-2 outline-none focus:border-kk-ink transition-colors text-kk-ink"
          >
            <option value="">Select busyness…</option>
            {BUSYNESS_OPTIONS.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
      )}

      {showMod && (
        <div>
          <label htmlFor="visit-mod" className="block text-xs font-semibold text-kk-ink mb-1">
            Manager on Duty <span className="text-kk-bad">*</span>
          </label>
          <input
            id="visit-mod"
            type="text"
            value={modVal}
            onChange={handleModChange}
            onBlur={handleModBlur}
            placeholder="Full name"
            maxLength={100}
            className="w-full text-sm bg-white border border-kk-line rounded-lg px-3 py-2 outline-none focus:border-kk-ink transition-colors text-kk-ink placeholder:text-kk-muted"
          />
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AuditQuestionnaire({
  submissionId,
  checkpoints,
  initialResponses,
  initialSectionComments,
  isReadOnly,
  locationName,
  auditorName,
  managerOnDuty,
  busyness,
  startedAt,
  requiresFailureContext,
  requiresBusyness,
  requiresManagerOnDuty,
  scoringConfig,
}: Props) {
  const [isPending, startTransition] = useTransition()

  // Local response state — initialised from server data on first render
  const [responses, setResponses] = useState<Map<string, AuditResult>>(() => {
    const m = new Map<string, AuditResult>()
    for (const r of initialResponses) m.set(r.checkpoint_id, r.result)
    return m
  })

  // Local comment state for checkpoint context
  const [comments, setComments] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>()
    for (const r of initialResponses) {
      if (r.comment) m.set(r.checkpoint_id, r.comment)
    }
    return m
  })

  // Debounced comment persistence
  const commentTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const persistComment = useCallback(async (checkpointId: string, text: string) => {
    await updateResponseComment(submissionId, checkpointId, text)
  }, [submissionId])

  const handleCommentChange = useCallback((checkpointId: string, text: string) => {
    setComments(prev => new Map(prev).set(checkpointId, text))
    const existing = commentTimers.current.get(checkpointId)
    if (existing) clearTimeout(existing)
    commentTimers.current.set(checkpointId, setTimeout(() => {
      persistComment(checkpointId, text)
    }, DEBOUNCE_MS))
  }, [persistComment])

  // Group checkpoints by section, preserving display order
  const sections = useMemo(() => {
    const map = new Map<string, Checkpoint[]>()
    for (const cp of checkpoints) {
      if (!map.has(cp.section)) map.set(cp.section, [])
      map.get(cp.section)!.push(cp)
    }
    return [...map.entries()]
  }, [checkpoints])

  const answeredCount = responses.size
  const totalCount    = checkpoints.length

  // Count fail responses missing context (for submission sentinel)
  // Only counts when the template requires failure context
  const failsMissingContext = useMemo(() => {
    if (!requiresFailureContext) return 0
    let count = 0
    for (const [cpId, result] of responses) {
      if (result === 'fail' && !(comments.get(cpId) ?? '').trim()) count++
    }
    return count
  }, [responses, comments, requiresFailureContext])

  function handleChange(checkpointId: string, result: AuditResult) {
    // Optimistic update
    setResponses(prev => new Map(prev).set(checkpointId, result))
    // Clear comment when switching away from fail
    if (result !== 'fail') {
      setComments(prev => { const n = new Map(prev); n.delete(checkpointId); return n })
    }
    // Persist
    startTransition(async () => {
      const res = await upsertAuditResponse(submissionId, checkpointId, result)
      if (res.error) {
        // Roll back on failure
        setResponses(prev => {
          const next = new Map(prev)
          next.delete(checkpointId)
          return next
        })
      }
    })
  }

  const visitDate = new Date(startedAt)
  const dateStr = visitDate.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
  const timeStr = visitDate.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  })

  return (
    <div className="max-w-2xl mx-auto space-y-4 pb-12">

      {/* Header meta */}
      <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-kk-ink">Audit</h1>
            <p className="text-sm text-kk-muted mt-0.5">{locationName}</p>
          </div>
          {isReadOnly && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-kk-soft text-kk-muted border border-kk-line shrink-0">
              Read-only
            </span>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <span className="text-kk-muted">Auditor</span>
          <span className="text-kk-ink font-medium text-right">{auditorName}</span>
          <span className="text-kk-muted">Manager on Duty</span>
          <span className="text-kk-ink font-medium text-right">{managerOnDuty ?? '—'}</span>
          <span className="text-kk-muted">Date</span>
          <span className="text-kk-ink font-medium text-right">{dateStr} · {timeStr}</span>
          <span className="text-kk-muted">Busyness</span>
          <span className="text-kk-ink font-medium text-right">{busyness ?? '—'}</span>
        </div>

        {/* Editable visit fields for in-progress audits missing required data */}
        {!isReadOnly && (
          <VisitFieldsEditor
            submissionId={submissionId}
            initialBusyness={busyness}
            initialManagerOnDuty={managerOnDuty}
            requiresBusyness={requiresBusyness}
            requiresManagerOnDuty={requiresManagerOnDuty}
          />
        )}
      </div>

      {/* Progress */}
      <div className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] px-5 py-3">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="font-semibold text-kk-ink">Progress</span>
          <span className="text-kk-muted">
            <span className={answeredCount === totalCount ? 'text-kk-good font-bold' : 'font-bold text-kk-ink'}>
              {answeredCount}
            </span>
            {' '}<span className="text-kk-muted">of {totalCount} answered</span>
          </span>
        </div>
        <div className="h-2 bg-kk-line rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${answeredCount === totalCount ? 'bg-kk-good' : 'bg-[#AD3919]'}`}
            style={{ width: totalCount > 0 ? `${(answeredCount / totalCount) * 100}%` : '0%' }}
          />
        </div>
        {/* Legend */}
        <div className="flex gap-4 mt-2.5 text-[11px] text-kk-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded border border-amber-200 bg-amber-50" />
            {scoringConfig.secondaryLabel}
          </span>
          {scoringConfig.hasRedFlags && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded border border-kk-bad/30 bg-kk-bad-bg" />
              {scoringConfig.secondaryFailLabel}
            </span>
          )}
        </div>
      </div>

      {/* Sections */}
      {sections.map(([section, cps]) => {
        const sectionAnswered = cps.filter(cp => responses.has(cp.id)).length
        return (
          <div
            key={section}
            className="bg-kk-panel border border-kk-line rounded-xl shadow-[0_1px_3px_0_rgba(0,0,0,0.07)] overflow-hidden"
          >
            {/* Section header */}
            <div className="px-4 py-3 border-b border-kk-line bg-kk-soft flex items-center justify-between">
              <h2 className="text-sm font-bold text-kk-ink">{section}</h2>
              <span className="text-[11px] text-kk-muted">
                {sectionAnswered}/{cps.length}
              </span>
            </div>

            {/* Checkpoints */}
            <div className="divide-y divide-kk-line">
              {cps.map(cp => (
                <CheckpointRow
                  key={cp.id}
                  cp={cp}
                  current={responses.get(cp.id) ?? null}
                  comment={comments.get(cp.id) ?? ''}
                  isReadOnly={isReadOnly}
                  isPending={isPending}
                  onChange={handleChange}
                  onCommentChange={handleCommentChange}
                  scoringConfig={scoringConfig}
                />
              ))}
            </div>

            {/* Section comment */}
            <div className="border-t border-kk-line">
              <SectionCommentBox
                submissionId={submissionId}
                section={section}
                initialValue={initialSectionComments[section] ?? ''}
                isReadOnly={isReadOnly}
              />
            </div>
          </div>
        )
      })}

      {/* Hidden sentinel for AuditSubmitBar to detect missing context on fail responses */}
      <div
        id="audit-missing-context-sentinel"
        data-missing={String(failsMissingContext)}
        hidden
      />
    </div>
  )
}
