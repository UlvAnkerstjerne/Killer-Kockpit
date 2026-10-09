/**
 * Paid Strategy — evidence builder.
 *
 * Pure: no I/O, no AI. Turns stored Meta Ads rows into a bounded, whitelisted JSON
 * evidence object for the MESPER strategic analysis.
 *
 * Trust boundary:
 *   - Platform IDs never leave this module. Campaigns, ad sets and ads get local refs
 *     (C1, S1, A1) so the model cannot echo an ID that could be mistaken for a target.
 *   - Every platform-controlled string (names) is prefixed with `DATA:` and truncated.
 *   - Only the numeric fields listed here are copied. Nothing else survives.
 */

import { priorInsightsEvidence, type PriorInsightInput } from '@/lib/marketing/insights/prior'
import type { MetaAdRow, MetaAdSetRow, MetaCampaignInsightRow, MetaCampaignRow, MetaInsightActionItem } from '@/lib/marketing/types/meta'

export const PAID_STRATEGY_EVIDENCE_VERSION = 'paid-strategy-evidence-v1'
/** Hard account ceiling from Killer Kebab policy. A cap, not a target. */
export const MONTHLY_CEILING_DKK = 15_000
export const WINDOW_DAYS = 28
export const MAX_CAMPAIGNS = 12
export const MAX_AD_SETS = 25
export const MAX_ADS = 12
/** Projection: how many recent completed days define the run rate, and how many of them an active campaign must have spent on. */
export const RUN_RATE_DAYS = 7
export const MIN_SPEND_DAYS_FOR_RELIABLE_RUN_RATE = 5
/** Budgets are used as an upper bound only when they are this consistent with actual recent spend. */
export const BUDGET_SANITY_RANGE = { min: 0.5, max: 3 } as const

export type StrategyCampaign = Pick<MetaCampaignRow, 'id' | 'name' | 'status' | 'objective' | 'daily_budget' | 'created_at_meta'>
export type StrategyAdSet = Pick<MetaAdSetRow, 'id' | 'campaign_id' | 'name' | 'status' | 'daily_budget'>
export type StrategyAd = Pick<MetaAdRow, 'id' | 'ad_set_id' | 'name' | 'status'>
export type StrategyCampaignInsight = Pick<MetaCampaignInsightRow,
  'campaign_id' | 'date_start' | 'impressions' | 'clicks' | 'inline_link_clicks' | 'spend' | 'frequency' | 'actions_json'>
export interface StrategyAdInsight {
  ad_id: string; date_start: string
  impressions: number | string | null; clicks: number | string | null; inline_link_clicks: number | string | null
  spend: number | string | null; actions_json: MetaInsightActionItem[] | null
}

/** A recommendation a person rejected. Human business decision, not performance evidence. No platform IDs. */
export interface HumanStrategyDecisionInput { title: string; recommendation_type: string | null; reason: string | null; rejected_at: string }
export const HUMAN_DECISION_WINDOW_DAYS = 180
export const MAX_HUMAN_DECISIONS = 10

export interface StrategyInputs {
  now: Date
  /** Earlier durable insights as context (never evidence). Optional: absent behaves exactly as before. */
  priorInsights?: PriorInsightInput[]
  /** Recently rejected recommendations. Optional: absent behaves as none. */
  humanDecisions?: HumanStrategyDecisionInput[]
  currency: string
  campaigns: StrategyCampaign[]
  adSets: StrategyAdSet[]
  ads: StrategyAd[]
  campaignInsights: StrategyCampaignInsight[]
  adInsights: StrategyAdInsight[]
}

export interface DateWindow { start: string; end: string }
export interface StrategyWindows { current: DateWindow; prior: DateWindow; today: string }

// ── Dates ──────────────────────────────────────────────────────────────────────

