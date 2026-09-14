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

// ─── Metric cells ─────────────────────────────────────────────────────────────
// Always returns exactly 6 cells so every card has identical column positions.

type MetricCell = { label: string; value: string }

function getMetricCells(objective: string | null, t: CampaignTotals): [MetricCell, MetricCell, MetricCell, MetricCell, MetricCell, MetricCell] {
  const cpm     = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null
  const ctr     = t.impressions > 0 ? (t.clicks / t.impressions) * 100  : null
  const avgFreq = t.reach > 0       ? t.impressions / t.reach            : null

  // ── Awareness ─────────────────────────────────────────────────────────────
  if (objective === 'OUTCOME_AWARENESS') {
    return [
      { label: 'Impressions', value: fmt(t.impressions) },
      { label: 'CPM',         value: cpm !== null ? fmtDKK(cpm, 2) : '—' },
      { label: 'Video Views', value: t.videoViews > 0     ? fmt(t.videoViews)     : '—' },
      { label: 'Post Eng',    value: t.postEngagement > 0 ? fmt(t.postEngagement) : '—' },
      { label: 'Freq',        value: avgFreq !== null ? avgFreq.toFixed(2) : '—' },
      { label: 'Spend',       value: fmtDKK(t.spend) },
    ]
  }

  // ── Traffic — preserve existing primary/efficiency logic ──────────────────
  if (objective === 'OUTCOME_TRAFFIC') {
    const lpvShare = t.linkClicks > 0 ? t.landingPageViews / t.linkClicks : 0
    const useLPV   = lpvShare > 0.1 && t.landingPageViews > 0
    const effLabel = useLPV ? 'Cost / LPV'   : 'Cost / Click'
    const effValue = useLPV
      ? (t.landingPageViews > 0 ? fmtDKK(t.spend / t.landingPageViews, 2) : '—')
      : (t.linkClicks > 0       ? fmtDKK(t.spend / t.linkClicks, 2)       : '—')
    return [
      { label: useLPV ? 'LPVs' : 'Link Clicks', value: useLPV ? fmt(t.landingPageViews) : fmt(t.linkClicks) },
      { label: effLabel,      value: effValue },
      { label: 'CPM',         value: cpm !== null ? fmtDKK(cpm, 2)       : '—' },
      { label: 'CTR',         value: ctr !== null ? ctr.toFixed(2) + '%' : '—' },
      { label: 'Impressions', value: fmt(t.impressions) },
      { label: 'Spend',       value: fmtDKK(t.spend) },
    ]
  }

  // ── Engagement — preserve existing logic ───────────────────────────────────
  if (objective === 'OUTCOME_ENGAGEMENT') {
    const costPer = t.postEngagement > 0 ? t.spend / t.postEngagement : null
    return [
      { label: 'Post Eng',    value: fmt(t.postEngagement) },
      { label: 'Cost / Eng',  value: costPer !== null ? fmtDKK(costPer, 2) : '—' },
      { label: 'CPM',         value: cpm !== null ? fmtDKK(cpm, 2) : '—' },
      { label: 'Impressions', value: fmt(t.impressions) },
      { label: 'Freq',        value: avgFreq !== null ? avgFreq.toFixed(2) : '—' },
      { label: 'Spend',       value: fmtDKK(t.spend) },
    ]
  }

  // ── Default / App ──────────────────────────────────────────────────────────
  return [
    { label: 'Impressions', value: fmt(t.impressions) },
    { label: 'CPM',         value: cpm !== null ? fmtDKK(cpm, 2)       : '—' },
    { label: 'CTR',         value: ctr !== null ? ctr.toFixed(2) + '%' : '—' },
    { label: 'Clicks',      value: fmt(t.clicks) },
    { label: 'Freq',        value: avgFreq !== null ? avgFreq.toFixed(2) : '—' },
    { label: 'Spend',       value: fmtDKK(t.spend) },
  ]
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
                isOn ? 'bg-kk-brand text-white font-medium' : 'text-kk-muted hover:text-kk-ink',
              ].join(' ')}
            >
              {statusLabel(status)}
            </button>
          )
        })}
      </div>

      {/* Full-width campaign cards */}
      <div className="space-y-2">
        {withData.map(({ id, name, status, objective, totals }) => {
          const t      = totals!
          const cells  = getMetricCells(objective, t)
          const isActive = status === 'ACTIVE'

          return (
            <div key={id} className="bg-kk-panel border border-kk-line rounded-xl overflow-hidden">

              {/* ── Top row: 3-column grid — name | goal | status · date ── */}
              <div className="px-4 py-3 grid grid-cols-3 items-center gap-4 bg-[#DDD9D1]">
                {/* Left: campaign name */}
                <p className="text-sm font-semibold text-kk-ink truncate">{name}</p>
                {/* Centre: objective/goal */}
                <p className="text-base font-semibold text-kk-ink text-center">{objectiveLabel(objective)}</p>
                {/* Right: status + date */}
                <div className="flex items-center gap-2 justify-end">
                  <span className={[
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold',
                    isActive ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted',
                  ].join(' ')}>
                    {statusLabel(status)}
                  </span>
                  <span className="text-xs text-kk-muted">
                    {fmtDateShort(t.firstDate)}–{fmtDateShort(t.lastDate)}
                  </span>
                </div>
              </div>

              {/* ── Metrics row: 6 equal columns across the full card width ── */}
              <div className="border-t border-kk-line grid grid-cols-6 divide-x divide-kk-line">
                {cells.map((cell, i) => (
                  <div key={i} className="px-3 py-3 flex items-center gap-1.5">
                    <span className="text-sm font-medium text-kk-muted whitespace-nowrap">{cell.label}:</span>
                    <span className="text-sm font-bold text-kk-ink tabular-nums">{cell.value}</span>
                  </div>
                ))}
              </div>

            </div>
          )
        })}

        {/* No-data campaigns */}
        {noData.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-xl">
            <div className="px-4 py-2.5 border-b border-kk-line">
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
