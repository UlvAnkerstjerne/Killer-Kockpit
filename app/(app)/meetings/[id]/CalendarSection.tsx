'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { syncMeetingToCalendar } from '@/lib/actions/google'
import type { GoogleConnectionStatus } from '@/lib/google/auth'

type Props = {
  meetingId:          string
  canEdit:            boolean
  hasScheduledTime:   boolean
  googleStatus:       GoogleConnectionStatus
  calendarEventId:    string | null
  calendarEventUrl:   string | null
  calendarSyncStatus: 'synced' | 'failed' | 'pending' | null
  calendarSyncError:  string | null
  calendarSyncedAt:   string | null
  meetSpaceName:      string | null
}

export default function CalendarSection({
  meetingId,
  canEdit,
  hasScheduledTime,
  googleStatus,
  calendarEventId,
  calendarEventUrl,
  calendarSyncStatus,
  calendarSyncError,
  calendarSyncedAt,
  meetSpaceName,
}: Props) {
  const router = useRouter()
  const [syncing,     setSyncing]     = useState(false)
  const [syncError,   setSyncError]   = useState<string | null>(null)
  const [meetWarning, setMeetWarning] = useState<string | null>(null)

  // Hide if not connected and no event exists (nothing to show)
  if (!googleStatus.connected && !calendarEventId) return null

  async function handleSync() {
    setSyncing(true)
    setSyncError(null)
    setMeetWarning(null)
    const result = await syncMeetingToCalendar(meetingId)
    if (result.error) {
      setSyncError(result.error)
    } else if (result.data?.meetWarning) {
      setMeetWarning(result.data.meetWarning)
    }
    router.refresh()
    setSyncing(false)
  }

  const isSynced    = calendarSyncStatus === 'synced' && !!calendarEventId
  const hasMeet     = !!meetSpaceName
  const meetEnabled = googleStatus.connected && googleStatus.meetEnabled

  // Effective error: show API error or transient sync error
  const displayError = syncError ?? (calendarSyncStatus === 'failed' ? calendarSyncError : null)

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl p-4">
      <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide mb-3">Google</div>

      <div className="space-y-2">

        {/* Calendar row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {isSynced ? (
              <span className="w-1.5 h-1.5 rounded-full bg-kk-good shrink-0" />
            ) : calendarSyncStatus === 'pending' ? (
              <span className="w-3 h-3 border border-kk-muted border-t-kk-ink rounded-full animate-spin shrink-0" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-kk-muted shrink-0" />
            )}
            <span className="text-xs text-kk-ink">Calendar</span>
          </div>
          <div className="flex items-center gap-2">
            {calendarEventUrl && (
              <a
                href={calendarEventUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-kk-muted hover:text-kk-ink transition-colors"
                title="Open in Google Calendar"
              >
                ↗
              </a>
            )}
            {canEdit && googleStatus.connected && hasScheduledTime && (
              <button
                onClick={handleSync}
                disabled={syncing}
                className="text-xs text-kk-muted hover:text-kk-ink underline transition-colors disabled:opacity-40"
              >
                {syncing ? '…' : isSynced ? 'Resync' : 'Sync'}
              </button>
            )}
            {canEdit && !googleStatus.connected && (
              <a href="/settings" className="text-xs text-kk-muted hover:text-kk-ink underline transition-colors">
                Connect
              </a>
            )}
            {canEdit && googleStatus.connected && !hasScheduledTime && !isSynced && (
              <span className="text-xs text-kk-muted">Add times to sync</span>
            )}
          </div>
        </div>

        {/* Meet row — only when synced */}
        {isSynced && (
          <div className="flex items-center gap-1.5">
            {hasMeet ? (
              <span className="w-1.5 h-1.5 rounded-full bg-kk-good shrink-0" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-kk-muted shrink-0" />
            )}
            <span className="text-xs text-kk-ink">
              Meet{hasMeet ? '' : ' · not created'}
            </span>
          </div>
        )}

        {/* Transcription row — only when Meet is set up */}
        {isSynced && hasMeet && (
          <div className="flex items-center gap-1.5">
            {meetEnabled ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-kk-good shrink-0" />
                <span className="text-xs text-kk-ink">Transcription · automatic</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs text-kk-muted">
                  Transcription ·{' '}
                  <a href="/settings" className="underline hover:text-kk-ink transition-colors">
                    enable Meet
                  </a>
                </span>
              </>
            )}
          </div>
        )}

        {/* Last synced */}
        {isSynced && calendarSyncedAt && (
          <div className="text-[10px] text-kk-muted pt-0.5">
            Synced{' '}
            {new Date(calendarSyncedAt).toLocaleString('en-GB', {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
            })}
          </div>
        )}

        {/* Errors and warnings */}
        {displayError && (
          <p className="text-xs text-kk-bad pt-0.5">{displayError}</p>
        )}
        {meetWarning && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            {meetWarning}
          </p>
        )}
      </div>
    </div>
  )
}
