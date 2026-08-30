'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { syncMeetingToCalendar } from '@/lib/actions/google'
import type { GoogleConnectionStatus } from '@/lib/google/auth'

type Props = {
  meetingId: string
  canEdit: boolean
  hasScheduledTime: boolean
  googleStatus: GoogleConnectionStatus
  // Current sync state from the meeting row
  calendarEventId:    string | null
  calendarEventUrl:   string | null
  calendarSyncStatus: 'synced' | 'failed' | 'pending' | null
  calendarSyncError:  string | null
  calendarSyncedAt:   string | null
  /** Permanent Meet space name (e.g. "spaces/AbCd…"). null = no conference yet. */
  meetSpaceName: string | null
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
  const [syncing, setSyncing]       = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [meetWarning, setMeetWarning] = useState<string | null>(null)

  // Only show the section if the user can edit or there's already a linked event
  if (!canEdit && !calendarEventId) return null

  async function handleSync() {
    setSyncing(true)
    setActionError(null)
    setMeetWarning(null)
    const result = await syncMeetingToCalendar(meetingId)
    if (result.error) {
      setActionError(result.error)
    } else if (result.data?.meetWarning) {
      setMeetWarning(result.data.meetWarning)
    }
    router.refresh()
    setSyncing(false)
  }

  const meetEnabled = googleStatus.connected && googleStatus.meetEnabled

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Google Calendar</h2>
      </div>

      <div className="px-5 py-4 space-y-3">

        {/* ── Not connected ── */}
        {!googleStatus.connected && (
          <p className="text-sm text-kk-muted">
            Google Calendar is not connected.{' '}
            <a href="/settings" className="underline hover:text-kk-ink transition-colors">
              Connect in Settings
            </a>{' '}
            to send meetings to the shared management calendar.
          </p>
        )}

        {/* ── Connected but no scheduled time ── */}
        {googleStatus.connected && !hasScheduledTime && !calendarEventId && (
          <p className="text-sm text-kk-muted">
            Add a scheduled start and end time to enable Calendar sync.
          </p>
        )}

        {/* ── Connected, ready to send ── */}
        {googleStatus.connected && hasScheduledTime && !calendarEventId && canEdit && (
          <>
            <p className="text-xs text-kk-muted">
              Creates an event on the shared management calendar and invites all attendees.
            </p>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-4 py-2 bg-kk-ink text-white text-sm rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {syncing ? 'Sending…' : 'Send to Google Calendar'}
            </button>
          </>
        )}

        {/* ── Pending / in progress ── */}
        {calendarSyncStatus === 'pending' && (
          <div className="flex items-center gap-2 text-sm text-kk-muted">
            <span className="w-4 h-4 border-2 border-kk-muted border-t-kk-ink rounded-full animate-spin shrink-0" />
            Syncing…
          </div>
        )}

        {/* ── Synced ── */}
        {calendarSyncStatus === 'synced' && calendarEventId && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-kk-good shrink-0" />
              <span className="text-sm text-kk-ink font-medium">Synced to Calendar</span>
            </div>
            {calendarEventUrl ? (
              <a
                href={calendarEventUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-kk-muted hover:text-kk-ink underline transition-colors"
              >
                Open in Google Calendar ↗
              </a>
            ) : null}
            {calendarSyncedAt && (
              <div className="text-xs text-kk-muted">
                Last synced{' '}
                {new Date(calendarSyncedAt).toLocaleString('en-GB', {
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            )}
            {canEdit && (
              <button
                onClick={handleSync}
                disabled={syncing}
                className="text-xs text-kk-muted hover:text-kk-ink underline transition-colors disabled:opacity-40"
              >
                {syncing ? 'Updating…' : 'Resync attendees / time'}
              </button>
            )}
          </div>
        )}

        {/* ── Failed ── */}
        {calendarSyncStatus === 'failed' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-kk-bad shrink-0" />
              <span className="text-sm text-kk-bad font-medium">Sync failed</span>
            </div>
            {calendarSyncError && (
              <p className="text-xs text-kk-muted">{calendarSyncError}</p>
            )}
            {canEdit && (
              <button
                onClick={handleSync}
                disabled={syncing}
                className="px-3 py-1.5 border border-kk-line text-xs text-kk-ink rounded-lg hover:bg-kk-soft transition-colors disabled:opacity-40"
              >
                {syncing ? 'Retrying…' : 'Retry sync'}
              </button>
            )}
          </div>
        )}

        {/* ── Google Meet status (shown when Calendar is synced) ── */}
        {calendarSyncStatus === 'synced' && calendarEventId && (
          <div className="pt-1 border-t border-kk-line space-y-1">
            <div className="flex items-center gap-2">
              {meetSpaceName ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-kk-good shrink-0" />
                  <span className="text-xs text-kk-ink font-medium">Google Meet created</span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-kk-muted shrink-0" />
                  <span className="text-xs text-kk-muted">No Meet conference</span>
                </>
              )}
            </div>
            {meetSpaceName && (
              <div className="flex items-center gap-2">
                {meetEnabled ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-kk-good shrink-0" />
                    <span className="text-xs text-kk-ink font-medium">Transcription: automatic</span>
                  </>
                ) : (
                  <>
                    <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                    <span className="text-xs text-kk-muted">
                      Transcription: not configured —{' '}
                      <a href="/settings" className="underline hover:text-kk-ink transition-colors">
                        enable Google Meet
                      </a>
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Meet warning from most recent sync (transient, cleared on next sync) */}
        {meetWarning && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {meetWarning}
          </p>
        )}

        {/* Action-level error (e.g. permission denied) */}
        {actionError && (
          <p className="text-xs text-kk-bad">{actionError}</p>
        )}
      </div>
    </div>
  )
}
