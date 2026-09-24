'use client'

import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useState, useTransition } from 'react'
import { formatPaidMoney, formatPaidNumber, visiblePaidCampaigns, type PaidCampaign, type PaidMetric, type PaidPeriod, type PaidPlatform, type PaidRange } from '@/lib/marketing/paid-performance'

const STATUS_LABELS: Record<string, string> = { ACTIVE: 'Active', ENABLED: 'Active', PAUSED: 'Paused', REMOVED: 'Removed', ARCHIVED: 'Archived', DELETED: 'Deleted' }
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const exactNumber = (value: number) => value.toLocaleString('en-GB', { maximumFractionDigits: 6 })

function Metric({ metric, currency }: { metric: PaidMetric; currency: string }) {
  const value = metric.value === null ? '\u2014' : metric.format === 'money' ? formatPaidMoney(metric.value, currency)
    : metric.format === 'percent' ? `${metric.value.toFixed(2)}%` : metric.format === 'decimal' ? metric.value.toFixed(2) : formatPaidNumber(metric.value)
  return <div className="flex min-w-0 items-baseline gap-1.5 text-sm"><dt className="text-kk-muted">{metric.label}</dt><dd className="font-semibold tabular-nums" title={metric.value === null ? undefined : exactNumber(metric.value)}>{value}</dd></div>
}

