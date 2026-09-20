'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateSpeakerMapping } from '@/lib/actions/recordings'
import type { SpeakerReviewItem, SpeakerMapping } from '@/lib/assemblyai/transcript'

interface Props {
  meetingId:        string
  recordingId:      string
  reviewItems:      SpeakerReviewItem[]
  expectedSpeakers: string[]
}

export default function SpeakerReviewClient({
  meetingId,
  recordingId,
  reviewItems,
  expectedSpeakers,
}: Props) {
  const router = useRouter()

  // Initialize names from currentName (may be generic label)
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      reviewItems.map((item) => [item.label, item.isGeneric ? '' : item.currentName])
    )
  )

  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleNameChange(label: string, value: string) {
    setNames((prev) => ({ ...prev, [label]: value }))
  }

  function pickSuggestion(label: string, name: string) {
    setNames((prev) => ({ ...prev, [label]: name }))
  }

  // Available suggestions: expected speakers not yet assigned to another label
  function getSuggestions(forLabel: string): string[] {
    const usedByOthers = new Set(
      Object.entries(names)
        .filter(([lbl]) => lbl !== forLabel)
        .map(([, n]) => n)
        .filter(Boolean)
    )
    return expectedSpeakers.filter((s) => !usedByOthers.has(s))
  }

  const allNamed = reviewItems.every((item) => (names[item.label] ?? '').trim().length > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!allNamed || busy) return

    setBusy(true)
    setError(null)

    const mapping: SpeakerMapping = {}
    for (const item of reviewItems) {
      const name = (names[item.label] ?? '').trim()
      mapping[item.label] = name || item.label
    }

    const result = await updateSpeakerMapping(recordingId, mapping)

    if (result.error) {
      setError(result.error)
      setBusy(false)
      return
    }

    router.push(`/meetings/${meetingId}`)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {reviewItems.map((item) => {
        const suggestions = getSuggestions(item.label)
        return (
          <div key={item.label} className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4 space-y-3">
            {/* Speaker label badge */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-semibold text-kk-muted bg-kk-soft border border-kk-line rounded px-1.5 py-0.5">
                Speaker {item.label}
              </span>
              {item.isGeneric && (
                <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                  Needs name
                </span>
              )}
            </div>

            {/* Sample utterance */}
            <p className="text-xs text-kk-muted italic">&ldquo;{item.sampleText}&rdquo;</p>

            {/* Name input */}
            <div className="space-y-2">
              <input
                type="text"
                value={names[item.label] ?? ''}
                onChange={(e) => handleNameChange(item.label, e.target.value)}
                placeholder="Enter speaker name"
                className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
                disabled={busy}
              />

              {/* Quick-pick suggestions */}
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => pickSuggestion(item.label, s)}
                      className="text-xs px-2.5 py-1 rounded-lg border border-kk-line text-kk-ink hover:bg-kk-soft transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {error && <p className="text-xs text-kk-bad">{error}</p>}

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={!allNamed || busy}
          className="flex-1 py-3 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {busy ? 'Saving…' : 'Save speaker names'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/meetings/${meetingId}`)}
          disabled={busy}
          className="px-4 py-3 border border-kk-line text-sm text-kk-muted rounded-xl hover:text-kk-ink transition-colors disabled:opacity-40"
        >
          Skip
        </button>
      </div>
    </form>
  )
}
