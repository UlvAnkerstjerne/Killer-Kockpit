'use client'

import { useEffect, useSyncExternalStore } from 'react'
import {
  dismissStaleVersion,
  getStaleVersionSnapshot,
  isStaleVersionError,
  reportStaleVersion,
  subscribeStaleVersion,
} from '@/lib/client/stale-version'

/**
 * App-wide notice for a tab running an older build than the server.
 *
 * Catches stale Server Action failures that no component handled (they surface
 * as unhandled promise rejections) and offers an explicit Refresh. It does not
 * reload on its own, so text the person has typed is never discarded silently.
 */
export default function StaleVersionBanner() {
  const visible = useSyncExternalStore(subscribeStaleVersion, getStaleVersionSnapshot, () => false)

  useEffect(() => {
    function onRejection(e: PromiseRejectionEvent) {
      if (isStaleVersionError(e.reason)) reportStaleVersion()
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  if (!visible) return null

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-lg border-2 border-[#171717] bg-kraft-light px-4 py-3 text-sm text-kk-ink [box-shadow:4px_4px_0_#555555]"
    >
      <p className="font-semibold">A newer version of Kockpit is available.</p>
      <p className="mt-0.5 text-xs text-kk-muted">
        This tab is out of date, so some actions will fail until it is refreshed. Finish or copy anything
        you have not saved first — refreshing reloads the page.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-[#171717] px-3 py-1.5 text-xs font-semibold text-kraft-light"
        >
          Refresh now
        </button>
        <button
          type="button"
          onClick={dismissStaleVersion}
          className="rounded-lg border border-[#171717]/40 px-3 py-1.5 text-xs text-kk-ink hover:bg-[#B7A486]/25"
        >
          Not yet
        </button>
      </div>
    </div>
  )
}
