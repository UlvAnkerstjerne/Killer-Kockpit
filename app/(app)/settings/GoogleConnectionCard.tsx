'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { disconnectGoogleCalendar } from '@/lib/actions/google'
import type { GoogleConnectionStatus } from '@/lib/google/auth'

/**
 * Unified Google Workspace connection card.
 *
 * A single Google OAuth token covers both Calendar and Gmail — they are
 * granted incrementally but stored together.  Disconnecting removes everything.
 * The card shows which capabilities are currently enabled and lets the user
 * enable each one individually via the incremental auth routes.
 */
export default function GoogleConnectionCard({
  status,
}: {
  status: GoogleConnectionStatus
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const justConnected = searchParams.get('connected') === 'true'
  const googleError   = searchParams.get('google_error')
  const [disconnecting, setDisconnecting] = useState(false)

  async function handleDisconnect() {
    setDisconnecting(true)
    await disconnectGoogleCalendar()
    router.refresh()
    setDisconnecting(false)
  }

  function googleErrorMessage(code: string): string {
    const map: Record<string, string> = {
      access_denied:         'You cancelled the Google authorisation.',
      state_mismatch:        'CSRF state mismatch — please try again.',
      missing_params:        'Authorisation parameters missing — please try again.',
      token_exchange_failed: 'Token exchange failed. Check your Google credentials.',
      no_refresh_token:
        'Google did not return a refresh token. Disconnect and reconnect to fix this.',
      storage_failed: 'Failed to store credentials — please try again.',
      user_not_found: 'KK user not found.',
    }
    return map[code] ?? `Google error: ${code}`
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      <div className="px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Google Workspace</h2>
        <p className="text-xs text-kk-muted mt-0.5">
          Connect your Google account to enable Calendar, Gmail, and Drive integration.
        </p>
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* Error from OAuth callback */}
        {googleError && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
            {googleErrorMessage(googleError)}
          </div>
        )}

        {/* Success banner */}
        {justConnected && !googleError && (
          <div className="p-3 rounded-xl bg-kk-good-bg border border-kk-good text-xs text-kk-good">
            Google Workspace connected successfully.
          </div>
        )}

        {status.connected ? (
          <>
            {/* Connection status + account */}
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-kk-good shrink-0" />
              <span className="text-sm text-kk-ink font-medium">Connected</span>
              {status.googleAccountEmail && (
                <span className="text-xs text-kk-muted">({status.googleAccountEmail})</span>
              )}
            </div>

            {/* Capability rows */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-xs font-medium text-kk-ink">Calendar</span>
                  <span className="ml-1.5 text-xs text-kk-muted">Sync meetings to shared calendar</span>
                </div>
                {status.calendarEnabled ? (
                  <span className="text-xs text-kk-good shrink-0">Enabled</span>
                ) : (
                  <a
                    href="/api/google/connect"
                    className="text-xs text-kk-ink underline shrink-0 hover:opacity-70 transition-opacity"
                  >
                    Enable →
                  </a>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-xs font-medium text-kk-ink">Gmail</span>
                  <span className="ml-1.5 text-xs text-kk-muted">Triage inbox, capture tasks</span>
                </div>
                {status.gmailEnabled ? (
                  <span className="text-xs text-kk-good shrink-0">Enabled</span>
                ) : (
                  <a
                    href="/api/google/connect/gmail"
                    className="text-xs text-kk-ink underline shrink-0 hover:opacity-70 transition-opacity"
                  >
                    Enable →
                  </a>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-xs font-medium text-kk-ink">Drive</span>
                  <span className="ml-1.5 text-xs text-kk-muted">Attach related documents to projects and meetings</span>
                </div>
                {status.driveEnabled ? (
                  <span className="text-xs text-kk-good shrink-0">Enabled</span>
                ) : (
                  <a
                    href="/api/google/connect/drive"
                    className="text-xs text-kk-ink underline shrink-0 hover:opacity-70 transition-opacity"
                  >
                    Enable →
                  </a>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-xs font-medium text-kk-ink">Google Meet</span>
                  <span className="ml-1.5 text-xs text-kk-muted">Automatic transcription for institutional meetings</span>
                </div>
                {status.meetEnabled ? (
                  <span className="text-xs text-kk-good shrink-0">Enabled</span>
                ) : (
                  <a
                    href="/api/google/connect/meet"
                    className="text-xs text-kk-ink underline shrink-0 hover:opacity-70 transition-opacity"
                  >
                    Enable →
                  </a>
                )}
              </div>
            </div>

            <div className="text-xs text-kk-muted">
              Token expires:{' '}
              {new Date(status.expiresAt).toLocaleString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
              {' '}(auto-refreshes)
            </div>

            <div>
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="text-xs text-kk-bad hover:underline disabled:opacity-40 transition-colors"
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect Google account'}
              </button>
              <p className="text-xs text-kk-muted mt-0.5">
                Disconnects Calendar, Gmail, Drive, and all other Google integrations from Kockpit.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-kk-muted shrink-0" />
              <span className="text-sm text-kk-muted">Not connected</span>
            </div>
            <p className="text-xs text-kk-muted">
              Connect your Google account to enable Calendar, Gmail, and Drive features.
            </p>
            <a
              href="/api/google/connect"
              className="inline-block px-4 py-2 bg-kk-ink text-white text-sm rounded-xl hover:opacity-90 transition-opacity"
            >
              Connect Google →
            </a>
          </>
        )}
      </div>
    </div>
  )
}
