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

function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function objectiveLabel(obj: string | null): string {
  if (!obj) return '—'
  return (
    { OUTCOME_AWARENESS: 'Awareness', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_APP_PROMOTION: 'App' }[obj] ?? obj
  )
}

function statusLabel(s: string): string {
  return ({ ACTIVE: 'Active', PAUSED: 'Paused', ARCHIVED: 'Archived', DELETED: 'Deleted' } as Record<string, string>)[s]
    ?? s.charAt(0) + s.slice(1).toLowerCase()
}

// ─── Primary metric ───────────────────────────────────────────────────────────

function getPrimary(objective: string | null, t: CampaignTotals) {
  const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null

  // Awareness: Impressions is the headline (Reach is a cumulative daily sum, not a true unique count)
  if (objective === 'OUTCOME_AWARENESS') {
    return { label: 'Impressions', formatted: fmt(t.impressions), efficiency: cpm !== null ? { label: 'CPM', value: fmtDKK(cpm, 2) } : null }
  }
  if (objective === 'OUTCOME_TRAFFIC') {
    const lpvShare = t.linkClicks > 0 ? t.landingPageViews / t.linkClicks : 0
    if (lpvShare > 0.1 && t.landingPageViews > 0) {
      const costPerLPV = t.spend / t.landingPageViews
      return { label: 'LPVs', formatted: fmt(t.landingPageViews), efficiency: { label: 'Cost / LPV', value: fmtDKK(costPerLPV, 2) } }
    }
    const costPerClick = t.linkClicks > 0 ? t.spend / t.linkClicks : null
    return {
      label: 'Link Clicks', formatted: fmt(t.linkClicks),
      efficiency: costPerClick !== null ? { label: 'Cost / Click', value: fmtDKK(costPerClick, 2) } : null,
    }
  }
  if (objective === 'OUTCOME_ENGAGEMENT') {
    const costPer = t.postEngagement > 0 ? t.spend / t.postEngagement : null
    return {
      label: 'Post Engagements', formatted: fmt(t.postEngagement),
      efficiency: costPer !== null ? { label: 'Cost / Eng', value: fmtDKK(costPer, 2) } : null,
    }
  }
  return { label: 'Impressions', formatted: fmt(t.impressions), efficiency: cpm !== null ? { label: 'CPM', value: fmtDKK(cpm, 2) } : null }
}

// ─── Filter config ─────────────────────────────────────────────────────────────

const STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'] as const
const DEFAULT_STATUSES = ['ACTIVE']

// ─── Component ────────────────────────────────────────────────────────────────

export default function PaidPageClient({ campaigns }: { campaigns: CampaignCardData[] }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const rawSelected = searchParams.getAll('s')
  const selected = rawSelected.length > 0 ? rawSelected : DEFAULT_STATUSES

  const toggle = useCallback((status: string) => {
    const next = selected.includes(status)
      ? selected.filter(s => s !== status)
      : [...selected, status]
    if (next.length === 0) return
    const params = new URLSearchParams()
    next.forEach(s => params.append('s', s))
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [selected, router, pathname])

  const visible  = campaigns.filter(c => selected.includes(c.status))
  const withData = visible.filter(c => c.totals !== null)
  const noData   = visible.filter(c => c.totals === null)

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

      <div className="space-y-2">
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

              {/* ── Header: name + meta + spend ── */}
              <div className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-kk-ink truncate">{name}</div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className={[
                      'inline-flex items-center px-1.5 py-px rounded-full text-xs font-semibold shrink-0',
                      isActive ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                    ].join(' ')}>
                      {statusLabel(status)}
                    </span>
                    <span className="text-xs text-kk-muted">
                      {objectiveLabel(objective)} · {fmtDateShort(t.firstDate)}–{fmtDateShort(t.lastDate)}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-kk-muted">{fmtDKK(t.spend)}</div>
                  <div className="text-xs text-kk-muted opacity-60">spend</div>
                </div>
              </div>

              {/* ── Metrics: primary → efficiency → secondary ── */}
              <div className="px-4 py-2.5 border-t border-kk-line flex items-center gap-5 flex-wrap">
                {/* Primary — slightly larger */}
                <div>
                  <div className="text-xs text-kk-muted">{primary.label}</div>
                  <div className="text-xl font-black text-kk-ink leading-none">{primary.formatted}</div>
                </div>

                {/* Efficiency */}
                {primary.efficiency && <Stat label={primary.efficiency.label} value={primary.efficiency.value} />}

                {/* Objective-specific secondary */}
                {isAwareness && (
                  <>
                    {t.videoViews > 0    && <Stat label="Video Views"     value={fmt(t.videoViews)} />}
                    {t.postEngagement > 0 && <Stat label="Post Engagement" value={fmt(t.postEngagement)} />}
                    {avgFreq !== null     && <Stat label="Frequency"       value={avgFreq.toFixed(2)} />}
                    <Stat label="Reach ↻" value={fmt(t.reach)} />
                  </>
                )}

                {isTraffic && (
                  <>
                    {cpm !== null  && <Stat label="CPM"         value={fmtDKK(cpm, 2)} />}
                    {ctr !== null  && <Stat label="CTR"         value={ctr.toFixed(2) + '%'} />}
                    {t.landingPageViews > 0 && <Stat label="LPV" value={fmt(t.landingPageViews)} />}
                    <Stat label="Impressions" value={fmt(t.impressions)} />
                  </>
                )}

                {!isAwareness && !isTraffic && (
                  <>
                    {cpm !== null  && <Stat label="CPM"         value={fmtDKK(cpm, 2)} />}
                    <Stat label="Impressions" value={fmt(t.impressions)} />
                    {avgFreq !== null && <Stat label="Frequency"  value={avgFreq.toFixed(2)} />}
                  </>
                )}
              </div>
            </div>
          )
        })}

        {noData.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-4 py-3 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                No data synced <span className="font-normal text-kk-muted">· {noData.length}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {noData.map(c => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={[
                    'inline-flex items-center px-1.5 py-px rounded-full text-xs font-semibold shrink-0',
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
          <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-6 text-center">
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
