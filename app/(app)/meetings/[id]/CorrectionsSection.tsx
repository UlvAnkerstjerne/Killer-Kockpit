'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { addMeetingCorrection } from '@/lib/actions/meetings'

type Correction = {
  id: string
  body: string
  reason: string | null
  author_id: string | null
  created_at: string
  author: { display_name: string } | null
}

type Props = {
  meetingId: string
  corrections: Correction[]
  canAdd: boolean
}

export default function CorrectionsSection({ meetingId, corrections, canAdd }: Props) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim() || saving) return
    setSaving(true)
    setError(null)

    const result = await addMeetingCorrection(meetingId, { body, reason })

    if (result.error) {
      setError(result.error)
    } else {
      setBody('')
      setReason('')
      router.refresh()
    }
    setSaving(false)
  }

  if (corrections.length === 0 && !canAdd) return null

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">
          Corrections & amendments
          {corrections.length > 0 && (
            <span className="text-kk-muted font-normal ml-1">· {corrections.length}</span>
          )}
        </h2>
      </div>

      {corrections.length > 0 && (
        <div className="divide-y divide-kk-line">
          {corrections.map((c) => (
            <div key={c.id} className="px-5 py-4 space-y-1">
              <p className="text-sm text-kk-ink whitespace-pre-wrap">{c.body}</p>
              {c.reason && (
                <p className="text-xs text-kk-muted">
                  <span className="font-medium">Reason:</span> {c.reason}
                </p>
              )}
              <p className="text-xs text-kk-muted">
                {c.author?.display_name ?? 'Unknown'} ·{' '}
                {new Date(c.created_at).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          ))}
        </div>
      )}

      {corrections.length === 0 && !canAdd && null}

      {canAdd && (
        <div className="px-5 py-4 border-t border-kk-line">
          <form onSubmit={handleSubmit} className="space-y-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Correction or amendment text…"
              rows={3}
              maxLength={5000}
              disabled={saving}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors resize-none"
            />
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              maxLength={500}
              disabled={saving}
              className="w-full px-3 py-2 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!body.trim() || saving}
                className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                {saving ? 'Saving…' : 'Add correction'}
              </button>
            </div>
            {error && <p className="text-xs text-kk-bad">{error}</p>}
          </form>
        </div>
      )}
    </div>
  )
}
