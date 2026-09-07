'use client'

/**
 * components/updates/EntityUpdatesSection.tsx
 *
 * General-purpose Universal Updates section — works for any canonical
 * entity type (project, employee, location).
 *
 * Same compact institutional timeline presentation across all surfaces.
 * The context entity is implicit; no entity picker is shown here.
 * Quick Capture is the multi-entity natural-language workflow.
 *
 * M8C2: each current Update exposes a restrained "Correct" action that opens
 * an inline correction form.  Correction creates an immutable successor row
 * via correctUpdate(); the original is never mutated.
 */

import { useState, useTransition } from 'react'
import { useRouter }               from 'next/navigation'
import { createUpdate, correctUpdate } from '@/lib/actions/updates'
import { formatUpdateDate }        from '@/lib/utils/format-update-date'
import type { KkUpdateEntityType, UpdateRow } from '@/lib/types'

interface Props {
  entityType:     KkUpdateEntityType
  entityId:       string
  initialUpdates: UpdateRow[]
  canAddUpdate:   boolean
}

export default function EntityUpdatesSection({
  entityType,
  entityId,
  initialUpdates,
  canAddUpdate,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // ── Create-update state ────────────────────────────────────────────────────
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [body,       setBody]       = useState('')
  const [occurredOn, setOccurredOn] = useState('')
  const [error,      setError]      = useState<string | null>(null)

  // ── Correction state ───────────────────────────────────────────────────────
  const [correctingId,         setCorrectingId]         = useState<string | null>(null)
  const [correctedBody,        setCorrectedBody]        = useState('')
  const [correctedOccurredOn,  setCorrectedOccurredOn]  = useState('')
  const [correctionError,      setCorrectionError]      = useState<string | null>(null)

  // ── Create-update handlers ─────────────────────────────────────────────────
  function openComposer() {
    setBody('')
    setOccurredOn('')
    setError(null)
    setIsComposerOpen(true)
  }

  function closeComposer() {
    setIsComposerOpen(false)
    setError(null)
  }

  function handleSubmit() {
    if (!body.trim()) return
    setError(null)

    startTransition(async () => {
      const result = await createUpdate({
        body,
        occurred_on:  occurredOn || null,
        entity_links: [{ entity_type: entityType, entity_id: entityId }],
      })

      if (result.error) {
        setError(result.error)
        return
      }

      setIsComposerOpen(false)
      setBody('')
      setOccurredOn('')
      router.refresh()
    })
  }

  // ── Correction handlers ────────────────────────────────────────────────────
  function openCorrection(update: UpdateRow) {
    setCorrectingId(update.id)
    setCorrectedBody(update.body)
    setCorrectedOccurredOn(update.occurred_on ?? '')
    setCorrectionError(null)
    // Close the create composer if open
    setIsComposerOpen(false)
  }

  function closeCorrection() {
    setCorrectingId(null)
    setCorrectionError(null)
  }

  function handleCorrectSubmit(updateId: string) {
    if (!correctedBody.trim()) return
    setCorrectionError(null)

    startTransition(async () => {
      const result = await correctUpdate({
        updateId,
        body:        correctedBody,
        occurred_on: correctedOccurredOn || null,
      })

      if (result.error) {
        setCorrectionError(result.error)
        return
      }

      setCorrectingId(null)
      router.refresh()
    })
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Updates</h2>
        {canAddUpdate && !isComposerOpen && (
          <button
            onClick={openComposer}
            className="text-xs px-3 py-1.5 bg-kk-soft border border-kk-line rounded-lg text-kk-ink hover:bg-kk-line transition-colors"
          >
            Add update
          </button>
        )}
      </div>

      {/* Create composer */}
      {isComposerOpen && (
        <div className="px-5 py-4 border-b border-kk-line space-y-3">
          <div>
            <textarea
              placeholder="What changed?"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              disabled={isPending}
              className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 resize-none placeholder:text-kk-muted focus:outline-none focus:ring-1 focus:ring-kk-ink/20 disabled:opacity-60"
            />
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs text-kk-muted shrink-0">Occurred on</label>
            <input
              type="date"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
              disabled={isPending}
              className="text-xs text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-kk-ink/20 disabled:opacity-60"
            />
          </div>

          {error && (
            <p className="text-xs text-kk-bad">{error}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={isPending || !body.trim()}
              className="text-xs px-3 py-1.5 bg-kk-ink text-kk-panel rounded-lg hover:opacity-80 transition-opacity disabled:opacity-40"
            >
              {isPending ? 'Adding…' : 'Add update'}
            </button>
            <button
              onClick={closeComposer}
              disabled={isPending}
              className="text-xs px-3 py-1.5 border border-kk-line text-kk-muted rounded-lg hover:border-kk-ink hover:text-kk-ink transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Update list */}
      <div>
        {initialUpdates.length === 0 && !isComposerOpen && (
          <div className="px-5 py-6 text-sm text-kk-muted text-center">
            No updates yet.
          </div>
        )}

        {initialUpdates.map((update) => (
          <div
            key={update.id}
            className="px-5 py-4 border-b border-kk-line last:border-b-0"
          >
            {/* Correction form */}
            {correctingId === update.id ? (
              <div className="space-y-3">
                <p className="text-xs text-kk-muted">
                  Creates a corrected record. The original remains in history.
                </p>

                <div>
                  <label className="block text-xs text-kk-muted mb-1">Corrected update</label>
                  <textarea
                    value={correctedBody}
                    onChange={(e) => setCorrectedBody(e.target.value)}
                    rows={3}
                    disabled={isPending}
                    className="w-full text-sm text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-3 py-2 resize-none placeholder:text-kk-muted focus:outline-none focus:ring-1 focus:ring-kk-ink/20 disabled:opacity-60"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <label className="text-xs text-kk-muted shrink-0">Occurred on</label>
                  <input
                    type="date"
                    value={correctedOccurredOn}
                    onChange={(e) => setCorrectedOccurredOn(e.target.value)}
                    disabled={isPending}
                    className="text-xs text-kk-ink bg-kk-soft border border-kk-line rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-kk-ink/20 disabled:opacity-60"
                  />
                </div>

                {correctionError && (
                  <p className="text-xs text-kk-bad">{correctionError}</p>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => handleCorrectSubmit(update.id)}
                    disabled={isPending || !correctedBody.trim()}
                    className="text-xs px-3 py-1.5 bg-kk-ink text-kk-panel rounded-lg hover:opacity-80 transition-opacity disabled:opacity-40"
                  >
                    {isPending ? 'Saving…' : 'Save correction'}
                  </button>
                  <button
                    onClick={closeCorrection}
                    disabled={isPending}
                    className="text-xs px-3 py-1.5 border border-kk-line text-kk-muted rounded-lg hover:border-kk-ink hover:text-kk-ink transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-kk-ink leading-relaxed whitespace-pre-wrap">
                  {update.body}
                </p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <p className="text-xs text-kk-muted">
                    {formatUpdateDate(update.occurred_on, update.created_at)}
                    {update.author && (
                      <> · {update.author.display_name}</>
                    )}
                  </p>

                  {/* "Corrected" indicator — this row superseded an older one */}
                  {update.supersedes_update_id && (
                    <span className="text-xs text-kk-muted italic">· Corrected</span>
                  )}

                  {/* Correct action — secondary, only for management */}
                  {canAddUpdate && (
                    <button
                      onClick={() => openCorrection(update)}
                      className="text-xs text-kk-muted hover:text-kk-ink transition-colors ml-auto"
                    >
                      Correct
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
