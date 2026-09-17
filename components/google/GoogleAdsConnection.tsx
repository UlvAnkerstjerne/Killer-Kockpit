'use client'

import { useState } from 'react'
import type { GoogleAdsProbeResult } from '@/lib/google/ads-types'

export default function GoogleAdsConnection({ enabled }: { enabled: boolean }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<GoogleAdsProbeResult | null>(null)

  async function testAccess() {
    setTesting(true)
    setResult(null)
    try {
      const response = await fetch('/api/google/ads/probe', { cache: 'no-store' })
      setResult(await response.json())
    } catch {
      setResult({ ok: false, error: 'Could not complete the access check. Please try again.' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="rounded-xl border border-kk-line bg-kk-soft p-4" aria-label="Google Ads connection">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-kk-ink">Google Ads</h3>
          <p className="mt-1 text-xs text-kk-muted">
            {enabled ? 'Permission granted. Test access to verify your Ads accounts.' : 'Connect Google Ads for read-only reporting.'}
          </p>
        </div>
        {enabled ? (
          <button type="button" onClick={testAccess} disabled={testing}
            className="rounded-lg bg-kk-ink px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
            {testing ? 'Testing…' : 'Test access'}
          </button>
        ) : (
          <a href="/api/google/connect/ads" className="rounded-lg bg-kk-ink px-3 py-2 text-xs font-semibold text-white">
            Enable Google Ads
          </a>
        )}
      </div>
      {!enabled && (
        <p className="mt-3 text-xs text-kk-muted">
          Google’s permission includes editing access. Kockpit only reads Ads data. Your existing Google connections are preserved.
        </p>
      )}
      <div aria-live="polite">
        {result && (result.ok ? (
          <div className="mt-3 text-xs text-kk-good">
            <p className="font-semibold">Google Ads API access verified.</p>
            {result.customerIds.length ? (
              <p className="mt-1 break-words">Accessible account IDs: {result.customerIds.map(id => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`).join(', ')}</p>
            ) : (
              <p className="mt-1">Google accepted the connection but returned no directly accessible Ads accounts. Check this Google account’s access in Google Ads.</p>
            )}
            <p className="mt-1 text-kk-muted">Checked {new Date(result.checkedAt).toLocaleString('en-GB')}.</p>
          </div>
        ) : (
          <div className="mt-3 text-xs text-kk-bad">
            <p>{result.error}</p>
            {result.code && <p className="mt-1">Error: {result.code}</p>}
            {result.requestId && <p className="mt-1 break-all">Reference: {result.requestId}</p>}
            <a href="/api/google/connect/ads" className="mt-2 inline-block underline">Reconnect Google Ads</a>
          </div>
        ))}
      </div>
    </section>
  )
}
