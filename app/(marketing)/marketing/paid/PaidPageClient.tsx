'use client'

import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CampaignTotals {
  spend: number
  impressions: number
  reach: number
  clicks: number
  linkClicks: number
  landingPageViews: number
  videoViews: number
  postEngagement: number
  days: number
  firstDate: string
  lastDate: string
}

export interface CampaignCardData {
  id: string
  name: string
  status: string
  objective: string | null
  totals: CampaignTotals | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1_000) + 'K'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString('en-GB')
}

function fmtDKK(n: number, decimals = 0): string {
  return n.toLocaleString('da-DK', {
    style: 'currency',
    currency: 'DKK',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function objectiveLabel(obj: string | null): string {
  if (!obj) return '—'
  return (
    { OUTCOME_AWARENESS: 'Awareness', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_APP_PROMOTION: 'App' }[obj] ?? obj
  )
}

function statusLabel(s: string): string {
  return ({ ACTIVE: 'Active', PAUSED: 'Paused', ARCHIVED: 'Archived', DELETED: 'Deleted' } as Record<string, string>)[s] ?? s.charAt(0) + s.slice(1).toLowerCase()
}

function getPrimary(objective: string | null, t: CampaignTotals) {
  const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null

  if (objective === 'OUTCOME_AWARENESS') {
    return {
      label: 'Reach', formatted: fmt(t.reach),
      costLabel: 'CPM', costFormatted: cpm !== null ? fmtDKK(cpm, 2) : null,
      note: 'Cumulative sum of daily reach',
    }
  }
  if (objective === 'OUTCOME_TRAFFIC') {
    const lpvShare = t.linkClicks > 0 ? t.landingPageViews / t.linkClicks : 0
    if (lpvShare > 0.1 && t.landingPageViews > 0) {
      return {
        label: 'Landing Page Views', formatted: fmt(t.landingPageViews),
        costLabel: 'Cost / LPV', costFormatted: fmtDKK(t.spend / t.landingPageViews, 2), note: null,
      }
    }
    return {
      label: 'Link Clicks', formatted: fmt(t.linkClicks),
      costLabel: 'Cost / Click', costFormatted: t.linkClicks > 0 ? fmtDKK(t.spend / t.linkClicks, 2) : null,
      note: `LPV not meaningfully tracked (${fmt(t.landingPageViews)} recorded)`,
    }
  }
  if (objective === 'OUTCOME_ENGAGEMENT') {
    return {
      label: 'Post Engagements', formatted: fmt(t.postEngagement),
      costLabel: 'Cost / Engagement', costFormatted: t.postEngagement > 0 ? fmtDKK(t.spend / t.postEngagement, 2) : null,
      note: null,
    }
  }
  return {
    label: 'Impressions', formatted: fmt(t.impressions),
    costLabel: 'CPM', costFormatted: cpm !== null ? fmtDKK(cpm, 2) : null, note: null,
  }
}

// ─── Filter config ─────────────────────────────────────────────────────────────

const STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'] as const
const DEFAULT_STATUSES = ['ACTIVE']

// ─── Component ────────────────────────────────────────────────────────────────

export default function PaidPageClient({ campaigns }: { campaigns: CampaignCardData[] }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // Read selected statuses from URL; fall back to default
  const rawSelected = searchParams.getAll('s')
  const selected = rawSelected.length > 0 ? rawSelected : DEFAULT_STATUSES

  const toggle = useCallback((status: string) => {
    const next = selected.includes(status)
      ? selected.filter(s => s !== status)
      : [...selected, status]

    // At least one must remain selected
    if (next.length === 0) return

    const params = new URLSearchParams()
    next.forEach(s => params.append('s', s))
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [selected, router, pathname])

  // Filter + split
  const visible = campaigns.filter(c => selected.includes(c.status))
  const withData = visible.filter(c => c.totals !== null)
  const noData   = visible.filter(c => c.totals === null)

  // Only show statuses that exist in data
  const presentStatuses = new Set(campaigns.map(c => c.status))

  return (
    <div className="space-y-4">
      {/* Status filter bar */}
      <div className="flex gap-1 bg-white border border-kk-line rounded-xl p-1 w-fit">
        {STATUSES.filter(s => presentStatuses.has(s)).map(status => {
          const isOn = selected.includes(status)
          return (
            <button
              key={status}
              onClick={() => toggle(status)}
              className={[
                'text-xs px-3 py-1.5 rounded-lg transition-colors',
                isOn ? 'bg-kk-ink text-white font-medium' : 'text-kk-muted hover:text-kk-ink',
              ].join(' ')}
            >
              {statusLabel(status)}
            </button>
          )
        })}
      </div>

      <div className="space-y-3">
        {withData.map(({ id, name, status, objective, totals }) => {
          const t = totals!
          const primary = getPrimary(objective, t)
          const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null
          const ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null
          const avgFreq = t.reach > 0 ? t.impressions / t.reach : null
          const isActive = status === 'ACTIVE'
          const isAwareness = objective === 'OUTCOME_AWARENESS'
          const isTraffic = objective === 'OUTCOME_TRAFFIC'

          return (
            <div key={id} className="bg-kk-panel border border-kk-line rounded-2xl overflow-hidden">
              <div className="px-5 py-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={[
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold shrink-0',
                      isActive ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                    ].join(' ')}>
                      {statusLabel(status)}
                    </span>
                    <span className="text-sm font-semibold text-kk-ink truncate">{name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-kk-muted flex-wrap">
                    <span>{objectiveLabel(objective)}</span>
                    <span>·</span>
                    <span>{t.days} days</span>
                    <span>·</span>
                    <span>{fmtDate(t.firstDate)} – {fmtDate(t.lastDate)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-kk-ink">{fmtDKK(t.spend)}</div>
                  <div className="text-xs text-kk-muted mt-0.5">spend</div>
                </div>
              </div>

              <div className="px-5 pb-4 flex items-end gap-6 flex-wrap">
                <div>
                  <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">{primary.label}</div>
                  <div className="text-3xl font-black text-kk-ink leading-none">{primary.formatted}</div>
                  {primary.note && <div className="text-xs text-kk-muted mt-1 italic">{primary.note}</div>}
                </div>
                {primary.costFormatted && (
                  <div className="pb-0.5">
                    <div className="text-xs font-medium text-kk-muted uppercase tracking-wider mb-1">{primary.costLabel}</div>
                    <div className="text-lg font-bold text-kk-ink">{primary.costFormatted}</div>
                  </div>
                )}
              </div>

              <div className="border-t border-kk-line px-5 py-3 flex items-center gap-5 flex-wrap">
                <Stat label="Impressions" value={fmt(t.impressions)} />
                <Stat label="Reach"       value={fmt(t.reach)} />
                {avgFreq !== null && <Stat label="Avg Frequency" value={avgFreq.toFixed(2)} />}
                {cpm !== null     && <Stat label="CPM"           value={fmtDKK(cpm, 2)} />}
                {isAwareness && t.videoViews > 0     && <Stat label="Video Views"     value={fmt(t.videoViews)} />}
                {isAwareness && t.postEngagement > 0  && <Stat label="Post Engagement" value={fmt(t.postEngagement)} />}
                {isTraffic && (
                  <>
                    <Stat label="Link Clicks" value={fmt(t.linkClicks)} />
                    {ctr !== null && <Stat label="CTR" value={ctr.toFixed(2) + '%'} />}
                    {t.landingPageViews > 0 && <Stat label="LPV" value={fmt(t.landingPageViews)} />}
                  </>
                )}
              </div>
            </div>
          )
        })}

        {noData.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                No data synced <span className="font-normal text-kk-muted">· {noData.length}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {noData.map(c => (
                <div key={c.id} className="flex items-center gap-3 px-5 py-3">
                  <span className={[
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold shrink-0',
                    c.status === 'ACTIVE' ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                  ].join(' ')}>
                    {statusLabel(c.status)}
                  </span>
                  <span className="text-sm text-kk-muted flex-1 truncate">{c.name}</span>
                  <span className="text-xs text-kk-muted shrink-0">{objectiveLabel(c.objective)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {visible.length === 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-8 text-center">
            <p className="text-sm text-kk-muted">No campaigns match the selected statuses.</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Small stat chip ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-kk-muted">{label}</div>
      <div className="text-sm font-semibold text-kk-ink">{value}</div>
    </div>
  )
}
