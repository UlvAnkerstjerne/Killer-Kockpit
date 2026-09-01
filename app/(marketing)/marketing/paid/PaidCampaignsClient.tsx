'use client'

import type { MetaCampaignRow } from '@/lib/marketing/types/meta'

const STATUS_CLASS: Record<string, string> = {
  ACTIVE:   'bg-green-50 text-green-700',
  PAUSED:   'bg-amber-50 text-amber-700',
  DELETED:  'bg-red-50 text-red-700',
  ARCHIVED: 'bg-kk-muted/10 text-kk-muted',
}

export default function PaidCampaignsClient({ campaigns }: { campaigns: MetaCampaignRow[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="rounded-xl border border-kk-border bg-white p-8 text-center">
        <p className="text-sm font-medium text-kk-ink">No campaigns yet</p>
        <p className="mt-1 text-sm text-kk-muted">
          Meta campaign data will appear here after the first sync completes.
          Ensure <code className="font-mono text-xs">META_AD_ACCOUNT_ID</code> and other required
          env vars are set, then trigger a sync from Settings.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-kk-border bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-kk-border bg-kk-surface">
            <th className="px-4 py-3 text-left font-semibold text-kk-ink">Campaign</th>
            <th className="px-4 py-3 text-left font-semibold text-kk-ink">Objective</th>
            <th className="px-4 py-3 text-left font-semibold text-kk-ink">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-kk-border">
          {campaigns.map((c) => (
            <tr key={c.id} className="hover:bg-kk-surface/50 transition-colors">
              <td className="px-4 py-3 font-medium text-kk-ink">{c.name}</td>
              <td className="px-4 py-3 text-kk-muted capitalize">
                {c.objective?.toLowerCase().replace(/_/g, ' ') ?? '—'}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASS[c.status] ?? 'bg-kk-muted/10 text-kk-muted'}`}
                >
                  {c.status.charAt(0) + c.status.slice(1).toLowerCase()}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
