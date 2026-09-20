'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { retryTranscription } from '@/lib/actions/recordings'
import type { MeetingRecording } from '@/lib/actions/recordings'

interface Props {
  meetingId:  string
  recordings: MeetingRecording[]
  canManage:  boolean
}

const STATUS_LABELS: Record<string, string> = {
  recording:             'Recording…',
  uploaded:              'Uploading…',
  transcribing:          'Transcribing…',
  needs_speaker_review:  'Needs review',
  complete:              'Transcribed',
  failed:                'Failed',
}

const STATUS_COLORS: Record<string, string> = {
  recording:             'text-red-600',
  uploaded:              'text-kk-muted',
  transcribing:          'text-kk-muted',
  needs_speaker_review:  'text-amber-600',
  complete:              'text-kk-good',
  failed:                'text-kk-bad',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  })
}

function RetryButton({ meetingId, recordingId }: { meetingId: string; recordingId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)

  async function handleRetry() {
    setBusy(true)
    setErr(null)
    const result = await retryTranscription(recordingId)
    if (result.error) {
      setErr(result.error)
      setBusy(false)
    } else {
      router.refresh()
    }
  }

  return (
    <div className="space-y-0.5">
      <button
        onClick={handleRetry}
        disabled={busy}
        className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-40"
      >
        {busy ? 'Retrying…' : 'Retry transcription'}
      </button>
      {err && <p className="text-xs text-kk-bad">{err}</p>}
    </div>
  )
}

export default function InPersonRecordingSection({ meetingId, recordings, canManage }: Props) {
  const hasRecordings = recordings.length > 0

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
        <h2 className="text-sm font-semibold text-kk-ink">In-person recording</h2>
        {canManage && (
          <Link
            href={`/meetings/${meetingId}/record`}
            className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
          >
            + Record
          </Link>
        )}
      </div>

      <div className="px-5 py-4 space-y-3">
        {!hasRecordings && canManage && (
          <Link
            href={`/meetings/${meetingId}/record`}
            className="block w-full text-center py-2.5 border border-dashed border-kk-line rounded-xl text-sm text-kk-muted hover:text-kk-ink hover:border-kk-ink transition-colors"
          >
            Record in person →
          </Link>
        )}

        {!hasRecordings && !canManage && (
          <p className="text-sm text-kk-muted">No recordings.</p>
        )}

        {recordings.map((rec) => {
          const meta = rec.status === 'complete' || rec.status === 'needs_speaker_review'
          return (
            <div key={rec.id} className="space-y-1.5">
              {/* Status row */}
              <div className="flex items-center justify-between">
                <span className={['text-xs font-medium', STATUS_COLORS[rec.status] ?? 'text-kk-muted'].join(' ')}>
                  {STATUS_LABELS[rec.status] ?? rec.status}
                </span>
                <span className="text-xs text-kk-muted">{formatDate(rec.started_at)}</span>
              </div>

              {/* Duration / metadata */}
              {meta && (
                <div className="text-xs text-kk-muted space-x-1">
                  {rec.duration_seconds && (
                    <span>
                      {rec.duration_seconds >= 3600
                        ? `${Math.floor(rec.duration_seconds / 3600)}h ${Math.floor((rec.duration_seconds % 3600) / 60)}m`
                        : `${Math.floor(rec.duration_seconds / 60)}m ${rec.duration_seconds % 60}s`}
                    </span>
                  )}
                </div>
              )}

              {/* Error message */}
              {rec.status === 'failed' && rec.processing_error && (
                <p className="text-xs text-kk-bad">{rec.processing_error}</p>
              )}

              {/* Speaker review link */}
              {rec.status === 'needs_speaker_review' && canManage && (
                <Link
                  href={`/meetings/${meetingId}/record/review/${rec.id}`}
                  className="text-xs text-amber-600 hover:text-amber-700 underline transition-colors"
                >
                  Identify speakers →
                </Link>
              )}

              {/* Retry button */}
              {rec.status === 'failed' && canManage && rec.storage_path && (
                <RetryButton meetingId={meetingId} recordingId={rec.id} />
              )}

              {/* Re-record link — for failed without stored audio */}
              {rec.status === 'failed' && canManage && !rec.storage_path && (
                <Link
                  href={`/meetings/${meetingId}/record`}
                  className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                >
                  Record again
                </Link>
              )}
            </div>
          )
        })}

        {/* New recording link if recordings exist */}
        {hasRecordings && canManage && (
          <div className="pt-1 border-t border-kk-line">
            <Link
              href={`/meetings/${meetingId}/record`}
              className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
            >
              + New recording
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
