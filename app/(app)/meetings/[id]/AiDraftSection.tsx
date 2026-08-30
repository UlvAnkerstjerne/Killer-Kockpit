'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { generateMeetingDraft, discardDraft, applyMeetingDraft } from '@/lib/actions/ai-drafts'
import type { MeetingAiDraft } from '@/lib/types'
import type { TaskDraft, DecisionDraft, WaitingOnDraft } from '@/lib/ai/meeting-draft-schema'

type Props = {
  meetingId:       string
  canGenerate:     boolean
  initialDraft:    MeetingAiDraft | null
  hasWorkingNotes: boolean
  meetingStatus:   string
}

export default function AiDraftSection({
  meetingId,
  canGenerate,
  initialDraft,
  hasWorkingNotes,
  meetingStatus,
}: Props) {
  const router = useRouter()

  const [draft,           setDraft]           = useState<MeetingAiDraft | null>(initialDraft)
  const [generating,      setGenerating]      = useState(false)
  const [discarding,      setDiscarding]      = useState(false)
  const [applying,        setApplying]        = useState(false)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [error,           setError]           = useState<string | null>(null)

  // Sync draft state when the server re-renders with a new initialDraft prop
  // (router.refresh() causes the page server component to re-run and pass the
  // newly-created draft, but useState only initialises once at mount time).
  useEffect(() => {
    setDraft(initialDraft)
  }, [initialDraft])

  // ── Generate / Regenerate ───────────────────────────────────────────────────

  async function handleGenerate() {
    setGenerating(true)
    setError(null)

    const result = await generateMeetingDraft(meetingId)

    if (result.error) {
      setError(result.error)
      setGenerating(false)
      return
    }

    router.refresh()
    setGenerating(false)
  }

  // ── Discard ─────────────────────────────────────────────────────────────────

  async function handleDiscard() {
    if (!draft) return
    setDiscarding(true)
    setError(null)

    const result = await discardDraft(draft.id, meetingId)

    if (result.error) {
      setError(result.error)
      setDiscarding(false)
      return
    }

    setDraft(null)
    router.refresh()
    setDiscarding(false)
  }

  // ── Apply ────────────────────────────────────────────────────────────────────

  function handleUseDraft() {
    if (!draft) return
    // If the meeting already has working notes and the draft has minutes, warn first
    if (hasWorkingNotes && draft.output_json.minutes) {
      setConfirmOverwrite(true)
      return
    }
    doApply(true)
  }

  async function doApply(applyWorkingNotes: boolean) {
    if (!draft) return
    setConfirmOverwrite(false)
    setApplying(true)
    setError(null)

    const result = await applyMeetingDraft(draft.id, meetingId, { applyWorkingNotes })

    if (result.error) {
      setError(result.error)
      setApplying(false)
      return
    }

    router.refresh()
    setApplying(false)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const totalOutcomes = draft
    ? draft.output_json.tasks.length +
      draft.output_json.decisions.length +
      draft.output_json.waiting_ons.length
    : 0

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">AI Draft</h2>
      </div>

      <div className="px-5 py-4 space-y-4">

        {/* ── No draft yet ── */}
        {!draft && !generating && (
          <>
            {canGenerate ? (
              <>
                <p className="text-sm text-kk-muted">
                  Generate structured draft minutes and proposed outcomes from this transcript.
                </p>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  Generate Draft
                </button>
              </>
            ) : (
              <p className="text-sm text-kk-muted">No AI draft available.</p>
            )}
          </>
        )}

        {/* ── Generating ── */}
        {generating && (
          <p className="text-sm text-kk-muted animate-pulse">Generating…</p>
        )}

        {/* ── Draft preview ── */}
        {draft && !generating && (
          <>
            {/* Metadata */}
            <div className="text-xs text-kk-muted space-x-2">
              <span>Generated {formatDate(draft.generated_at)}</span>
              <span>·</span>
              <span className="font-mono">{draft.model}</span>
            </div>

            {/* Applied state — compact */}
            {draft.applied_at ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 px-2 py-1 rounded-lg">
                    ✦ AI draft applied
                  </span>
                </div>
                <p className="text-sm text-kk-muted">
                  {totalOutcomes} proposed outcome{totalOutcomes !== 1 ? 's' : ''} added to the review queue.
                </p>
                {meetingStatus === 'draft' && (
                  <Link
                    href={`/meetings/${meetingId}/publish`}
                    className="inline-block text-sm px-4 py-2 bg-kk-good-bg text-kk-good rounded-xl hover:opacity-90 transition-opacity font-medium"
                  >
                    Review &amp; Publish →
                  </Link>
                )}
                {meetingStatus !== 'draft' && (
                  <p className="text-xs text-kk-muted">
                    Close the meeting to draft status to review and publish.
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Minutes */}
                <div>
                  <h3 className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-1.5">
                    Draft Minutes
                  </h3>
                  <div className="text-sm text-kk-ink whitespace-pre-wrap bg-kk-soft border border-kk-line rounded-xl px-4 py-3 leading-relaxed">
                    {draft.output_json.minutes}
                  </div>
                </div>

                {/* Tasks */}
                {draft.output_json.tasks.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-2">
                      Proposed Tasks ({draft.output_json.tasks.length})
                    </h3>
                    <ul className="space-y-2">
                      {draft.output_json.tasks.map((task: TaskDraft, i: number) => (
                        <li key={i} className="text-sm bg-kk-soft border border-kk-line rounded-xl px-4 py-3 space-y-1">
                          <div className="font-medium text-kk-ink">{task.title}</div>
                          {task.owner_display_name && (
                            <div className="text-xs text-kk-muted">Owner: {task.owner_display_name}</div>
                          )}
                          {task.deadline_evidence && (
                            <div className="text-xs text-kk-muted italic">
                              &ldquo;{task.deadline_evidence}&rdquo;
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Decisions */}
                {draft.output_json.decisions.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-2">
                      Proposed Decisions ({draft.output_json.decisions.length})
                    </h3>
                    <ul className="space-y-2">
                      {draft.output_json.decisions.map((dec: DecisionDraft, i: number) => (
                        <li key={i} className="text-sm bg-kk-soft border border-kk-line rounded-xl px-4 py-3 space-y-1">
                          <div className="font-medium text-kk-ink">{dec.title}</div>
                          <div className="text-kk-muted">{dec.decision_text}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Waiting ons */}
                {draft.output_json.waiting_ons.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-2">
                      Proposed Waiting Ons ({draft.output_json.waiting_ons.length})
                    </h3>
                    <ul className="space-y-2">
                      {draft.output_json.waiting_ons.map((wo: WaitingOnDraft, i: number) => (
                        <li key={i} className="text-sm bg-kk-soft border border-kk-line rounded-xl px-4 py-3 space-y-1">
                          <div className="font-medium text-kk-ink">{wo.title}</div>
                          {wo.waiting_for && (
                            <div className="text-xs text-kk-muted">Waiting for: {wo.waiting_for}</div>
                          )}
                          {wo.owner_display_name && (
                            <div className="text-xs text-kk-muted">Owner: {wo.owner_display_name}</div>
                          )}
                          {wo.deadline_evidence && (
                            <div className="text-xs text-kk-muted italic">
                              &ldquo;{wo.deadline_evidence}&rdquo;
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Empty result notice */}
                {draft.output_json.tasks.length === 0 &&
                 draft.output_json.decisions.length === 0 &&
                 draft.output_json.waiting_ons.length === 0 && (
                  <p className="text-xs text-kk-muted">
                    No proposed tasks, decisions, or waiting ons were extracted.
                  </p>
                )}

                {/* Overwrite confirm dialog */}
                {confirmOverwrite && (
                  <div className="bg-kk-warn-bg border border-kk-warn/30 rounded-xl px-4 py-3 space-y-3">
                    <p className="text-sm text-kk-ink">
                      This will replace your current working notes with the AI draft minutes.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => doApply(true)}
                        disabled={applying}
                        className="px-3 py-1.5 bg-kk-ink text-white text-xs rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40"
                      >
                        {applying ? 'Applying…' : 'Replace notes'}
                      </button>
                      <button
                        onClick={() => doApply(false)}
                        disabled={applying}
                        className="px-3 py-1.5 border border-kk-line text-xs text-kk-muted rounded-lg hover:bg-kk-soft transition-colors disabled:opacity-40"
                      >
                        Keep existing notes
                      </button>
                      <button
                        onClick={() => setConfirmOverwrite(false)}
                        disabled={applying}
                        className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Actions */}
                {canGenerate && !confirmOverwrite && (
                  <div className="flex items-center gap-3 pt-1 flex-wrap">
                    <button
                      onClick={handleUseDraft}
                      disabled={applying || discarding || generating}
                      className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {applying ? 'Applying…' : 'Use this draft'}
                    </button>
                    <button
                      onClick={handleGenerate}
                      disabled={generating || discarding || applying}
                      className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-40"
                    >
                      Regenerate
                    </button>
                    <button
                      onClick={handleDiscard}
                      disabled={generating || discarding || applying}
                      className="text-xs text-kk-muted hover:text-kk-bad transition-colors disabled:opacity-40"
                    >
                      {discarding ? 'Discarding…' : 'Discard draft'}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs text-kk-bad">{error}</p>
        )}
      </div>
    </div>
  )
}