export function strategyWindows(now = new Date()): StrategyWindows {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(now)
  const shift = (days: number): string => {
    const d = new Date(`${today}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString().slice(0, 10)
  }
  return {
    today,
    current: { start: shift(WINDOW_DAYS), end: shift(1) },
    prior: { start: shift(WINDOW_DAYS * 2), end: shift(WINDOW_DAYS + 1) },
  }
}

const inRange = (date: string, w: DateWindow) => date >= w.start && date <= w.end
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

// ── Number helpers ─────────────────────────────────────────────────────────────

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const round = (n: number, dp = 2): number => { const f = 10 ** dp; return Math.round(n * f) / f }
const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null)

/** Meta stores budgets in the currency's minor unit (matches lib/marketing/paid-recs, which divides by 100). */
const MINOR_UNITS_PER_CURRENCY_UNIT = 100
const budgetAmount = (v: unknown): number | null => (v == null ? null : round(num(v) / MINOR_UNITS_PER_CURRENCY_UNIT))

/** Platform-controlled text: prefix, strip control characters, truncate. */
export function dataText(value: string | null | undefined, max = 80): string {
  return `DATA:${(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)}`
}

// ── Aggregation ────────────────────────────────────────────────────────────────

interface RawRow {
  date_start: string; impressions: unknown; clicks: unknown; inline_link_clicks: unknown
  spend: unknown; frequency?: unknown; actions_json: MetaInsightActionItem[] | null
}

function sumActions(rows: RawRow[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) for (const a of row.actions_json ?? []) {
    if (!a || typeof a.action_type !== 'string') continue
    totals.set(a.action_type, (totals.get(a.action_type) ?? 0) + num(a.value))
  }
  return totals
}

const topActions = (totals: Map<string, number>, limit: number) =>
  [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([type, count]) => ({ type, count: round(count, 0) }))

// ── Business outcomes ─────────────────────────────────────────────────────────
//
// Engagement actions are high-volume and truncated to a top-N list. Business outcomes are
// low-volume and decisive, so they must NEVER compete with engagement for a slot: the first
// live run lost 6 real leads behind 12 engagement types and the model was told no lead
// event existed. Outcomes are therefore split out BEFORE ranking, always kept, and
// deduplicated: Meta reports one underlying result under several related action names
// (lead, offsite_conversion.fb_pixel_lead, onsite_web_lead, ...), so they are aliases, not
// additive. One count per outcome: the canonical type if present, else the largest alias.

interface OutcomeFamily { outcome: string; match: RegExp; canonical: string[] }
export const OUTCOME_FAMILIES: OutcomeFamily[] = [
  { outcome: 'lead', match: /lead/i, canonical: ['lead'] },
  { outcome: 'purchase', match: /purchase/i, canonical: ['purchase', 'omni_purchase'] },
  { outcome: 'order', match: /(^|[._])orders?($|[._])/i, canonical: ['order'] },
  { outcome: 'complete_registration', match: /complete_registration/i, canonical: ['complete_registration', 'omni_complete_registration'] },
  { outcome: 'app_install', match: /app_install/i, canonical: ['app_install', 'mobile_app_install', 'omni_app_install'] },
  { outcome: 'initiate_checkout', match: /initiate_checkout/i, canonical: ['initiate_checkout', 'omni_initiated_checkout'] },
  { outcome: 'add_to_cart', match: /add_to_cart/i, canonical: ['add_to_cart', 'omni_add_to_cart'] },
  { outcome: 'messaging_conversation_started', match: /messaging_conversation_started/i, canonical: ['onsite_conversion.messaging_conversation_started_7d'] },
  { outcome: 'voucher_redemption', match: /redemption|redeem|voucher|coupon/i, canonical: [] },
  { outcome: 'contact', match: /(^|[._])contact($|[._])/i, canonical: ['contact'] },
  { outcome: 'schedule', match: /(^|[._])schedule($|[._])/i, canonical: ['schedule'] },
  { outcome: 'submit_application', match: /submit_application/i, canonical: ['submit_application'] },
  { outcome: 'subscribe', match: /(^|[._])subscribe($|[._])/i, canonical: ['subscribe'] },
]

/** Account-defined custom conversions keep their own identity: their meaning is unknown, but they are commercial by definition. */
const isCustomConversion = (type: string) => /^(offsite|onsite)_conversion\.custom/i.test(type)

export interface BusinessOutcome {
  /** One underlying result, counted once. */
  outcome: string
  count: number
  /** The raw Meta action types that describe this same result. They are aliases: never add them. */
  reported_as: { type: string; count: number }[]
}

export function splitBusinessOutcomes(totals: Map<string, number>): { outcomes: BusinessOutcome[]; rest: Map<string, number> } {
  const rest = new Map<string, number>()
  const groups = new Map<string, { canonical: string[]; items: { type: string; count: number }[] }>()
  for (const [type, count] of totals) {
    if (!(count > 0)) continue
    const family = isCustomConversion(type) ? { outcome: `custom_conversion:${type}`, canonical: [type] } : OUTCOME_FAMILIES.find(f => f.match.test(type))
    if (!family) { rest.set(type, count); continue }
    const group = groups.get(family.outcome) ?? { canonical: family.canonical, items: [] }
    group.items.push({ type, count })
    groups.set(family.outcome, group)
  }
  const outcomes = [...groups.entries()].map(([outcome, g]) => {
    const canonical = g.items.find(i => g.canonical.includes(i.type))
    const count = canonical ? canonical.count : Math.max(...g.items.map(i => i.count))
    return {
      outcome, count: round(count, 0),
      reported_as: [...g.items].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)).map(i => ({ type: i.type, count: round(i.count, 0) })),
    }
  }).sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome))
  return { outcomes, rest }
}

/** Below this many events an outcome is an observation, not a trend (MESPER minimum-data rule). */
export const SMALL_SAMPLE_BELOW = 50

export interface WindowSummary {
  spend: number
  impressions: number
  link_clicks: number
  link_ctr_pct: number | null
  cpm: number | null
  cost_per_link_click: number | null
  avg_daily_frequency: number | null
  days_with_spend: number
  /** Engagement/context actions only, truncated to the top N. NEVER evidence that an outcome is absent. */
  top_actions: { type: string; count: number }[]
  /** Business outcomes: always present when recorded, deduplicated, never truncated. */
  business_outcomes: (BusinessOutcome & { observed_cost_per_outcome: number | null; small_sample: boolean })[]
}

function summarise(rows: RawRow[], actionLimit: number): WindowSummary {
  const spend = rows.reduce((s, r) => s + num(r.spend), 0)
  const impressions = rows.reduce((s, r) => s + num(r.impressions), 0)
  const linkClicks = rows.reduce((s, r) => s + num(r.inline_link_clicks), 0)
  const freqWeighted = rows.reduce((s, r) => s + num(r.frequency) * num(r.impressions), 0)
  const ctr = safeDiv(linkClicks, impressions)
  const cpm = safeDiv(spend, impressions)
  const cplc = safeDiv(spend, linkClicks)
  const freq = rows.some(r => r.frequency != null) ? safeDiv(freqWeighted, impressions) : null
  const { outcomes, rest } = splitBusinessOutcomes(sumActions(rows))
  return {
    spend: round(spend), impressions: round(impressions, 0), link_clicks: round(linkClicks, 0),
    link_ctr_pct: ctr === null ? null : round(ctr * 100),
    cpm: cpm === null ? null : round(cpm * 1000),
    cost_per_link_click: cplc === null ? null : round(cplc),
    avg_daily_frequency: freq === null ? null : round(freq),
    days_with_spend: new Set(rows.filter(r => num(r.spend) > 0).map(r => r.date_start)).size,
    top_actions: topActions(rest, actionLimit),
    business_outcomes: outcomes.map(o => {
      const cost = safeDiv(spend, o.count)
      return { ...o, observed_cost_per_outcome: cost === null ? null : round(cost), small_sample: o.count < SMALL_SAMPLE_BELOW }
    }),
  }
}

// ── Builder ────────────────────────────────────────────────────────────────────

export const DATA_GAPS_STATIC = [
  'Ad set targeting and audience definitions are not stored. Only ad set names are available and names may not reflect real targeting; the existence or absence of a retargeting audience cannot be confirmed.',
  'Ad creative and ad copy text are not stored. Only ad names and delivery metrics are available.',
  'No revenue, conversion value, or CRM/close outcome is stored.',
  'Meta action types overlap (several lead types can describe the same lead). Never add action types together.',
  'top_actions lists engagement and context actions only and is truncated. Business outcomes (leads, purchases, orders, installs, redemptions and similar) are listed separately in business_outcomes, once each and never truncated.',
  'Outcome counts say nothing about value: no closed-order, revenue or customer-quality data exists for any outcome. observed_cost_per_outcome is window spend divided by the deduplicated count on a small sample.',
  'avg_daily_frequency is the impression-weighted mean of daily campaign frequency, not period reach frequency.',
  'Insights cover completed days only; today is excluded. Benchmarks in the skill are cross-industry and mostly USD/EUR.',
] as const

export const CALIBRATION_UNKNOWN = [
  'target_cpl', 'target_roas', 'gross_margin', 'lead_to_customer_rate', 'customer_value_or_aov', 'sales_cycle_days',
] as const

export function buildPaidStrategyEvidence(input: StrategyInputs) {
  const w = strategyWindows(input.now)
  const campaignById = new Map(input.campaigns.map(c => [c.id, c]))

  // Campaign universe: not an internal "ZZ " archive, and either ACTIVE or with spend in the 56-day span.
  const spendByCampaign = new Map<string, number>()
  for (const r of input.campaignInsights) spendByCampaign.set(r.campaign_id, (spendByCampaign.get(r.campaign_id) ?? 0) + num(r.spend))
  const eligible = input.campaigns
    .filter(c => !c.name.toUpperCase().startsWith('ZZ '))
    .filter(c => c.status === 'ACTIVE' || (spendByCampaign.get(c.id) ?? 0) > 0)

  const rowsFor = (campaignId: string, win: DateWindow) =>
    input.campaignInsights.filter(r => r.campaign_id === campaignId && inRange(r.date_start, win))

  const currentSpend = (id: string) => rowsFor(id, w.current).reduce((s, r) => s + num(r.spend), 0)
  const priorSpend = (id: string) => rowsFor(id, w.prior).reduce((s, r) => s + num(r.spend), 0)
  const ranked = [...eligible].sort((a, b) =>
    currentSpend(b.id) - currentSpend(a.id) || priorSpend(b.id) - priorSpend(a.id) || a.id.localeCompare(b.id))
  const included = ranked.slice(0, MAX_CAMPAIGNS)
  const campaignRef = new Map(included.map((c, i) => [c.id, `C${i + 1}`]))

  // Account-wide spend by objective across ALL eligible campaigns (not just the capped list).
  const objectives = new Map<string, { current: number; prior: number }>()
  for (const c of eligible) {
    const key = c.objective ?? 'UNKNOWN'
    const e = objectives.get(key) ?? { current: 0, prior: 0 }
    e.current += currentSpend(c.id); e.prior += priorSpend(c.id)
    objectives.set(key, e)
  }

  // Ad sets / ads belonging to included campaigns.
  const adSetsByCampaign = new Map<string, StrategyAdSet[]>()
  for (const s of input.adSets) if (campaignRef.has(s.campaign_id)) {
    adSetsByCampaign.set(s.campaign_id, [...(adSetsByCampaign.get(s.campaign_id) ?? []), s])
  }
  const adSetCampaign = new Map(input.adSets.map(s => [s.id, s.campaign_id]))
  const orderedAdSets = included.flatMap(c => [...(adSetsByCampaign.get(c.id) ?? [])]
    .sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || a.id.localeCompare(b.id)))
  const shownAdSets = orderedAdSets.slice(0, MAX_AD_SETS)
  const adSetRef = new Map(shownAdSets.map((s, i) => [s.id, `S${i + 1}`]))

  const activeAdsByCampaign = new Map<string, number>()
  for (const a of input.ads) {
    const cid = adSetCampaign.get(a.ad_set_id)
    if (cid && a.status === 'ACTIVE') activeAdsByCampaign.set(cid, (activeAdsByCampaign.get(cid) ?? 0) + 1)
  }

  const campaigns = included.map(c => {
    const sets = adSetsByCampaign.get(c.id) ?? []
    return {
      ref: campaignRef.get(c.id)!,
      name: dataText(c.name),
      status: c.status,
      objective: c.objective ?? 'UNKNOWN',
      daily_budget: budgetAmount(c.daily_budget),
      age_days: c.created_at_meta ? Math.max(0, dayDiff(c.created_at_meta.slice(0, 10), w.today)) : null,
      ad_sets_total: sets.length,
      ad_sets_active: sets.filter(s => s.status === 'ACTIVE').length,
      ads_active: activeAdsByCampaign.get(c.id) ?? 0,
      current_28d: summarise(rowsFor(c.id, w.current), 8),
      prior_28d: summarise(rowsFor(c.id, w.prior), 8),
    }
  })

  const ad_sets = shownAdSets.map(s => ({
    ref: adSetRef.get(s.id)!,
    campaign_ref: campaignRef.get(s.campaign_id)!,
    name: dataText(s.name),
    status: s.status,
    daily_budget: budgetAmount(s.daily_budget),
  }))

  // Top ads by current-window spend, only those under included campaigns.
  const adMeta = new Map(input.ads.map(a => [a.id, a]))
  const adRows = new Map<string, StrategyAdInsight[]>()
  for (const r of input.adInsights) adRows.set(r.ad_id, [...(adRows.get(r.ad_id) ?? []), r])
  const adCandidates = [...adRows.keys()].flatMap(id => {
    const ad = adMeta.get(id)
    const cid = ad ? adSetCampaign.get(ad.ad_set_id) : undefined
    if (!ad || !cid || !campaignRef.has(cid)) return []
    const rows = adRows.get(id)!
    const cur = rows.filter(r => inRange(r.date_start, w.current))
    const pri = rows.filter(r => inRange(r.date_start, w.prior))
    return [{ ad, cid, cur, priorSpend: pri.reduce((s, r) => s + num(r.spend), 0), curSpend: cur.reduce((s, r) => s + num(r.spend), 0) }]
  }).filter(a => a.curSpend > 0 || a.priorSpend > 0)
    .sort((a, b) => b.curSpend - a.curSpend || b.priorSpend - a.priorSpend || a.ad.id.localeCompare(b.ad.id))
    .slice(0, MAX_ADS)

  const top_ads = adCandidates.map((a, i) => ({
    ref: `A${i + 1}`,
    campaign_ref: campaignRef.get(a.cid)!,
    ad_set_ref: adSetRef.get(a.ad.ad_set_id) ?? null,
    name: dataText(a.ad.name),
    status: a.ad.status,
    current_28d: summarise(a.cur.map(r => ({ ...r, frequency: undefined })), 5),
    prior_28d_spend: round(a.priorSpend),
  }))

  // Account-level 8-week trend (4 prior + 4 current), completed days only.
  const weeks = new Map<number, { spend: number; impressions: number; link_clicks: number }>()
  for (const r of input.campaignInsights) {
    if (!(inRange(r.date_start, w.prior) || inRange(r.date_start, w.current))) continue
    if (!campaignById.has(r.campaign_id) || campaignById.get(r.campaign_id)!.name.toUpperCase().startsWith('ZZ ')) continue
    const idx = Math.floor(dayDiff(w.prior.start, r.date_start) / 7)
    const e = weeks.get(idx) ?? { spend: 0, impressions: 0, link_clicks: 0 }
    e.spend += num(r.spend); e.impressions += num(r.impressions); e.link_clicks += num(r.inline_link_clicks)
    weeks.set(idx, e)
  }
  const weekly = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([idx, e]) => {
    const start = new Date(`${w.prior.start}T12:00:00Z`); start.setUTCDate(start.getUTCDate() + idx * 7)
    return { week_start: start.toISOString().slice(0, 10), spend: round(e.spend), impressions: round(e.impressions, 0), link_clicks: round(e.link_clicks, 0) }
  })

  const eligibleIds = new Set(eligible.map(c => c.id))
  const accountRows = (win: DateWindow) => input.campaignInsights.filter(r => eligibleIds.has(r.campaign_id) && inRange(r.date_start, win))
  const spendCurrent = accountRows(w.current).reduce((s, r) => s + num(r.spend), 0)
  const spendPrior = accountRows(w.prior).reduce((s, r) => s + num(r.spend), 0)

  // Calendar-month position against the hard ceiling (Copenhagen month, completed days).
  const monthStart = `${w.today.slice(0, 8)}01`
  const mtd = input.campaignInsights
    .filter(r => eligibleIds.has(r.campaign_id) && r.date_start >= monthStart && r.date_start <= w.current.end)
    .reduce((s, r) => s + num(r.spend), 0)
  const [y, m] = w.today.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const daysElapsed = Math.max(0, dayDiff(monthStart, w.today))

  // ── Projection (NOT a fact) ───────────────────────────────────────────────
  // MTD only covers completed days. Currently ACTIVE campaigns keep spending, so the
  // capacity left under the ceiling is the ceiling minus MTD minus what they are
  // expected to spend for the rest of the month (today included).
  const recent: DateWindow = { start: addDays(w.current.end, -(RUN_RATE_DAYS - 1)), end: w.current.end }
  const activeCampaigns = eligible.filter(c => c.status === 'ACTIVE')
  const activeIds = new Set(activeCampaigns.map(c => c.id))
  const recentRows = input.campaignInsights.filter(r => activeIds.has(r.campaign_id) && inRange(r.date_start, recent))
  const recentDaily = recentRows.reduce((s, r) => s + num(r.spend), 0) / RUN_RATE_DAYS
  const thinCampaigns = activeCampaigns.filter(c =>
    new Set(recentRows.filter(r => r.campaign_id === c.id && num(r.spend) > 0).map(r => r.date_start)).size < MIN_SPEND_DAYS_FOR_RELIABLE_RUN_RATE).length

  // Daily-budget upper bound: campaign budget if set (CBO), else the ACTIVE ad-set budgets of that campaign.
  let budgetTotal = 0
  for (const c of activeCampaigns) {
    const campaignBudget = budgetAmount(c.daily_budget)
    budgetTotal += campaignBudget && campaignBudget > 0
      ? campaignBudget
      : input.adSets.filter(s => s.campaign_id === c.id && s.status === 'ACTIVE').reduce((sum, s) => sum + (budgetAmount(s.daily_budget) ?? 0), 0)
  }
  const budgetUsable = budgetTotal > 0 && recentDaily > 0
    && budgetTotal >= recentDaily * BUDGET_SANITY_RANGE.min && budgetTotal <= recentDaily * BUDGET_SANITY_RANGE.max
  const assumedDaily = Math.max(recentDaily, budgetUsable ? budgetTotal : 0)
  const remainingDays = daysInMonth - daysElapsed
  const projectedRemaining = assumedDaily * remainingDays
  const projectedMonthEnd = mtd + projectedRemaining

  const unreliable: string[] = []
  if (input.currency !== 'DKK') unreliable.push(`Account currency is ${input.currency}, not DKK, so it cannot be compared with the DKK ceiling.`)
  if (thinCampaigns > 0) unreliable.push(`${thinCampaigns} active campaign(s) spent on fewer than ${MIN_SPEND_DAYS_FOR_RELIABLE_RUN_RATE} of the last ${RUN_RATE_DAYS} days, so the recent run rate is not representative.`)
  const reliable = unreliable.length === 0

  const projection = {
    label: 'PROJECTION, not a fact. Existing spend is extrapolated; the real month-end figure can differ.',
    method: `Average daily spend of currently ACTIVE campaigns over the last ${RUN_RATE_DAYS} completed days (raised to their combined daily budgets when those are consistent with actual spend), repeated for every remaining day this month including today, added to month-to-date spend.`,
    reliable,
    unreliable_reasons: unreliable,
    recent_daily_spend: round(recentDaily),
    active_daily_budget_total: budgetTotal > 0 ? round(budgetTotal) : null,
    active_daily_budget_used_as_upper_bound: budgetUsable,
    assumed_daily_spend_for_existing_campaigns: round(assumedDaily),
    remaining_days_in_month_including_today: remainingDays,
    projected_remaining_existing_spend: round(projectedRemaining),
    projected_month_end_spend: round(projectedMonthEnd),
    /** The ONLY capacity available for new tests, shared by all of them. null = not reliable, so no test budget may be proposed. */
    projected_incremental_headroom: reliable ? round(Math.max(0, MONTHLY_CEILING_DKK - projectedMonthEnd)) : null,
    not_modelled: 'New campaigns, budget changes, lifetime budgets, and spend variation (Meta can exceed a daily budget on some days).',
  }

  const accountSplit = splitBusinessOutcomes(sumActions(accountRows(w.current)))
  const accountActions = {
    top_actions_current_28d: topActions(accountSplit.rest, 10),
    business_outcomes_current_28d: accountSplit.outcomes,
  }

  const data_gaps: string[] = [...DATA_GAPS_STATIC]
  if (input.currency !== 'DKK') data_gaps.push(`Ad account currency is ${input.currency}; the 15,000 ceiling is expressed in DKK and is not converted here.`)
  if (ranked.length > included.length) data_gaps.push(`${ranked.length - included.length} lower-spend campaigns are omitted from the campaign list (spend totals still include them).`)
  if (!top_ads.length) data_gaps.push('No ad-level delivery rows were found in the window.')

  return {
    schema_version: PAID_STRATEGY_EVIDENCE_VERSION,
    as_of_date: w.today,
    window: { current_28d: w.current, prior_28d: w.prior },
    budget: {
      currency: input.currency,
      monthly_ceiling: MONTHLY_CEILING_DKK,
      ceiling_is_hard_cap_not_target: true,
      month_to_date_spend: round(mtd),
      month_days_elapsed: daysElapsed,
      month_days_total: daysInMonth,
      spend_current_28d: round(spendCurrent),
      spend_prior_28d: round(spendPrior),
      projection,
    },
    calibration: {
      known: { monthly_ceiling_dkk: MONTHLY_CEILING_DKK, ceiling_is_hard_cap: true },
      unknown: [...CALIBRATION_UNKNOWN],
    },
    account: {
      spend_by_objective: [...objectives.entries()].sort((a, b) => b[1].current - a[1].current)
        .map(([objective, e]) => ({ objective, current_28d: round(e.current), prior_28d: round(e.prior) })),
      weekly,
      ...accountActions,
    },
    campaigns,
    ad_sets,
    top_ads,
    human_strategy_decisions: humanDecisionsEvidence(input.humanDecisions ?? [], input.now),
    ...priorInsightsSection(input.priorInsights),
    data_gaps,
  }
}

/** Only present when there are prior insights, so a first run sees exactly the evidence it always did. */
function priorInsightsSection(items: PriorInsightInput[] | undefined) {
  const prior = priorInsightsEvidence(items ?? [], dataText)
  return prior ? { prior_insights: prior } : {}
}

/** Recent rejections only (last 180 days, at most 10, newest first). Free text is labelled untrusted data. */
export function humanDecisionsEvidence(decisions: HumanStrategyDecisionInput[], now: Date) {
  const since = now.getTime() - HUMAN_DECISION_WINDOW_DAYS * 86_400_000
  return decisions
    .filter(d => { const t = Date.parse(d.rejected_at); return Number.isFinite(t) && t >= since && t <= now.getTime() + 86_400_000 })
    .sort((a, b) => Date.parse(b.rejected_at) - Date.parse(a.rejected_at))
    .slice(0, MAX_HUMAN_DECISIONS)
    .map(d => ({
      decision: 'rejected' as const, recommendation: dataText(d.title, 160), recommendation_type: d.recommendation_type,
      reason: d.reason ? dataText(d.reason, 300) : null, rejected_on: d.rejected_at.slice(0, 10),
    }))
}

export type PaidStrategyEvidence = ReturnType<typeof buildPaidStrategyEvidence>
