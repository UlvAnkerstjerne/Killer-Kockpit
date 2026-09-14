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
      {/* Status filter bar — unchanged */}
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

      <div className="space-y-1.5">
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
            <div key={id} className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden">

              {/* ── Row 1: name · status · objective · dates · spend (all inline) ── */}
              <div className="px-4 py-2 flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-kk-ink truncate flex-1 min-w-0">{name}</span>
                <span className={[
                  'inline-flex items-center px-1.5 py-px rounded-full text-[11px] font-semibold shrink-0',
                  isActive ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                ].join(' ')}>
                  {statusLabel(status)}
                </span>
                <span className="text-[11px] text-kk-muted shrink-0">
                  {objectiveLabel(objective)} · {fmtDateShort(t.firstDate)}–{fmtDateShort(t.lastDate)}
                </span>
                <span className="text-[11px] text-kk-muted shrink-0">{fmtDKK(t.spend)} spend</span>
              </div>

              {/* ── Row 2: primary → efficiency → supporting → muted metadata ── */}
              <div className="px-4 py-2 border-t border-kk-line flex items-end gap-4 flex-wrap">

                {/* Primary — strongest */}
                <div>
                  <div className="text-[10px] text-kk-muted leading-none mb-0.5">{primary.label}</div>
                  <div className="text-base font-bold text-kk-ink leading-none">{primary.formatted}</div>
                </div>

                {/* Efficiency — second strongest */}
                {primary.efficiency && (
                  <div>
                    <div className="text-[10px] text-kk-muted leading-none mb-0.5">{primary.efficiency.label}</div>
                    <div className="text-sm font-semibold text-kk-ink leading-none">{primary.efficiency.value}</div>
                  </div>
                )}

                {/* Awareness supporting: Video Views, Post Eng — no Reach */}
                {isAwareness && t.videoViews > 0     && <Stat label="Video Views" value={fmt(t.videoViews)} />}
                {isAwareness && t.postEngagement > 0  && <Stat label="Post Eng"   value={fmt(t.postEngagement)} />}
                {isAwareness && avgFreq !== null       && <MutedStat label="Freq"  value={avgFreq.toFixed(2)} />}

                {/* Traffic supporting */}
                {isTraffic && cpm !== null             && <Stat label="CPM"         value={fmtDKK(cpm, 2)} />}
                {isTraffic && ctr !== null             && <Stat label="CTR"         value={ctr.toFixed(2) + '%'} />}
                {isTraffic && t.landingPageViews > 0   && <Stat label="LPV"         value={fmt(t.landingPageViews)} />}
                {isTraffic                              && <Stat label="Impressions" value={fmt(t.impressions)} />}

                {/* Engagement / App / default supporting */}
                {!isAwareness && !isTraffic && cpm !== null    && <Stat label="CPM"         value={fmtDKK(cpm, 2)} />}
                {!isAwareness && !isTraffic                     && <Stat label="Impressions" value={fmt(t.impressions)} />}
                {!isAwareness && !isTraffic && avgFreq !== null && <MutedStat label="Freq"  value={avgFreq.toFixed(2)} />}
              </div>
            </div>
          )
        })}

        {noData.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-xl">
            <div className="px-4 py-2 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                No data synced <span className="font-normal text-kk-muted">· {noData.length}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {noData.map(c => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-2">
                  <span className={[
                    'inline-flex items-center px-1.5 py-px rounded-full text-[11px] font-semibold shrink-0',
                    c.status === 'ACTIVE' ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                  ].join(' ')}>
                    {statusLabel(c.status)}
                  </span>
                  <span className="text-sm text-kk-muted flex-1 truncate">{c.name}</span>
                  <span className="text-[11px] text-kk-muted shrink-0">{objectiveLabel(c.objective)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {visible.length === 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-xl px-4 py-6 text-center">
            <p className="text-sm text-kk-muted">No campaigns match the selected statuses.</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Stat components ──────────────────────────────────────────────────────────

// Supporting stat — normal weight
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-kk-muted leading-none mb-0.5">{label}</div>
      <div className="text-xs font-medium text-kk-ink leading-none">{value}</div>
    </div>
  )
}

// Muted stat — frequency and other quiet metadata
function MutedStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-kk-muted/70 leading-none mb-0.5">{label}</div>
      <div className="text-[10px] text-kk-muted leading-none">{value}</div>
    </div>
  )
}
