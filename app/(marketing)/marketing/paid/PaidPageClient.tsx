'use client'

import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useState, useTransition } from 'react'
import { formatPaidMoney, formatPaidNumber, visiblePaidCampaigns, type PaidCampaign, type PaidMetric, type PaidPeriod, type PaidPlatform, type PaidRange } from '@/lib/marketing/paid-performance'

const STATUS_LABELS: Record<string, string> = { ACTIVE: 'Active', ENABLED: 'Active', PAUSED: 'Paused', REMOVED: 'Removed', ARCHIVED: 'Archived', DELETED: 'Deleted' }
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const exactNumber = (value: number) => value.toLocaleString('en-GB', { maximumFractionDigits: 6 })

function Metric({ metric, currency }: { metric: PaidMetric; currency: string }) {
  const value = metric.value === null ? '—' : metric.format === 'money' ? formatPaidMoney(metric.value, currency)
    : metric.format === 'percent' ? `${metric.value.toFixed(2)}%` : metric.format === 'decimal' ? metric.value.toFixed(2) : formatPaidNumber(metric.value)
  return <div className="flex min-w-0 items-baseline gap-1.5 text-xs"><dt className="text-kk-muted">{metric.label}</dt><dd className="font-semibold tabular-nums" title={metric.value === null ? undefined : exactNumber(metric.value)}>{value}</dd></div>
}