function CampaignCard({ campaign: c }: { campaign: PaidCampaign }) {
  const [expanded, setExpanded] = useState(false)
  const detailId = `details-${c.id}`
  const active = c.status === 'ACTIVE' || c.status === 'ENABLED'
  const effLabel = c.platform === 'meta' && c.results[0]?.id === 'CPM' ? 'cpm' : 'cost/res.'
  const duplicateLabels = c.results.filter((r, i, all) => all.some((other, j) => j !== i && other.label === r.label)).map(r => r.label)
  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-kk-line bg-kk-panel">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="flex w-full items-center gap-3 px-4 py-2 text-left bg-blue-50 transition-colors hover:bg-blue-100/70"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-kk-ink">{c.name}</h2>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${active ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted'}`}>
              {STATUS_LABELS[c.status] ?? c.status}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-kk-muted mt-0.5">
            <span className="font-semibold">{c.platform === 'google' ? 'Google' : 'Meta'}</span>
            {c.platform === 'google' && <><span>{'\u00B7'}</span><span>{c.type}</span></>}
            <span>{'\u00B7'}</span><span>{c.goal}</span>
          </div>
        </div>
        <span className="text-xs text-kk-muted" aria-hidden="true">{expanded ? '\u2212' : '+'}</span>
      </button>

      {c.hasActivity ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 border-t border-kk-line divide-x divide-kk-line">
          {c.results.map(result => (
            <div key={result.id} className="px-3 py-2" title={result.name}>
              <div className="text-[10px] font-medium text-kk-muted mb-0.5">{result.label}</div>
              <div className="text-sm font-bold tabular-nums text-kk-ink" title={exactNumber(result.count)}>{formatPaidNumber(result.count)}</div>
              <div className="text-[10px] text-kk-muted tabular-nums mt-0.5">{formatPaidMoney(result.costPerResult, c.currency)} /{effLabel}</div>
              {duplicateLabels.includes(result.label) && <div className="text-[10px] text-kk-muted truncate mt-0.5">{result.name}</div>}
            </div>
          ))}
          <div className="px-3 py-2">
            <div className="text-[10px] font-medium text-kk-muted mb-0.5">Spend</div>
            <div className="text-sm font-bold tabular-nums text-kk-ink">{formatPaidMoney(c.spend, c.currency)}</div>
          </div>
          {c.metrics.map(metric => {
            const val = metric.value === null ? '\u2014' : metric.format === 'money' ? formatPaidMoney(metric.value, c.currency)
              : metric.format === 'percent' ? `${metric.value.toFixed(2)}%` : metric.format === 'decimal' ? metric.value.toFixed(2) : formatPaidNumber(metric.value)
            return (
              <div key={metric.label} className="px-3 py-2">
                <div className="text-[10px] font-medium text-kk-muted mb-0.5">{metric.label}</div>
                <div className="text-sm font-bold tabular-nums text-kk-ink" title={metric.value === null ? undefined : exactNumber(metric.value)}>{val}</div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="border-t border-kk-line px-4 py-2 text-xs text-kk-muted">No activity in this period.</p>
      )}

      {expanded && (
        <div id={detailId} className="space-y-3 border-t border-kk-line bg-kk-bg/40 px-4 py-3">
          <div className="flex flex-wrap justify-between gap-2 text-[10px] text-kk-muted">
            <span>{c.accountName} {'\u00B7'} {c.type} {'\u00B7'} {STATUS_LABELS[c.status] ?? c.status}</span>
            <span>{c.firstDate && c.lastDate ? `${dateLabel(c.firstDate)}\u2013${dateLabel(c.lastDate)}` : 'No activity dates'}</span>
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1">
            <Metric currency={c.currency} metric={{ label: 'Spend', value: c.spend, format: 'money' }} />
            <Metric currency={c.currency} metric={{ label: 'Impressions', value: c.impressions, format: 'number' }} />
            <Metric currency={c.currency} metric={{ label: 'Clicks', value: c.clicks, format: 'number' }} />
            <Metric currency={c.currency} metric={{ label: 'CTR', value: c.impressions > 0 ? c.clicks / c.impressions * 100 : null, format: 'percent' }} />
          </dl>
          {c.googleResults ? (
            <>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-kk-muted">Conversion actions</h3>
              <div className="divide-y divide-kk-line">
                {c.googleResults.map(result => (
                  <div key={result.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <div className="min-w-0 basis-40">
                      <p className="truncate text-xs font-medium" title={result.name}>{result.name}</p>
                      <p className="text-[10px] text-kk-muted">{result.label} {'\u00B7'} {result.primary ? 'Primary' : 'Other'}</p>
                    </div>
                    <dl className="flex flex-wrap gap-x-4 gap-y-1">
                      <div><dt className="text-[10px] text-kk-muted">Conv.</dt><dd className="text-xs font-semibold tabular-nums" title={exactNumber(result.count)}>{formatPaidNumber(result.count, false)}</dd></div>
                      <div><dt className="text-[10px] text-kk-muted">All conv.</dt><dd className="text-xs tabular-nums" title={exactNumber(result.allCount)}>{formatPaidNumber(result.allCount, false)}</dd></div>
                      <div><dt className="text-[10px] text-kk-muted">Cost/conv.</dt><dd className="text-xs tabular-nums">{formatPaidMoney(result.costPerResult, c.currency)}</dd></div>
                      {(result.value !== 0 || result.allValue !== 0) && (
                        <div>
                          <dt className="text-[10px] text-kk-muted">{result.category === 'PURCHASE' ? 'Value' : 'Conv. value'}</dt>
                          <dd className="text-xs tabular-nums">{result.category === 'PURCHASE' ? formatPaidMoney(result.value, c.currency) : formatPaidNumber(result.value, false)}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                ))}
                {!c.googleResults.length && <p className="py-1 text-xs text-kk-muted">No conversion actions in this period.</p>}
              </div>
            </>
          ) : (
            <p className="text-[10px] text-kk-muted">Meta metrics follow the campaign objective.</p>
          )}
        </div>
      )}
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
  const pill = (selected: boolean) => `min-h-9 rounded-lg px-3 text-xs transition-colors disabled:opacity-60 ${selected ? 'bg-kk-brand font-semibold text-white' : 'text-kk-muted hover:bg-kk-soft hover:text-kk-ink'}`
  return (
    <div className="min-w-0 space-y-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl border border-kk-line bg-white p-1" role="group" aria-label="Platform">
          {(['all', 'meta', 'google'] as const).map(p => (
            <button type="button" disabled={pending} key={p} aria-pressed={platform === p} onClick={() => change('platform', p === 'all' ? [] : [p])} className={pill(platform === p)}>
              {p === 'all' ? 'All' : p === 'meta' ? 'Meta' : 'Google'}
            </button>
          ))}
        </div>
        <div className="flex rounded-xl border border-kk-line bg-white p-1" role="group" aria-label="Period">
          {([28, 90] as const).map(days => (
            <button type="button" disabled={pending} key={days} aria-pressed={report.period === days} onClick={() => change('period', [String(days)])} className={pill(report.period === days)}>
              {days} days
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-xs text-kk-muted" role="status">{pending ? 'Updating\u2026' : `${dateLabel(report.range.start)}\u2013${dateLabel(report.range.end)} \u00B7 ${report.period} completed days`}</p>
        <label className="flex min-h-9 items-center gap-2 text-xs text-kk-muted">
          <input type="checkbox" checked={showInactive} disabled={pending} onChange={event => change('inactive', event.target.checked ? ['1'] : [])} className="h-4 w-4 accent-[#AD3919]" />
          Include campaigns without activity
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Campaign status">
        <button type="button" disabled={pending} onClick={() => change('s', [])} aria-pressed={!statuses.length} className={pill(!statuses.length)}>Any status</button>
        {presentStatuses.map(status => (
          <button type="button" key={status} disabled={pending} aria-pressed={statuses.includes(status)} className={pill(statuses.includes(status))} onClick={() => change('s', statuses.includes(status) ? statuses.filter(s => s !== status) : [...statuses, status])}>
            {STATUS_LABELS[status] ?? status}
          </button>
        ))}
      </div>
      {errors.map(error => <p role="alert" key={error.platform} className="rounded-xl border border-kk-line bg-kk-bad-bg p-4 text-sm text-kk-bad">{error.message}</p>)}
      <div className={`space-y-2 ${pending ? 'opacity-60' : ''}`}>
        {visible.map(campaign => <CampaignCard key={`${report.period}:${campaign.id}`} campaign={campaign} />)}
        {!visible.length && !errors.length && (
          <div className="rounded-xl border border-kk-line bg-kk-panel px-5 py-8">
            <h2 className="text-sm font-semibold">No {platform === 'google' ? 'Google Ads ' : platform === 'meta' ? 'Meta ' : ''}campaigns {showInactive ? 'match these filters' : 'with activity in this period'}</h2>
            <p className="mt-1 text-sm text-kk-muted">Try another period or status{showInactive ? '.' : ', or include campaigns without activity.'}</p>
          </div>
        )}
      </div>
      {visible.length > 0 && (
        <div className="flex flex-wrap justify-between gap-2 border-t border-kk-line pt-3 text-xs text-kk-muted">
          <span>{visible.length} campaigns {'\u00B7'} results shown separately by goal</span>
          <span>{errors.length ? 'Available' : 'Period'} spend: {[...spendByCurrency].map(([currency, spend]) => formatPaidMoney(spend, currency)).join(' \u00B7 ')}</span>
        </div>
      )}
    </div>
  )
}
