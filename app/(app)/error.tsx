'use client'

import { useEffect } from 'react'
import { isStaleVersionError } from '@/lib/client/stale-version'

// Route-level error boundary for the authenticated app. Most important case:
// a Server Action called from a tab running an older build throws
// UnrecognizedActionError inside a transition, which React rethrows to here.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const kind = isStaleVersionError(error) ? 'stale' : 'failed'

  useEffect(() => {
    if (kind === 'failed') console.error('[app error boundary]', error)
  }, [error, kind])

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-bold text-kk-ink">
        {kind === 'stale' ? 'This page is out of date' : 'Something went wrong'}
      </h1>
      <p className="mt-2 text-sm text-kk-muted">
        {kind === 'stale'
          ? 'Kockpit was updated while this tab was open. Refresh to load the latest version, then repeat what you were doing.'
          : 'The page hit an unexpected error. You can try again, or refresh to reload it.'}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-[#171717] px-4 py-2 text-sm font-medium text-kraft-light"
        >
          Refresh page
        </button>
        {kind === 'failed' && (
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border-2 border-[#171717] px-4 py-2 text-sm font-medium text-kk-ink"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