function CampaignCard({ campaign: c }: { campaign: PaidCampaign }) {
  const [expanded, setExpanded] = useState(false)
  const detailId = `details-${c.id}`
  const active = c.status === 'ACTIVE' || c.status === 'ENABLED'
  const efficiency = c.platform === 'meta' && c.results[0]?.id === 'CPM' ? 'CPM · per 1K' : 'Cost / result'
  const duplicateLabels = c.results.filter((r, i, all) => all.some((other, j) => j !== i && other.label === r.label)).map(r => r.label)
  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-kk-line bg-kk-panel" aria-label={`${c.platform === 'google' ? 'Google' : 'Meta'} campaign ${c.name}`}>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={detailId}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 bg-[#DDD9D1] px-4 py-3 text-left transition-colors hover:bg-[#d4d0c8] focus-visible:-outline-offset-2">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="break-words text-sm font-semibold leading-snug text-kk-ink">{c.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kk-muted">
            <span className="font-semibold text-kk-ink">{c.platform === 'google' ? 'Google' : 'Meta'}</span><span>·</span>
            {c.platform === 'google' ? <><span>{c.type}</span><span>·</span></> : null}<span>{c.goal}</span>
          </div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${active ? 'bg-kk-good-bg text-kk-good' : 'bg-white/60 text-kk-muted'}`}>{STATUS_LABELS[c.status] ?? c.status}</span>
        <span className="flex items-center gap-1 text-xs text-kk-muted"><span className="hidden sm:inline">Details</span><span aria-hidden="true">{expanded ? '−' : '+'}</span></span>
      </button>

      {c.hasActivity ? (
        <>
          <div className="grid min-w-0 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(150px,0.4fr)]">
            <div className="min-w-0 px-4 py-3">
              <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] gap-4 text-[10px] font-semibold uppercase tracking-wider text-kk-muted"><span>{c.results.length > 1 ? 'Primary results' : 'Result'}</span><span>{efficiency}</span></div>
              {c.results.length ? c.results.map(result => (
                <div key={result.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 py-1.5">
                  <div className="min-w-0" title={result.name}>
                    <span className="mr-2 text-xl font-bold tabular-nums tracking-tight" title={exactNumber(result.count)}>{formatPaidNumber(result.count)}</span>
                    <span className="text-sm text-kk-ink">{result.label}</span>
                    {duplicateLabels.includes(result.label) ? <p className="mt-0.5 break-words text-xs text-kk-muted">{result.name}</p> : null}
                  </div>
                  <span className="text-sm font-semibold tabular-nums whitespace-nowrap">{formatPaidMoney(result.costPerResult, c.currency)}</span>
                </div>
              )) : <p className="py-2 text-sm text-kk-muted">Primary result unavailable · see reported actions in details.</p>}
            </div>
            <div className="flex items-baseline justify-between gap-3 border-t border-kk-line px-4 py-3 sm:block sm:border-t-0 sm:border-l">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-kk-muted">Spend</p>
              <p className="mt-1 text-base font-medium tabular-nums text-kk-muted">{formatPaidMoney(c.spend, c.currency)}</p>
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-2 border-t border-kk-line px-4 py-2.5">{c.metrics.map(metric => <Metric key={metric.label} metric={metric} currency={c.currency} />)}</dl>
        </>
      ) : <p className="px-4 py-4 text-sm text-kk-muted">No activity in this period.</p>}

      {expanded ? (
        <div id={detailId} className="space-y-4 border-t border-kk-line bg-kk-bg/40 px-4 py-4">
          <div className="flex flex-wrap justify-between gap-2 text-xs text-kk-muted">
            <span>{c.accountName} · {c.type} · {STATUS_LABELS[c.status] ?? c.status}</span>
            <span>{c.firstDate && c.lastDate ? `Activity: ${dateLabel(c.firstDate)}–${dateLabel(c.lastDate)}` : 'No activity dates'}</span>
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-2">
            <Metric currency={c.currency} metric={{ label: 'Spend', value: c.spend, format: 'money' }} />
            <Metric currency={c.currency} metric={{ label: 'Impressions', value: c.impressions, format: 'number' }} />
            <Metric currency={c.currency} metric={{ label: 'Clicks', value: c.clicks, format: 'number' }} />
            <Metric currency={c.currency} metric={{ label: 'CTR', value: c.impressions > 0 ? c.clicks / c.impressions * 100 : null, format: 'percent' }} />
          </dl>
          {c.googleResults ? (
            <>
              <h3 className="text-xs font-semibold text-kk-ink">Conversion actions</h3>
              <div className="divide-y divide-kk-line">
                {c.googleResults.map(result => (
                  <div key={result.id} className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:gap-4">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{result.name}</p>
                      <p className="mt-0.5 text-xs text-kk-muted">{result.label} · {result.primary ? 'Current primary goal' : 'Other reported action'}</p>
                    </div>
                    <dl className="flex flex-wrap gap-x-5 gap-y-2">
                      <div><dt className="text-[10px] text-kk-muted">Conversions</dt><dd className="text-sm font-semibold tabular-nums" title={exactNumber(result.count)}>{formatPaidNumber(result.count, false)}</dd></div>
                      <div><dt className="text-[10px] text-kk-muted">All conversions</dt><dd className="text-sm tabular-nums" title={exactNumber(result.allCount)}>{formatPaidNumber(result.allCount, false)}</dd></div>
                      <div><dt className="text-[10px] text-kk-muted">Cost / conversion</dt><dd className="text-sm tabular-nums">{formatPaidMoney(result.costPerResult, c.currency)}</dd></div>
                      {result.value !== 0 || result.allValue !== 0 ? <div><dt className="text-[10px] text-kk-muted">{result.category === 'PURCHASE' ? 'Purchase value' : 'Reported conv. value'}</dt><dd className="text-sm tabular-nums">{result.category === 'PURCHASE' ? formatPaidMoney(result.value, c.currency) : formatPaidNumber(result.value, false)}</dd>{result.allValue !== result.value ? <p className="text-[10px] text-kk-muted">All: {result.category === 'PURCHASE' ? formatPaidMoney(result.allValue, c.currency) : formatPaidNumber(result.allValue, false)}</p> : null}</div> : null}
                    </dl>
                  </div>
                ))}
                {!c.googleResults.length ? <p className="py-2 text-sm text-kk-muted">No conversion actions reported in this period.</p> : null}
              </div>
              <p className="max-w-3xl text-xs leading-relaxed text-kk-muted">{c.goalNote} “All conversions” stays separate and is not used for the headline results.</p>
            </>
          ) : <p className="text-xs text-kk-muted">Meta metrics follow the campaign objective. Daily average frequency uses impressions divided by the sum of daily reach; it is not deduplicated period frequency.</p>}
        </div>
      ) : null}
    </article>
  )
}

type Report = { campaigns: PaidCampaign[]; period: PaidPeriod; range: PaidRange; errors: { platform: PaidPlatform; message: string }[] }
export default function PaidPageClient({ report }: { report: Report }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()
  const platform = ['meta', 'google'].includes(searchParams.get('platform') ?? '') ? searchParams.get('platform')! : 'all'
  const statuses = searchParams.getAll('s').filter(s => ['ACTIVE', 'PAUSED', 'REMOVED', 'ARCHIVED', 'DELETED'].includes(s))
  const showInactive = searchParams.get('inactive') === '1'
  const visible = visiblePaidCampaigns(report.campaigns, platform, statuses, showInactive)
  const platformStatuses = new Set(report.campaigns.filter(c => platform === 'all' || c.platform === platform).map(c => c.status === 'ENABLED' ? 'ACTIVE' : c.status))
  const presentStatuses = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'REMOVED', 'DELETED'].filter(s => platformStatuses.has(s) || statuses.includes(s))
  const errors = report.errors.filter(e => platform === 'all' || e.platform === platform)
  const spendByCurrency = new Map<string, number>()
  visible.forEach(c => spendByCurrency.set(c.currency, (spendByCurrency.get(c.currency) ?? 0) + c.spend))
  function change(name: string, values: string[]) {
    const params = new URLSearchParams(searchParams.toString())
    params.delete(name); values.forEach(value => params.append(name, value))
    startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }))
  }
  const pill = (selected: boolean) => `min-h-9 rounded-lg px-3 text-xs transition-colors disabled:opacity-60 ${selected ? 'bg-[#F5DA93] font-semibold text-kk-ink' : 'text-kk-muted hover:bg-kk-soft hover:text-kk-ink'}`
  return (
    <div className="min-w-0 space-y-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl border border-kk-line bg-white p-1" role="group" aria-label="Platform">
          {(['all', 'meta', 'google'] as const).map(p => <button type="button" disabled={pending} key={p} aria-pressed={platform === p} onClick={() => change('platform', p === 'all' ? [] : [p])} className={pill(platform === p)}>{p === 'all' ? 'All' : p === 'meta' ? 'Meta' : 'Google'}</button>)}
        </div>
        <div className="flex rounded-xl border border-kk-line bg-white p-1" role="group" aria-label="Period">
          {([28, 90] as const).map(days => <button type="button" disabled={pending} key={days} aria-pressed={report.period === days} onClick={() => change('period', [String(days)])} className={pill(report.period === days)}>{days} days</button>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-xs text-kk-muted" role="status">{pending ? 'Updating…' : `${dateLabel(report.range.start)}–${dateLabel(report.range.end)} · ${report.period} completed days`}</p>
        <label className="flex min-h-9 items-center gap-2 text-xs text-kk-muted"><input type="checkbox" checked={showInactive} disabled={pending} onChange={event => change('inactive', event.target.checked ? ['1'] : [])} className="h-4 w-4 accent-[#AD3919]" />Include campaigns without activity</label>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Campaign status">
        <button type="button" disabled={pending} onClick={() => change('s', [])} aria-pressed={!statuses.length} className={pill(!statuses.length)}>Any status</button>
        {presentStatuses.map(status => <button type="button" key={status} disabled={pending} aria-pressed={statuses.includes(status)} className={pill(statuses.includes(status))} onClick={() => change('s', statuses.includes(status) ? statuses.filter(s => s !== status) : [...statuses, status])}>{STATUS_LABELS[status] ?? status}</button>)}
      </div>
      {errors.map(error => <p role="alert" key={error.platform} className="rounded-xl border border-kk-line bg-kk-warn-bg p-4 text-sm text-kk-warn">{error.message}</p>)}
      <div className={`space-y-3 ${pending ? 'opacity-60' : ''}`}>
        {visible.map(campaign => <CampaignCard key={`${report.period}:${campaign.id}`} campaign={campaign} />)}
        {!visible.length && !errors.length ? <div className="rounded-xl border border-kk-line bg-kk-panel px-5 py-8"><h2 className="text-sm font-semibold">No {platform === 'google' ? 'Google Ads ' : platform === 'meta' ? 'Meta ' : ''}campaigns {showInactive ? 'match these filters' : 'with activity in this period'}</h2><p className="mt-1 text-sm text-kk-muted">Try another period or status{showInactive ? '.' : ', or include campaigns without activity.'}</p></div> : null}
        {platform === 'all' && visible.length > 0 && !statuses.length ? (['meta', 'google'] as const).filter(p => !report.errors.some(e => e.platform === p) && !visible.some(c => c.platform === p)).map(p => <p key={p} className="px-1 text-sm text-kk-muted">No {p === 'google' ? 'Google Ads' : 'Meta'} campaigns with activity in this period.</p>) : null}
      </div>
      {visible.length ? <div className="flex flex-wrap justify-between gap-2 border-t border-kk-line pt-3 text-xs text-kk-muted"><span>{visible.length} campaigns · results shown separately by goal</span><span>{errors.length ? 'Available' : 'Period'} spend: {[...spendByCurrency].map(([currency, spend]) => formatPaidMoney(spend, currency)).join(' · ')}</span></div> : null}
    </div>
  )
}
