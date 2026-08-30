'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createMeetingOutcome, removeMeetingOutcome } from '@/lib/actions/meeting-outcomes'
import type { MeetingOutcome, MeetingOutcomeKind } from '@/lib/types'

const ENTITY_PATHS: Record<MeetingOutcomeKind, string> = {
  task: '/tasks',
  waiting_on: '/waiting-ons',
  decision: '/decisions',
}

type Props = {
  meetingId: string
  outcomes: MeetingOutcome[]
  canEdit: boolean
  isEditable: boolean
}

const KIND_LABELS: Record<MeetingOutcomeKind, string> = {
  task: 'Task',
  waiting_on: 'Waiting On',
  decision: 'Decision',
}

const KIND_STYLES: Record<MeetingOutcomeKind, string> = {
  task: 'bg-blue-50 text-blue-700',
  waiting_on: 'bg-kk-warn-bg text-kk-warn',
  decision: 'bg-purple-50 text-purple-700',
}

export default function OutcomesSection({ meetingId, outcomes, canEdit, isEditable }: Props) {
  const router = useRouter()
  const [kind, setKind] = useState<MeetingOutcomeKind>('task')
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const proposed = outcomes.filter((o) => o.status === 'proposed')
  const published = outcomes.filter((o) => o.status === 'published')

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || adding) return
    setAdding(true)
    setError(null)

    const result = await createMeetingOutcome(meetingId, {
      kind,
      title,
      sort_order: proposed.length,
    })

    if (result.error) {
      setError(result.error)
    } else {
      setTitle('')
      router.refresh()
    }
    setAdding(false)
  }

  async function handleRemove(outcomeId: string) {
    const result = await removeMeetingOutcome(outcomeId, meetingId)
    if (!result.error) router.refresh()
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Proposed outcomes
          {proposed.length > 0 && (
            <span className="text-kk-muted font-normal ml-1">· {proposed.length}</span>
          )}
        </h2>
      </div>

      <div className="divide-y divide-kk-line">
        {proposed.map((outcome) => (
          <div key={outcome.id} className="flex items-center gap-3 px-5 py-3">
            <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${KIND_STYLES[outcome.kind]}`}>
              {KIND_LABELS[outcome.kind]}
            </span>
            <span className="text-sm text-kk-ink flex-1 truncate">{outcome.title}</span>
            {canEdit && isEditable && (
              <button
                onClick={() => handleRemove(outcome.id)}
                className="text-xs text-kk-muted hover:text-kk-bad transition-colors shrink-0"
              >
                Remove
              </button>
            )}
          </div>
        ))}

        {proposed.length === 0 && (
          <div className="px-5 py-4 text-sm text-kk-muted">No proposed outcomes yet.</div>
        )}
      </div>

      {published.length > 0 && (
        <>
          <div className="px-5 py-3 border-t border-kk-line">
            <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-2">Published outcomes</div>
            <div className="space-y-2">
              {published.map((outcome) => (
                <div key={outcome.id} className="flex items-center gap-2">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${KIND_STYLES[outcome.kind]}`}>
                    {KIND_LABELS[outcome.kind]}
                  </span>
                  {outcome.published_entity_id ? (
                    <Link
                      href={`${ENTITY_PATHS[outcome.kind]}/${outcome.published_entity_id}`}
                      className="text-sm text-kk-ink hover:underline truncate"
                    >
                      {outcome.title}
                    </Link>
                  ) : (
                    <span className="text-sm text-kk-muted truncate">{outcome.title}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {canEdit && isEditable && (
        <div className="px-5 py-3 border-t border-kk-line">
          <form onSubmit={handleAdd} className="space-y-2">
            <div className="flex gap-2">
              {(['task', 'waiting_on', 'decision'] as MeetingOutcomeKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    kind === k ? 'bg-kk-ink text-white border-kk-ink' : 'border-kk-line text-kk-muted hover:bg-kk-soft'
                  }`}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`Add ${KIND_LABELS[kind].toLowerCase()}…`}
                maxLength={500}
                disabled={adding}
                className="flex-1 px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
              />
              <button
                type="submit"
                disabled={!title.trim() || adding}
                className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                Add
              </button>
            </div>
          </form>
          {error && <p className="text-xs text-kk-bad mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}
