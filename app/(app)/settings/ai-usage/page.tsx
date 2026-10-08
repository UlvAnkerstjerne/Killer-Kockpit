import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import { formatCopenhagen } from '@/lib/time'
import { hasPricing, PRICING_VERSION } from '@/lib/ai/pricing'
import {
  balanceLevel, billingHealth, byFeature, byModel, copenhagenDate, dailySeries, estimateRemaining,
  featureLabel, ERROR_LABELS, rollingSince, startOfCopenhagenDay, summarize, trackingStart,
  type CreditRow, type UsageRow,
} from '@/lib/ai/usage-stats'
import AddCreditForm from './AddCreditForm'
import DailyCostChart from './DailyCostChart'

export const dynamic = 'force-dynamic'

const COLS = 'created_at, feature, model, status, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, estimated_cost_usd, error_category, http_status, duration_ms, metadata'
const PAGE = 1000
const MAX_PAGES = 50

const usd = (n: number) => `$${n.toFixed(2)}`
const usdSmall = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(n < 1 ? 4 : 2)}`)
const int = (n: number) => n.toLocaleString('en-GB')
const when = (iso: string) => formatCopenhagen(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) ?? iso
const whenLong = (iso: string) => formatCopenhagen(iso, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) ?? iso

type Win = '7d' | '30d' | 'all'

export default async function AiUsagePage({ searchParams }: { searchParams: Promise<{ window?: string }> }) {
  const [user, sp] = await Promise.all([getCurrentUser(), searchParams])
  if (!user || !canAccessAdminSettings(user.role)) notFound()

  const win: Win = sp.window === '7d' || sp.window === 'all' ? sp.window : '30d'
  const now = new Date()
  const supabase = await createClient() // user session: RLS limits these tables to SUPER_ADMIN

  const { data: creditData } = await supabase.from('ai_credit_events')
    .select('amount_usd, occurred_at, note, created_at').eq('provider', 'anthropic').order('occurred_at', { ascending: false })
  const credits = (creditData ?? []) as (CreditRow & { note: string | null })[]
  const firstCredit = credits.length ? credits.reduce((m, c) => (c.occurred_at < m ? c.occurred_at : m), credits[0].occurred_at) : null

  // Fetch enough history for every panel: 30 days, back to the first credit, or everything for "All tracked".
  const thirtyDaysAgo = rollingSince(now, 30).toISOString()
  const since = win === 'all' ? null : (firstCredit && firstCredit < thirtyDaysAgo ? firstCredit : thirtyDaysAgo)
  const rows: UsageRow[] = []
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabase.from('ai_usage_events').select(COLS).order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
    if (since) q = q.gte('created_at', since)
    const { data, error } = await q
    if (error) break
    rows.push(...((data ?? []) as UsageRow[]))
    if (!data || data.length < PAGE) break
    if (page === MAX_PAGES - 1) truncated = true
  }

  const [{ data: failureData }, { data: earliestData }] = await Promise.all([
    supabase.from('ai_usage_events').select(COLS).eq('status', 'error').order('created_at', { ascending: false }).limit(15),
    supabase.from('ai_usage_events').select('created_at').order('created_at', { ascending: true }).limit(1),
  ])
  const failures = (failureData ?? []) as UsageRow[]
  const started = (earliestData?.[0]?.created_at as string | undefined) ?? trackingStart(rows)

  const today = summarize(rows, startOfCopenhagenDay(now))
  const week = summarize(rows, rollingSince(now, 7))
  const month = summarize(rows, rollingSince(now, 30))
  const balance = estimateRemaining(credits, rows)
  const level = balanceLevel(balance?.remaining ?? null)
  const health = billingHealth(rows, now)
  const daily = dailySeries(rows, 30, now)

  const windowStart = win === '7d' ? rollingSince(now, 7) : win === '30d' ? rollingSince(now, 30) : new Date(0)
  const windowRows = rows.filter(r => new Date(r.created_at) >= windowStart)
  const features = byFeature(windowRows)
  const models = byModel(windowRows)
  const recent = rows.slice(0, 100)
  const unpricedModels = [...new Set(windowRows.filter(r => r.status === 'success' && r.model && !hasPricing(r.model)).map(r => r.model as string))]

  const levelStyle = {
    unknown: 'text-kk-muted', green: 'text-kk-good', amber: 'text-kk-warn', red: 'text-kk-bad',
  }[level]

  return (
    <div className="mx-auto max-w-5xl pb-16">
      <Link href="/settings" className="text-sm font-semibold text-kk-muted hover:text-kk-ink">← Settings</Link>
      <div className="mt-4 mb-5">
        <h1 className="font-brand text-3xl text-kk-ink sm:text-4xl">AI Usage</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-kk-muted">
          Kockpit&apos;s own Anthropic API calls only. Claude Code, claude.ai, ChatGPT/OpenAI and consumer subscriptions are not included.
        </p>
      </div>

      {/* Health */}
      {health.state === 'blocked' ? (
        <div role="alert" className="mb-4 rounded-xl border-2 border-[#AD3919] bg-kk-bad-bg p-4">
          <p className="text-sm font-black uppercase tracking-wide text-kk-bad">AI billing blocked</p>
          <p className="mt-1 text-sm text-kk-ink">Anthropic rejected {health.billingFailures24h} request{health.billingFailures24h === 1 ? '' : 's'} because API credit was unavailable.</p>
          {health.lastBillingFailureAt && <p className="mt-1 text-xs text-kk-muted">Last failure: {whenLong(health.lastBillingFailureAt)}</p>}
        </div>
      ) : (
        <div className="mb-4 rounded-xl border border-kk-line bg-kk-panel p-3 text-sm text-kk-ink">
          <span className="font-semibold text-kk-good">AI provider healthy.</span>{' '}
          <span className="text-kk-muted">
            {health.recoveredAfterBilling ? 'A billing rejection in the last 24h has cleared — requests are succeeding again. ' : 'No billing errors in the last 24h. '}
            {health.otherFailures24h > 0 ? `${health.otherFailures24h} other failed request${health.otherFailures24h === 1 ? '' : 's'} in the last 24h.` : ''}
          </span>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[{ k: 'Today', s: today }, { k: 'Last 7 days', s: week }, { k: 'Last 30 days', s: month }].map(({ k, s }) => (
          <div key={k} className="rounded-xl border-2 border-[#171717] bg-kraft-light p-4 [box-shadow:3px_3px_0_#555555]">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-kk-muted">{k}</p>
            <p className="mt-1 text-2xl font-black text-kk-ink">{usd(s.cost)}</p>
            <p className="text-xs text-kk-muted">{int(s.calls)} API call{s.calls === 1 ? '' : 's'}{s.unpricedCalls ? ` · ${s.unpricedCalls} unpriced` : ''}</p>
          </div>
        ))}
        <div className="rounded-xl border-2 border-[#171717] bg-kraft-light p-4 [box-shadow:3px_3px_0_#555555]">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-kk-muted">Estimated remaining</p>
          {balance ? (
            <>
              <p className={`mt-1 text-2xl font-black ${levelStyle}`}>{usd(balance.remaining)}</p>
              <p className="text-xs text-kk-muted">{usd(balance.creditsTotal)} credit − {usd(balance.trackedCostSinceFirstCredit)} tracked</p>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm font-semibold text-kk-muted">No credit balance recorded</p>
              <p className="text-xs text-kk-muted">Add credit to see an estimate.</p>
            </>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-kk-muted">
        Estimated remaining is based on credits recorded in Kockpit and tracked API usage. Anthropic&apos;s billing balance remains authoritative.
      </p>

      {/* Credit ledger */}
      <section className="mt-4 rounded-xl border border-kk-line bg-kk-panel p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-kk-ink">Credit ledger</h2>
          <AddCreditForm today={copenhagenDate(now)} />
        </div>
        {credits.length === 0 ? (
          <p className="mt-2 text-xs text-kk-muted">No credits recorded yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-kk-line text-sm">
            {credits.map((c, i) => (
              <li key={i} className="flex items-center justify-between py-1.5">
                <span className="text-kk-ink">{usd(Number(c.amount_usd))} <span className="text-xs text-kk-muted">· {formatCopenhagen(c.occurred_at, { day: 'numeric', month: 'short', year: 'numeric' })}</span></span>
                <span className="text-xs text-kk-muted truncate ml-3">{c.note}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tracking start */}
      <p className="mt-4 text-xs text-kk-muted">
        <span className="font-semibold text-kk-ink">Tracking started:</span> {started ? whenLong(started) : 'no AI calls recorded yet'}.{' '}
        Exact token/cost tracking begins from this date. Earlier Kockpit AI activity is not included in cost totals.
        {truncated && ' Showing the most recent 50,000 requests only.'}
      </p>

      {/* Daily chart */}
      <section className="mt-6 rounded-xl border border-kk-line bg-kk-panel p-4">
        <h2 className="text-sm font-bold text-kk-ink">Daily AI cost — last 30 days</h2>
        <DailyCostChart points={daily} />
      </section>

      {/* Feature breakdown */}
      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-kk-ink">Cost by feature</h2>
          <div className="flex gap-1 text-xs">
            {([['7d', '7 days'], ['30d', '30 days'], ['all', 'All tracked']] as const).map(([v, l]) => (
              <Link key={v} href={`/settings/ai-usage?window=${v}`}
                className={`rounded-lg px-2.5 py-1 ${win === v ? 'bg-[#171717] font-semibold text-kraft-light' : 'text-kk-muted hover:bg-[#B7A486]/25'}`}>{l}</Link>
            ))}
          </div>
        </div>
        <div className="mt-2 overflow-x-auto rounded-xl border border-kk-line bg-kk-panel">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-kk-muted">
              <tr><th className="p-2.5">Feature</th><th className="p-2.5 text-right">Calls</th><th className="p-2.5 text-right">Input</th><th className="p-2.5 text-right">Output</th><th className="p-2.5 text-right">Est. cost</th><th className="p-2.5 text-right">Share</th></tr>
            </thead>
            <tbody className="divide-y divide-kk-line">
              {features.length === 0 && <tr><td colSpan={6} className="p-3 text-xs text-kk-muted">No tracked AI calls in this window.</td></tr>}
              {features.map(f => (
                <tr key={f.feature}>
                  <td className="p-2.5 font-medium text-kk-ink">{f.label}{f.failures ? <span className="ml-2 text-[11px] text-kk-bad">{f.failures} failed</span> : null}</td>
                  <td className="p-2.5 text-right tabular-nums">{int(f.calls)}</td>
                  <td className="p-2.5 text-right tabular-nums">{int(f.inputTokens + f.cacheReadTokens + f.cacheWriteTokens)}</td>
                  <td className="p-2.5 text-right tabular-nums">{int(f.outputTokens)}</td>
                  <td className="p-2.5 text-right tabular-nums">{usd(f.cost)}{f.unpricedCalls ? <span className="block text-[10px] text-kk-warn">Pricing not configured ({f.unpricedCalls})</span> : null}</td>
                  <td className="p-2.5 text-right tabular-nums">{(f.share * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-kk-muted">Input includes cache read and cache write tokens. Prices: list price, version {PRICING_VERSION}.</p>
      </section>

      {/* Models */}
      <section className="mt-6">
        <h2 className="text-sm font-bold text-kk-ink">By model</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-kk-line bg-kk-panel">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-kk-muted"><tr><th className="p-2.5">Model</th><th className="p-2.5 text-right">Calls</th><th className="p-2.5 text-right">Tokens</th><th className="p-2.5 text-right">Est. cost</th></tr></thead>
            <tbody className="divide-y divide-kk-line">
              {models.map(m => (
                <tr key={m.model}>
                  <td className="p-2.5 font-mono text-xs text-kk-ink">{m.model}</td>
                  <td className="p-2.5 text-right tabular-nums">{int(m.calls)}</td>
                  <td className="p-2.5 text-right tabular-nums">{int(m.tokens)}</td>
                  <td className="p-2.5 text-right tabular-nums">{hasPricing(m.model) || m.model === 'unknown' ? usd(m.cost) : <span className="text-kk-warn">Pricing not configured</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {unpricedModels.length > 0 && <p className="mt-1 text-xs text-kk-warn">No price configured for {unpricedModels.join(', ')}; tokens are tracked but cost is excluded.</p>}
      </section>

      {/* Failures */}
      <section className="mt-6">
        <h2 className="text-sm font-bold text-kk-ink">Recent failures</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-kk-line bg-kk-panel">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-kk-muted"><tr><th className="p-2.5">Time</th><th className="p-2.5">Feature</th><th className="p-2.5">Model</th><th className="p-2.5">Error</th><th className="p-2.5 text-right">HTTP</th></tr></thead>
            <tbody className="divide-y divide-kk-line">
              {failures.length === 0 && <tr><td colSpan={5} className="p-3 text-xs text-kk-muted">No failed AI requests recorded.</td></tr>}
              {failures.map((f, i) => (
                <tr key={i}>
                  <td className="p-2.5 whitespace-nowrap text-xs">{when(f.created_at)}</td>
                  <td className="p-2.5">{featureLabel(f.feature)}</td>
                  <td className="p-2.5 font-mono text-xs">{f.model ?? '—'}</td>
                  <td className="p-2.5">{ERROR_LABELS[f.error_category ?? 'unknown'] ?? 'Unknown error'}</td>
                  <td className="p-2.5 text-right tabular-nums">{f.http_status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Raw requests */}
      <details className="mt-6 rounded-xl border border-kk-line bg-kk-panel">
        <summary className="cursor-pointer p-3 text-sm font-bold text-kk-ink">Recent API requests ({recent.length})</summary>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-xs">
            <thead className="text-left text-[11px] uppercase tracking-wide text-kk-muted">
              <tr><th className="p-2">Time</th><th className="p-2">Feature</th><th className="p-2">Model</th><th className="p-2">Status</th><th className="p-2 text-right">Input</th><th className="p-2 text-right">Cache read</th><th className="p-2 text-right">Cache write</th><th className="p-2 text-right">Output</th><th className="p-2 text-right">Est. cost</th><th className="p-2 text-right">Duration</th></tr>
            </thead>
            <tbody className="divide-y divide-kk-line">
              {recent.map((r, i) => (
                <tr key={i}>
                  <td className="p-2 whitespace-nowrap">{when(r.created_at)}</td>
                  <td className="p-2">{featureLabel(r.feature)}</td>
                  <td className="p-2 font-mono">{r.model ?? '—'}</td>
                  <td className="p-2">{r.status === 'error' ? (ERROR_LABELS[r.error_category ?? 'unknown'] ?? 'Error') : 'OK'}</td>
                  <td className="p-2 text-right tabular-nums">{int(Number(r.input_tokens))}</td>
                  <td className="p-2 text-right tabular-nums">{int(Number(r.cache_read_input_tokens))}</td>
                  <td className="p-2 text-right tabular-nums">{int(Number(r.cache_creation_input_tokens))}</td>
                  <td className="p-2 text-right tabular-nums">{int(Number(r.output_tokens))}</td>
                  <td className="p-2 text-right tabular-nums">{r.estimated_cost_usd == null ? '—' : usdSmall(Number(r.estimated_cost_usd))}{r.metadata && (r.metadata as { cost_partial?: boolean }).cost_partial ? '*' : ''}</td>
                  <td className="p-2 text-right tabular-nums">{r.duration_ms == null ? '—' : `${(r.duration_ms / 1000).toFixed(1)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="p-2 text-[11px] text-kk-muted">* Partial estimate: some cache-write tokens had no known TTL and are not priced.</p>
      </details>
    </div>
  )
}
