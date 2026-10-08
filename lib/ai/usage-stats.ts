// lib/ai/usage-stats.ts
//
// Pure aggregation for the AI Usage page. No I/O, so it is unit-testable with fixtures.
// Days are Europe/Copenhagen calendar days, consistent with the rest of Kockpit.

import { copenhagenMidnightUTC } from '@/lib/today/weekUtils'

export type UsageRow = {
  created_at: string
  feature: string
  model: string | null
  status: 'success' | 'error' | string
  input_tokens: number | string
  output_tokens: number | string
  cache_creation_input_tokens: number | string
  cache_read_input_tokens: number | string
  estimated_cost_usd: number | string | null
  error_category: string | null
  http_status?: number | null
  duration_ms?: number | null
  metadata?: Record<string, unknown> | null
}

export type CreditRow = { amount_usd: number | string; occurred_at: string }

export const FEATURE_LABELS: Record<string, string> = {
  quick_capture: 'Quick Capture',
  morning_brief: 'Morning Brief',
  review_reply_draft: 'Google review replies',
  paid_recommendations: 'Paid Recommendations',
  creative_classifier: 'Marketing Brain — classification',
  creative_interpretation: 'Marketing Brain — interpretation',
  brain_query: 'Kockpit Brain',
  meeting_draft: 'Meeting AI',
  email_analysis: 'Email analysis',
  weekly_impact: 'Weekly Impact Brief',
}

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature.replace(/_/g, ' ')
}

export const ERROR_LABELS: Record<string, string> = {
  billing_credit_exhausted: 'Billing credit exhausted',
  rate_limit: 'Rate limited',
  authentication: 'Authentication',
  provider_error: 'Provider error',
  validation_error: 'Validation error',
  timeout: 'Timeout',
  unknown: 'Unknown error',
}

const num = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : (v as number)
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}
const round8 = (x: number) => Math.round(x * 1e8) / 1e8

export const cost = (r: UsageRow): number => num(r.estimated_cost_usd)
export const isUnpriced = (r: UsageRow): boolean => r.status === 'success' && r.estimated_cost_usd == null

// ─── Windows ─────────────────────────────────────────────────────────────────

export function copenhagenDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Copenhagen' })
}

export function startOfCopenhagenDay(now: Date): Date {
  const [y, m, d] = copenhagenDate(now).split('-').map(Number)
  return copenhagenMidnightUTC(y, m, d)
}

export type WindowSummary = { cost: number; calls: number; unpricedCalls: number }

export function summarize(rows: UsageRow[], from: Date, to: Date = new Date(8.64e15)): WindowSummary {
  let total = 0, calls = 0, unpriced = 0
  for (const r of rows) {
    const t = new Date(r.created_at).getTime()
    if (t < from.getTime() || t >= to.getTime()) continue
    calls++
    total += cost(r)
    if (isUnpriced(r)) unpriced++
  }
  return { cost: round8(total), calls, unpricedCalls: unpriced }
}

export function rollingSince(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000)
}

// ─── Daily series ────────────────────────────────────────────────────────────

export type DailyPoint = { date: string; cost: number; calls: number }

/** Zero-filled Copenhagen-day series ending on today's Copenhagen date. */
export function dailySeries(rows: UsageRow[], days: number, now: Date): DailyPoint[] {
  const [ty, tm, td] = copenhagenDate(now).split('-').map(Number)
  const points: DailyPoint[] = []
  const index = new Map<string, DailyPoint>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ty, tm - 1, td - i))
    const key = d.toISOString().slice(0, 10)
    const p = { date: key, cost: 0, calls: 0 }
    points.push(p); index.set(key, p)
  }
  for (const r of rows) {
    const p = index.get(copenhagenDate(new Date(r.created_at)))
    if (!p) continue
    p.calls++
    p.cost += cost(r)
  }
  for (const p of points) p.cost = round8(p.cost)
  return points
}

// ─── Breakdowns ──────────────────────────────────────────────────────────────

export type FeatureRow = {
  feature: string; label: string; calls: number; failures: number
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
  cost: number; share: number; unpricedCalls: number
}

