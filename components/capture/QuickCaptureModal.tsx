'use client'

/**
 * components/capture/QuickCaptureModal.tsx
 *
 * Quick Capture modal — M8B4 UI + M8B5 persistence.
 *
 * State machine:
 *   capture → analysing → review  ←→  (Back)
 *                ↓           ↓ Save
 *              error     [saving…]
 *                          ↓ all ok
 *                       (closes)
 *
 * Partial failure: modal stays open; saved candidates show "Saved" badge
 * and are locked from editing; failed candidates remain editable with a
 * safe error and a Retry action.
 *
 * Privacy contract:
 *   • Raw note text lives only in client state — never persisted.
 *   • analyzeCapture() handles server-side privacy; the component only
 *     renders the ephemeral enriched output.
 *   • saveApprovedCaptures() receives ONLY human-reviewed body / date /
 *     canonical entity links — never raw_text, analysis_note, or author id.
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter }                    from 'next/navigation'
import {
  analyzeCapture,
  searchCaptureEntities,
  saveApprovedCaptures,
} from '@/lib/actions/capture'
import type {
  EnrichedCandidateUpdate,
  EnrichedEntityRef,
  CaptureEntityResult,
} from '@/lib/actions/capture'
import type { KkUpdateEntityType } from '@/lib/types'

// ─── Local types ──────────────────────────────────────────────────────────────

export interface EntityRefUI {
  entity_type:         KkUpdateEntityType
  name_hint:           string
  /** Non-null when resolved (auto or by human). */
  canonical:           CanonicalEntity | null
  /** Non-empty only for ambiguous refs (from resolver). */
  ambiguousCandidates: CanonicalEntity[]
}

export interface CanonicalEntity {
  entity_id:    string
  display_name: string
  entity_type:  KkUpdateEntityType
}

export interface CandidateUI {
  id:          string
  selected:    boolean
  body:        string
  occurredOn:  string | null
  entityRefs:  EntityRefUI[]
}

export type SaveState = 'pending' | 'saving' | 'saved' | 'failed'

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export function todayCopenhagen(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date())
}

export function enrichedRefToUI(ref: EnrichedEntityRef): EntityRefUI {
  if (ref.status === 'resolved') {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      canonical:   { entity_id: ref.entity_id, display_name: ref.display_name, entity_type: ref.entity_type },
      ambiguousCandidates: [],
    }
  }
  if (ref.status === 'ambiguous') {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      canonical:   null,
      ambiguousCandidates: ref.candidates.map(c => ({ ...c, entity_type: ref.entity_type })),
    }
  }
  return {
    entity_type: ref.entity_type,
    name_hint:   ref.name_hint,
    canonical:   null,
    ambiguousCandidates: [],
  }
}

export function enrichedToUI(candidates: EnrichedCandidateUpdate[]): CandidateUI[] {
  return candidates.map((c, i) => ({
    id:         String(i),
    selected:   true,
    body:       c.body,
    occurredOn: c.occurred_on,
    entityRefs: c.entity_refs.map(enrichedRefToUI),
  }))
}

/** Returns true if a selected candidate has zero canonical entity links. */
export function hasZeroLinks(candidate: CandidateUI): boolean {
  return candidate.selected && candidate.entityRefs.every(r => r.canonical === null)
}

/**
 * Extracts canonical entity links from a candidate, deduplicating by
 * (entity_type, entity_id). Only canonical refs are included — unresolved,
 * ambiguous, and not-found refs are silently skipped.
 */