export function byFeature(rows: UsageRow[]): FeatureRow[] {
  const map = new Map<string, FeatureRow>()
  let total = 0
  for (const r of rows) {
    let f = map.get(r.feature)
    if (!f) {
      f = { feature: r.feature, label: featureLabel(r.feature), calls: 0, failures: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, share: 0, unpricedCalls: 0 }
      map.set(r.feature, f)
    }
    f.calls++
    if (r.status === 'error') f.failures++
    f.inputTokens += num(r.input_tokens)
    f.outputTokens += num(r.output_tokens)
    f.cacheReadTokens += num(r.cache_read_input_tokens)
    f.cacheWriteTokens += num(r.cache_creation_input_tokens)
    f.cost += cost(r)
    if (isUnpriced(r)) f.unpricedCalls++
    total += cost(r)
  }
  const out = [...map.values()]
  for (const f of out) { f.cost = round8(f.cost); f.share = total > 0 ? f.cost / total : 0 }
  return out.sort((a, b) => b.cost - a.cost || b.calls - a.calls || a.feature.localeCompare(b.feature))
}

export type ModelRow = { model: string; calls: number; tokens: number; cost: number; unpricedCalls: number }

export function byModel(rows: UsageRow[]): ModelRow[] {
  const map = new Map<string, ModelRow>()
  for (const r of rows) {
    const key = r.model ?? 'unknown'
    let m = map.get(key)
    if (!m) { m = { model: key, calls: 0, tokens: 0, cost: 0, unpricedCalls: 0 }; map.set(key, m) }
    m.calls++
    m.tokens += num(r.input_tokens) + num(r.output_tokens) + num(r.cache_creation_input_tokens) + num(r.cache_read_input_tokens)
    m.cost += cost(r)
    if (isUnpriced(r)) m.unpricedCalls++
  }
  const out = [...map.values()]
  for (const m of out) m.cost = round8(m.cost)
  return out.sort((a, b) => b.cost - a.cost || b.calls - a.calls || a.model.localeCompare(b.model))
}

// ─── Credit ledger / balance ─────────────────────────────────────────────────

export function trackingStart(rows: UsageRow[]): string | null {
  let min: string | null = null
  for (const r of rows) if (min === null || r.created_at < min) min = r.created_at
  return min
}

export type BalanceEstimate = {
  creditsTotal: number
  trackedCostSinceFirstCredit: number
  remaining: number
  firstCreditAt: string
} | null

/**
 * Estimated remaining = recorded credits − tracked estimated usage cost from the earliest recorded
 * credit onward. Null when no credit has been recorded. Not Anthropic's authoritative balance.
 */
export function estimateRemaining(credits: CreditRow[], rows: UsageRow[]): BalanceEstimate {
  if (!credits.length) return null
  const first = credits.reduce((min, c) => (c.occurred_at < min ? c.occurred_at : min), credits[0].occurred_at)
  const creditsTotal = credits.reduce((s, c) => s + num(c.amount_usd), 0)
  const used = summarize(rows, new Date(first)).cost
  return {
    creditsTotal: round8(creditsTotal),
    trackedCostSinceFirstCredit: used,
    remaining: round8(creditsTotal - used),
    firstCreditAt: first,
  }
}

export type BalanceLevel = 'unknown' | 'green' | 'amber' | 'red'

export function balanceLevel(remaining: number | null): BalanceLevel {
  if (remaining === null) return 'unknown'
  if (remaining > 25) return 'green'
  if (remaining >= 10) return 'amber'
  return 'red'
}

// ─── Provider / billing health ───────────────────────────────────────────────

export type Health = {
  state: 'healthy' | 'blocked'
  billingFailures24h: number
  otherFailures24h: number
  lastBillingFailureAt: string | null
  recoveredAfterBilling: boolean
}

/**
 * "Blocked" when the latest billing/credit rejection is newer than the latest successful request
 * (or there is no later success). A later success means the provider is accepting calls again.
 */
export function billingHealth(rows: UsageRow[], now: Date): Health {
  const since = now.getTime() - 86_400_000
  let billing = 0, other = 0
  let lastBilling: string | null = null
  let lastSuccess: string | null = null
  for (const r of rows) {
    if (r.status === 'success' && (lastSuccess === null || r.created_at > lastSuccess)) lastSuccess = r.created_at
    if (r.status !== 'error') continue
    const recent = new Date(r.created_at).getTime() >= since
    if (r.error_category === 'billing_credit_exhausted') {
      if (recent) billing++
      if (lastBilling === null || r.created_at > lastBilling) lastBilling = r.created_at
    } else if (recent) other++
  }
  const billingRecent = lastBilling !== null && new Date(lastBilling).getTime() >= since
  const recovered = billingRecent && lastSuccess !== null && lastSuccess > (lastBilling as string)
  return {
    state: billingRecent && !recovered ? 'blocked' : 'healthy',
    billingFailures24h: billing,
    otherFailures24h: other,
    lastBillingFailureAt: lastBilling,
    recoveredAfterBilling: recovered,
  }
}