export function canonicalLinks(
  c: CandidateUI,
): { entity_type: KkUpdateEntityType; entity_id: string }[] {
  const seen  = new Set<string>()
  const links: { entity_type: KkUpdateEntityType; entity_id: string }[] = []
  for (const ref of c.entityRefs) {
    if (!ref.canonical) continue
    const key = `${ref.canonical.entity_type}:${ref.canonical.entity_id}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ entity_type: ref.canonical.entity_type, entity_id: ref.canonical.entity_id })
  }
  return links
}

/**
 * Validates a selected candidate for persistence.
 * Returns null when valid; a human-readable error string when invalid.
 */
export function validateCandidateForSave(c: CandidateUI): string | null {
  if (!c.body.trim()) return 'Update body must not be blank.'
  if (canonicalLinks(c).length === 0) return 'Choose at least one person, location, or project.'
  if (c.occurredOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(c.occurredOn)) {
    return 'Date must be in YYYY-MM-DD format.'
  }
  return null
}

// ─── Entity type labels ───────────────────────────────────────────────────────

const ENTITY_TYPE_LABEL: Record<KkUpdateEntityType, string> = {
  employee: 'Person',
  location: 'Location',
  project:  'Project',
}

// ─── Inline entity search ─────────────────────────────────────────────────────

function EntitySearch({
  onSelect,
  onDismiss,
  initialEntityType,
}: {
  onSelect:          (entity: CaptureEntityResult) => void
  onDismiss:         () => void
  initialEntityType?: KkUpdateEntityType
}) {
  const inputRef  = useRef<HTMLInputElement>(null)
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [query,   setQuery]   = useState('')
  const [filter,  setFilter]  = useState<KkUpdateEntityType | undefined>(initialEntityType)
  const [results, setResults] = useState<CaptureEntityResult[]>([])
  const [busy,    setBusy]    = useState(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  function scheduleSearch(q: string, type?: KkUpdateEntityType) {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!q.trim()) { setResults([]); return }
    timerRef.current = setTimeout(async () => {
      setBusy(true)
      const res = await searchCaptureEntities(q.trim(), type)
      setBusy(false)
      setResults('data' in res ? res.data : [])
    }, 250)
  }

  function handleQueryChange(q: string) {
    setQuery(q)
    scheduleSearch(q, filter)
  }

  function handleFilterChange(t: KkUpdateEntityType | undefined) {
    setFilter(t)
    scheduleSearch(query, t)
  }

  return (
    <div className="mt-1.5 border border-kk-line rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Search input */}
      <div className="flex items-center border-b border-kk-line px-2.5">
        <svg className="w-3 h-3 text-kk-muted shrink-0" viewBox="0 0 16 16" fill="none">
          <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          placeholder="Search…"
          className="flex-1 px-2 py-1.5 text-xs text-kk-ink bg-transparent focus:outline-none placeholder:text-kk-muted"
        />
        <button
          onClick={onDismiss}
          className="text-kk-muted hover:text-kk-ink text-xs px-1 py-1"
          aria-label="Cancel search"
        >
          ✕
        </button>
      </div>

      {/* Type filter pills */}
      <div className="flex gap-1 px-2.5 py-1.5 border-b border-kk-line">
        {([undefined, 'employee', 'location', 'project'] as (KkUpdateEntityType | undefined)[]).map(t => (
          <button
            key={t ?? 'all'}
            onClick={() => handleFilterChange(t)}
            className={[
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              filter === t
                ? 'bg-kk-ink text-white border-kk-ink'
                : 'border-kk-line text-kk-muted hover:border-kk-ink hover:text-kk-ink',
            ].join(' ')}
          >
            {t ? ENTITY_TYPE_LABEL[t] : 'All'}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="max-h-40 overflow-y-auto">
        {busy && (
          <div className="px-3 py-2 text-xs text-kk-muted">Searching…</div>
        )}
        {!busy && query.trim() && results.length === 0 && (
          <div className="px-3 py-2 text-xs text-kk-muted">No matches found.</div>
        )}
        {!busy && results.map(r => (
          <button
            key={r.entity_id}
            onClick={() => onSelect(r)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-kk-soft transition-colors"
          >
            <span className="text-[10px] text-kk-muted shrink-0">{ENTITY_TYPE_LABEL[r.entity_type]}</span>
            <span className="text-xs text-kk-ink truncate">{r.display_name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Entity ref block ─────────────────────────────────────────────────────────

function EntityRefBlock({
  ref: entityRef,
  onResolveAmbiguous,
  onRemoveCanonical,
  onManualLink,
  locked,
}: {
  ref:                EntityRefUI
  onResolveAmbiguous: (entity: CanonicalEntity) => void
  onRemoveCanonical:  () => void
  onManualLink:       (entity: CaptureEntityResult) => void
  locked:             boolean
}) {
  const [showSearch, setShowSearch] = useState(false)

  // Resolved canonical chip
  if (entityRef.canonical) {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-kk-soft border border-kk-line rounded px-2 py-0.5 text-kk-ink">
        <span className="text-[9px] text-kk-muted">{ENTITY_TYPE_LABEL[entityRef.canonical.entity_type]}</span>
        <span className="font-medium">{entityRef.canonical.display_name}</span>
        {!locked && (
          <button
            onClick={onRemoveCanonical}
            className="text-kk-muted hover:text-kk-bad ml-0.5 leading-none"
            aria-label={`Remove ${entityRef.canonical.display_name}`}
          >
            ×
          </button>
        )}
      </span>
    )
  }

  // Ambiguous — show candidate buttons
  if (entityRef.ambiguousCandidates.length > 0) {
    return (
      <div className="inline-block">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-kk-muted italic">
            "{entityRef.name_hint}"?
          </span>
          {!locked && entityRef.ambiguousCandidates.map(c => (
            <button
              key={c.entity_id}
              onClick={() => onResolveAmbiguous(c)}
              className="text-[11px] px-2 py-0.5 border border-kk-line rounded hover:bg-kk-soft hover:border-kk-ink transition-colors text-kk-ink"
            >
              {c.display_name}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Not found
  return (
    <div className="inline-block">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs border border-dashed border-kk-line rounded px-2 py-0.5 text-kk-muted">
          <span className="text-[9px]">{ENTITY_TYPE_LABEL[entityRef.entity_type]}</span>
          <span>"{entityRef.name_hint}"</span>
          <span className="text-kk-muted/60">— not found</span>
        </span>
        {!locked && !showSearch && (
          <button
            onClick={() => setShowSearch(true)}
            className="text-[11px] text-kk-muted hover:text-kk-ink border border-dashed border-kk-line/60 rounded px-1.5 py-0.5 transition-colors"
          >
            Link
          </button>
        )}
      </div>
      {showSearch && (
        <EntitySearch
          initialEntityType={entityRef.entity_type}
          onSelect={entity => { onManualLink(entity); setShowSearch(false) }}
          onDismiss={() => setShowSearch(false)}
        />
      )}
    </div>
  )
}

// ─── Candidate editor card ────────────────────────────────────────────────────

function CandidateCard({
  candidate,
  onChange,
  isOnly,
  saveState,
  saveError,
  locked,
}: {
  candidate:  CandidateUI
  onChange:   (updated: CandidateUI) => void
  isOnly:     boolean
  saveState:  SaveState
  saveError:  string | null
  locked:     boolean
}) {
  const [showAddEntity, setShowAddEntity] = useState(false)
  const isSaved    = saveState === 'saved'
  const isFailed   = saveState === 'failed'
  const isEditable = !locked && !isSaved
  const zeroLinks  = hasZeroLinks(candidate) && !isSaved

  function setBody(body: string) {
    onChange({ ...candidate, body })
  }

  function setOccurredOn(occurredOn: string | null) {
    onChange({ ...candidate, occurredOn })
  }

  function toggleSelected() {
    onChange({ ...candidate, selected: !candidate.selected })
  }

  function updateRef(refIndex: number, updated: EntityRefUI) {
    const newRefs = [...candidate.entityRefs]
    newRefs[refIndex] = updated
    onChange({ ...candidate, entityRefs: newRefs })
  }

  function removeRef(refIndex: number) {
    const newRefs = candidate.entityRefs.filter((_, i) => i !== refIndex)
    onChange({ ...candidate, entityRefs: newRefs })
  }

  function handleManualLink(refIndex: number, entity: CaptureEntityResult) {
    const newRef: EntityRefUI = {
      entity_type:         entity.entity_type,
      name_hint:           entity.display_name,
      canonical:           { entity_id: entity.entity_id, display_name: entity.display_name, entity_type: entity.entity_type },
      ambiguousCandidates: [],
    }
    const newRefs = [...candidate.entityRefs]
    newRefs[refIndex] = newRef
    onChange({ ...candidate, entityRefs: newRefs })
  }

  function handleAddNewEntity(entity: CaptureEntityResult) {
    const newRef: EntityRefUI = {
      entity_type:         entity.entity_type,
      name_hint:           entity.display_name,
      canonical:           { entity_id: entity.entity_id, display_name: entity.display_name, entity_type: entity.entity_type },
      ambiguousCandidates: [],
    }
    onChange({ ...candidate, entityRefs: [...candidate.entityRefs, newRef] })
    setShowAddEntity(false)
  }

  return (
    <div
      className={[
        'border rounded-xl transition-colors',
        isSaved
          ? 'border-green-200 bg-green-50/30 opacity-75'
          : candidate.selected
          ? 'border-kk-line bg-white'
          : 'border-kk-line/50 bg-kk-soft/40 opacity-60',
      ].join(' ')}
    >
      {/* Header row: checkbox + saved badge + occurred_on */}
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-kk-line/60">
        {!isOnly && (
          <input
            type="checkbox"
            checked={candidate.selected}
            onChange={toggleSelected}
            disabled={!isEditable}
            className="rounded border-kk-line text-kk-ink focus:ring-0 focus:ring-offset-0 shrink-0 disabled:opacity-40"
          />
        )}
        {isSaved && (
          <span className="text-[10px] font-medium text-green-700">Saved</span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <label className="text-[10px] text-kk-muted shrink-0">When</label>
          <input
            type="date"
            value={candidate.occurredOn ?? ''}
            onChange={e => setOccurredOn(e.target.value || null)}
            disabled={!isEditable || !candidate.selected}
            className="text-xs text-kk-ink bg-transparent border border-kk-line rounded px-2 py-0.5 focus:outline-none focus:border-kk-ink disabled:opacity-40"
          />
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5">
        <textarea
          value={candidate.body}
          onChange={e => setBody(e.target.value)}
          disabled={!isEditable || !candidate.selected}
          rows={2}
          className="w-full text-sm text-kk-ink bg-transparent resize-none focus:outline-none disabled:opacity-40 leading-relaxed"
        />
      </div>

      {/* Entity refs — always show when selected so "+ Link entity" is reachable even with zero refs */}
      {(candidate.selected || candidate.entityRefs.length > 0 || showAddEntity) && (
        <div className="px-3 pb-2.5 flex flex-wrap gap-1.5 items-start">
          {candidate.entityRefs.map((ref, refIndex) => (
            <EntityRefBlock
              key={`${ref.entity_type}-${ref.name_hint}-${refIndex}`}
              ref={ref}
              locked={!isEditable || !candidate.selected}
              onResolveAmbiguous={entity =>
                updateRef(refIndex, { ...ref, canonical: entity, ambiguousCandidates: [] })
              }
              onRemoveCanonical={() => removeRef(refIndex)}
              onManualLink={entity => handleManualLink(refIndex, entity)}
            />
          ))}

          {/* Add entity */}
          {isEditable && candidate.selected && !showAddEntity && (
            <button
              onClick={() => setShowAddEntity(true)}
              className="text-[11px] text-kk-muted hover:text-kk-ink border border-dashed border-kk-line/60 rounded px-1.5 py-0.5 transition-colors"
            >
              + Link entity
            </button>
          )}
        </div>
      )}

      {showAddEntity && isEditable && (
        <div className="px-3 pb-2.5">
          <EntitySearch
            onSelect={handleAddNewEntity}
            onDismiss={() => setShowAddEntity(false)}
          />
        </div>
      )}

      {/* Save failure error */}
      {isFailed && saveError && (
        <div className="px-3 pb-2.5">
          <p className="text-[11px] text-kk-bad bg-red-50 rounded px-2 py-1">
            {saveError}
          </p>
        </div>
      )}

      {/* Zero-link warning (not shown for saved candidates) */}
      {zeroLinks && (
        <div className="px-3 pb-2.5">
          <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1">
            Choose at least one person, location, or project before saving.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

type Phase = 'capture' | 'analysing' | 'review' | 'error'

export default function QuickCaptureModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()

  // Persistent across steps
  const [rawText,    setRawText]    = useState('')
  const [occurredOn, setOccurredOn] = useState<string>(() => todayCopenhagen())

  // Phase
  const [phase,        setPhase]        = useState<Phase>('capture')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Review
  const [candidates,   setCandidates]   = useState<CandidateUI[]>([])
  const [analysisNote, setAnalysisNote] = useState<string | null>(null)

  // Save state (per-candidate)
  const [saving,     setSaving]     = useState(false)
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})

  // Refs
  const textareaRef  = useRef<HTMLTextAreaElement>(null)
  const analysingRef = useRef(false)

  // Autofocus textarea on open / on back
  useEffect(() => {
    if (phase === 'capture') {
      textareaRef.current?.focus()
    }
  }, [phase])

  // Escape closes modal (unless analysing or actively saving)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'analysing' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase, saving])

  // ── Computed save state ──────────────────────────────────────────────────────

  const savedCount  = candidates.filter(c => saveStates[c.id] === 'saved').length
  const failedCount = candidates.filter(c => saveStates[c.id] === 'failed').length
  // Candidates that will be attempted on next Save/Retry press
  const toSaveCount = candidates.filter(c => c.selected && saveStates[c.id] !== 'saved').length

  const saveLabel = saving
    ? 'Saving…'
    : failedCount > 0
    ? `Retry ${failedCount} ${failedCount === 1 ? 'update' : 'updates'}`
    : toSaveCount === 1
    ? 'Save update'
    : `Save ${toSaveCount} updates`

  const saveDisabled = saving || toSaveCount === 0
  // Back is unavailable once any candidate has been saved (would abandon partial state)
  const backDisabled = saving || savedCount > 0

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleAnalyse() {
    if (!rawText.trim() || analysingRef.current) return
    analysingRef.current = true
    setPhase('analysing')
    setErrorMessage(null)

    const result = await analyzeCapture(rawText.trim(), occurredOn || null)
    analysingRef.current = false

    if ('error' in result) {
      setPhase('error')
      setErrorMessage(result.error)
      return
    }

    setCandidates(enrichedToUI(result.data))
    setAnalysisNote(result.analysisNote)
    setSaveStates({})
    setSaveErrors({})
    setPhase('review')
  }

  function handleBack() {
    setPhase('capture')
    setCandidates([])
    setSaveStates({})
    setSaveErrors({})
  }

  function updateCandidate(id: string, updated: CandidateUI) {
    setCandidates(prev => prev.map(c => c.id === id ? updated : c))
  }

  async function handleSave() {
    if (saving) return

    // Determine candidates to attempt (selected, not yet saved)
    const toAttempt = candidates.filter(c => c.selected && saveStates[c.id] !== 'saved')
    if (toAttempt.length === 0) return

    // Pre-validate ALL candidates to attempt before any persistence begins
    for (const c of toAttempt) {
      const err = validateCandidateForSave(c)
      if (err) {
        // Existing per-card validation UI already surfaces the issue.
        // Don't start saving any candidate.
        return
      }
    }

    // Build payloads — human-reviewed values only; no raw_text, no analysis_note
    const inputs = toAttempt.map(c => ({
      body:         c.body.trim(),
      occurred_on:  c.occurredOn,
      entity_links: canonicalLinks(c),
    }))

    // Mark all as saving, lock UI
    setSaving(true)
    setSaveStates(prev => {
      const next = { ...prev }
      for (const c of toAttempt) next[c.id] = 'saving'
      return next
    })

    // Persist sequentially — one createUpdate() call per candidate inside the action
    const result = await saveApprovedCaptures(inputs)

    if ('error' in result) {
      // Auth/gate failure — mark all as failed
      const newStates: Record<string, SaveState> = {}
      const newErrors: Record<string, string>    = {}
      for (const c of toAttempt) {
        newStates[c.id] = 'failed'
        newErrors[c.id] = 'Failed to save. Please try again.'
      }
      setSaveStates(prev => ({ ...prev, ...newStates }))
      setSaveErrors(prev => ({ ...prev, ...newErrors }))
      setSaving(false)
      return
    }

    // Apply per-candidate results
    const newStates: Record<string, SaveState> = {}
    const newErrors: Record<string, string>    = {}
    for (let i = 0; i < toAttempt.length; i++) {
      const c = toAttempt[i]
      const r = result.results[i]
      newStates[c.id] = r.ok ? 'saved' : 'failed'
      if (!r.ok) newErrors[c.id] = 'Failed to save. Please try again.'
    }

    const mergedStates = { ...saveStates, ...newStates }
    setSaveStates(mergedStates)
    setSaveErrors(prev => ({ ...prev, ...newErrors }))
    setSaving(false)

    // All selected candidates are now saved → close and refresh
    const allDone = candidates
      .filter(c => c.selected)
      .every(c => mergedStates[c.id] === 'saved')

    if (allDone) {
      setRawText('')
      router.refresh()
      onClose()
    }
  }

  // ── Capture step ─────────────────────────────────────────────────────────────

  const captureStep = (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        <textarea
          ref={textareaRef}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          placeholder="What happened?"
          rows={5}
          maxLength={5000}
          className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-xl px-3.5 py-3 resize-none placeholder:text-kk-muted focus:outline-none focus:ring-1 focus:ring-kk-ink/20"
        />
        <div className="flex items-center gap-3">
          <label className="text-xs text-kk-muted shrink-0">Occurred on</label>
          <input
            type="date"
            value={occurredOn}
            onChange={e => setOccurredOn(e.target.value)}
            className="text-xs text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-kk-ink/20"
          />
        </div>
        {phase === 'error' && errorMessage && (
          <p className="text-xs text-kk-bad">{errorMessage}</p>
        )}
      </div>

      <div className="px-6 py-4 border-t border-kk-line flex gap-2 shrink-0">
        <button
          onClick={handleAnalyse}
          disabled={!rawText.trim()}
          className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          Analyse
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Cancel
        </button>
      </div>
    </>
  )

  // ── Analysing step ───────────────────────────────────────────────────────────

  const analysingStep = (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="text-center space-y-2">
        <div className="text-sm text-kk-muted animate-pulse">Analysing…</div>
        <div className="text-xs text-kk-muted/60">Reading the note</div>
      </div>
    </div>
  )

  // ── Review step ──────────────────────────────────────────────────────────────

  const selectedCount = candidates.filter(c => c.selected).length

  const reviewStep = (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">

        {/* Analysis note */}
        {analysisNote && (
          <div className="text-xs text-kk-muted bg-kk-soft rounded-xl px-3.5 py-2.5 leading-relaxed">
            {analysisNote}
          </div>
        )}

        {/* Zero candidates */}
        {candidates.length === 0 && (
          <div className="text-center py-8 space-y-3">
            <p className="text-sm text-kk-muted">
              Nothing here looks worth adding to organisational memory.
            </p>
            <button
              onClick={handleBack}
              className="text-xs text-kk-ink underline"
            >
              Edit note
            </button>
          </div>
        )}

        {/* Select all (>1 candidates) */}
        {candidates.length > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-kk-muted">
              {selectedCount} of {candidates.length} selected
            </span>
            <button
              disabled={saving}
              onClick={() => {
                const allSelected = candidates.every(c => c.selected)
                setCandidates(prev => prev.map(c =>
                  saveStates[c.id] === 'saved' ? c : { ...c, selected: !allSelected }
                ))
              }}
              className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-40"
            >
              {candidates.every(c => c.selected) ? 'Deselect all' : 'Select all'}
            </button>
          </div>
        )}

        {/* Candidate cards */}
        {candidates.map(candidate => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            onChange={updated => updateCandidate(candidate.id, updated)}
            isOnly={candidates.length === 1}
            saveState={saveStates[candidate.id] ?? 'pending'}
            saveError={saveErrors[candidate.id] ?? null}
            locked={saving}
          />
        ))}
      </div>

      <div className="px-6 py-4 border-t border-kk-line flex items-center gap-2 shrink-0">
        <button
          onClick={handleBack}
          disabled={backDisabled}
          className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          disabled={saving}
          className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors disabled:opacity-40"
        >
          Close
        </button>
        <button
          onClick={handleSave}
          disabled={saveDisabled}
          className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {saveLabel}
        </button>
      </div>
    </>
  )

  // ── Modal shell ──────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[8vh]"
      onClick={e => { if (e.target === e.currentTarget && phase !== 'analysing' && !saving) onClose() }}
    >
      <div className="absolute inset-0 bg-black/20" />

      <div className="relative bg-white border border-kk-line rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[84dvh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-kk-line flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-kk-ink">
            {phase === 'review' && candidates.length > 0 ? 'Kockpit will remember' : 'Quick Capture'}
          </h2>
          {phase !== 'analysing' && !saving && (
            <button
              onClick={onClose}
              className="text-kk-muted hover:text-kk-ink text-sm leading-none transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>

        {/* Body — switches by phase */}
        {phase === 'analysing'
          ? analysingStep
          : phase === 'review'
          ? reviewStep
          : captureStep
        }
      </div>
    </div>
  )
}
