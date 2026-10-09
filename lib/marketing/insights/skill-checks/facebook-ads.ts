/**
 * The facebook-ads skill as an insight source: the checks Kockpit's STORED Meta data can answer reliably.
 *
 * The skill is an audit checklist (46 checks, vendored unmodified at lib/ai/skills/facebook-ads/CHECKS.md, pinned in UPSTREAM.json).
 * No model is involved here: each check is a small deterministic calculation using the skill's own pass / warning / fail thresholds
 * on data Kockpit already stores, so a result is a measurement, never a guess. A test compares every threshold below with the
 * vendored checklist, so the code cannot drift from the skill unnoticed.
 *
 * Only 4 of the 46 checks can be assessed (see FACEBOOK_ADS_NOT_ASSESSED for the other 42 and the exact blocker for each). Because
 * the Pixel/CAPI and Audience categories (half of the skill's scoring weight) cannot be assessed at all, NO health score or grade is
 * produced: a score over a fraction of the checklist would look more certain than it is.
 *
 * Findings are reported only for warning and fail results. A pass produces no insight; it lets an earlier finding fade.
 */

import { createHash } from 'node:crypto'
import { strategyWindows } from '@/lib/marketing/paid-strategy/evidence'
import type { InsightCandidate, InsightStrength, RunExtraction } from '../types'

export const FACEBOOK_ADS_SKILL_REF = 'facebook-ads@1.0.0#13b4d57'
export const CHECK_STABLE_KEY_PREFIX = 'facebook-ads:'
export const CHECK_SCOPE_KEY = 'paid:finding:facebook_ads_check'

// ── Thresholds: copied from the vendored CHECKS.md and verified against it by a test ──────────────────────────────────────
export const THRESHOLDS = {
  ctr: { passAtLeast: 1.0, failBelow: 0.5 },                       // M-CR12, percent
  adsPerAdSet: { passAtLeast: 5, warningAtLeast: 3 },              // M-CR2 (fail below 3)
  budgetUtilization: { passAbove: 80, failBelow: 60 },             // M-ST18, percent
  ctrDecline: { warningAtLeast: 10, fatigueAbove: 20 },            // M-CR4, percent over 14 days
} as const

// ── Kockpit guards: NOT from the skill. They only decide when a measurement is large enough to be worth judging ───────────
export const GUARDS = {
  minImpressionsForCtr: 5_000,
  minImpressionsPerWeekForDecline: 1_000,
  minLinkClicksEarlyWeekForDecline: 15,
  minSpendDaysOfSevenForBudget: 5,
} as const

/** Objectives whose goal is a click or a conversion. Awareness and engagement campaigns are not judged on link CTR. */
export const CLICK_ORIENTED_OBJECTIVES = new Set([
  'OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION',
  'LINK_CLICKS', 'CONVERSIONS', 'LEAD_GENERATION', 'PRODUCT_CATALOG_SALES', 'TRAFFIC',
])
const MINOR_UNITS_PER_CURRENCY_UNIT = 100 // Meta stores budgets in minor units (same as paid-strategy/evidence.ts)

export interface MetaChecksInput {
  now: Date
  currency: string
  campaigns: { id: string; name: string; status: string; objective: string | null; daily_budget: unknown }[]
  adSets: { id: string; campaign_id: string; name: string; status: string; daily_budget: unknown }[]
  ads: { id: string; ad_set_id: string; name: string; status: string }[]
  /** Daily campaign rows covering at least the last 28 completed days. */
  campaignInsights: { campaign_id: string; date_start: string; impressions: unknown; inline_link_clicks: unknown; spend: unknown }[]
  /** Daily ad rows covering at least the last 14 completed days. */
  adInsights: { ad_id: string; date_start: string; impressions: unknown; inline_link_clicks: unknown; spend: unknown }[]
}

export type CheckStatus = 'pass' | 'warning' | 'fail' | 'not_assessable'
export interface CheckResult {
  id: string
  name: string
  status: CheckStatus
  /** The skill's own wording of the rule that was applied. */
  rule: string
  /** Short measurement, for display in a source line. */
  measured: string | null
  title: string
  statement: string
  evidence_text: string
  limitations: string
  strength: InsightStrength
  /** Why nothing could be judged (only for not_assessable). */
  reason: string | null
}
export interface ChecklistOutcome {
  asOf: string
  window: { start: string; end: string }
  results: CheckResult[]
  extraction: RunExtraction
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const num = (v: unknown): number => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : 0 }
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10)
}
const inRange = (date: string, from: string, to: string) => date >= from && date <= to
const isZz = (name: string) => name.trim().toUpperCase().startsWith('ZZ ')
const plain = (value: string, max = 60) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const pct = (ratio: number, dp = 2) => `${(ratio * 100).toFixed(dp)}%`
const int = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n)
const money = (n: number, currency: string) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n)} ${currency}`
const budgetAmount = (v: unknown): number | null => (v == null ? null : num(v) / MINOR_UNITS_PER_CURRENCY_UNIT)

/** A deterministic uuid per evaluation day, so evaluating twice on one day is one observation, never two. */
export function checklistRunId(asOf: string): string {
  const h = createHash('sha256').update(`${FACEBOOK_ADS_SKILL_REF}:${asOf}`).digest('hex')
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

const notAssessable = (id: string, name: string, rule: string, reason: string): CheckResult => ({
  id, name, status: 'not_assessable', rule, measured: null, title: '', statement: '', evidence_text: '', limitations: '', strength: 'weak_signal', reason,
})

// ── M-CR12: CTR benchmark ───────────────────────────────────────────────────────────────────────────────────────────────────
function checkCtr(input: MetaChecksInput, w: { start: string; end: string }): CheckResult {
  const rule = 'M-CR12: pass when overall CTR is at least 1.0%; warning at 0.5-1.0%; fail below 0.5%.'
  const name = 'CTR benchmark'
  const included = new Set(input.campaigns.filter(c => !isZz(c.name) && c.objective && CLICK_ORIENTED_OBJECTIVES.has(c.objective)).map(c => c.id))
  let impressions = 0; let clicks = 0
  const seen = new Set<string>()
  for (const r of input.campaignInsights) {
    if (!included.has(r.campaign_id) || !inRange(r.date_start, w.start, w.end)) continue
    impressions += num(r.impressions); clicks += num(r.inline_link_clicks)
    if (num(r.impressions) > 0) seen.add(r.campaign_id)
  }
  if (impressions < GUARDS.minImpressionsForCtr) {
    return notAssessable('M-CR12', name, rule, `Fewer than ${int(GUARDS.minImpressionsForCtr)} impressions from click-oriented campaigns in the last 28 completed days.`)
  }
  const ctr = clicks / impressions
  const percent = ctr * 100
  const status: CheckStatus = percent >= THRESHOLDS.ctr.passAtLeast ? 'pass' : percent >= THRESHOLDS.ctr.failBelow ? 'warning' : 'fail'
  const measured = pct(ctr)
  return {
    id: 'M-CR12', name, status, rule, measured,
    title: status === 'fail' ? 'Link click-through rate is below the checklist’s failing level' : 'Link click-through rate is below the checklist’s passing level',
    statement: `Across click-oriented campaigns, ${measured} of impressions led to a link click over the last 28 completed days. The facebook-ads checklist treats under 0.5% as a fail and 1.0% or more as a pass.`,
    evidence_text: `${int(clicks)} link clicks on ${int(impressions)} impressions across ${seen.size} click-oriented campaign${seen.size === 1 ? '' : 's'}, ${w.start} to ${w.end}.`,
    limitations: 'A generic cross-industry benchmark, not calibrated to Killer Kebab. Awareness and engagement campaigns are left out (clicks are not their goal). CTR says nothing about lead quality or cost.',
    strength: status === 'fail' ? 'reasonable_inference' : 'weak_signal', reason: null,
  }
}

// ── M-CR2: creative volume per ad set ───────────────────────────────────────────────────────────────────────────────────────
function checkAdsPerAdSet(input: MetaChecksInput, w14: { start: string; end: string }): CheckResult {
  const rule = 'M-CR2: pass at 5-8 creatives per ad set; warning at 3-4; fail below 3.'
  const name = 'Creative volume per ad set'
  const activeCampaigns = new Set(input.campaigns.filter(c => c.status === 'ACTIVE' && !isZz(c.name)).map(c => c.id))
  const adSets = new Map(input.adSets.filter(s => s.status === 'ACTIVE' && activeCampaigns.has(s.campaign_id)).map(s => [s.id, s]))
  const adSetOfAd = new Map(input.ads.map(a => [a.id, a.ad_set_id]))
  const spend = new Map<string, number>()
  for (const r of input.adInsights) {
    const setId = adSetOfAd.get(r.ad_id)
    if (!setId || !adSets.has(setId) || !inRange(r.date_start, w14.start, w14.end)) continue
    spend.set(setId, (spend.get(setId) ?? 0) + num(r.spend))
  }
  const delivering = [...spend.entries()].filter(([, s]) => s > 0).map(([id, s]) => ({ set: adSets.get(id)!, spend: s }))
  if (!delivering.length) return notAssessable('M-CR2', name, rule, 'No active ad set delivered in the last 14 completed days.')
  const counts = new Map<string, number>()
  for (const ad of input.ads) if (ad.status === 'ACTIVE') counts.set(ad.ad_set_id, (counts.get(ad.ad_set_id) ?? 0) + 1)
  const rows = delivering.map(d => ({ name: plain(d.set.name), ads: counts.get(d.set.id) ?? 0, spend: d.spend }))
  const fail = rows.filter(r => r.ads < THRESHOLDS.adsPerAdSet.warningAtLeast)
  const warn = rows.filter(r => r.ads >= THRESHOLDS.adsPerAdSet.warningAtLeast && r.ads < THRESHOLDS.adsPerAdSet.passAtLeast)
  const status: CheckStatus = fail.length ? 'fail' : warn.length ? 'warning' : 'pass'
  const worst = [...fail, ...warn].sort((a, b) => b.spend - a.spend).slice(0, 3)
  const list = worst.map(r => `“${r.name}” (${r.ads} active ad${r.ads === 1 ? '' : 's'})`).join(', ')
  const low = fail.length + warn.length
  return {
    id: 'M-CR2', name, status, rule, measured: `${low} of ${rows.length} ad sets below 5 ads`,
    title: fail.length ? 'Some ad sets run on very few ads' : 'Some ad sets run on fewer ads than the checklist suggests',
    statement: `${low} of ${rows.length} ad sets that delivered in the last 14 completed days have fewer than 5 active ads${fail.length ? `, ${fail.length} of them fewer than 3` : ''}. The facebook-ads checklist looks for 5 to 8 per ad set and treats under 3 as a fail.`,
    evidence_text: `Highest spend among them: ${list}.`,
    limitations: 'Counts active ads as a stand-in for creatives (one creative can be reused across ads). The 5-8 range is written for larger accounts, so a small budget may reasonably run fewer. Only ad sets that delivered in the last 14 days are counted.',
    strength: fail.length ? 'reasonable_inference' : 'weak_signal', reason: null,
  }
}

// ── M-ST18: budget utilization ──────────────────────────────────────────────────────────────────────────────────────────────
function checkBudgetUtilization(input: MetaChecksInput, w7: { start: string; end: string }): CheckResult {
  const rule = 'M-ST18: pass above 80% of daily budget used; warning at 60-80%; fail below 60%.'
  const name = 'Budget utilization'
  const active = input.campaigns.filter(c => c.status === 'ACTIVE' && !isZz(c.name))
  let budget = 0; let spent = 0; let assessed = 0; let skippedIntermittent = 0; let withoutBudget = 0
  for (const c of active) {
    const own = budgetAmount(c.daily_budget)
    const daily = own && own > 0 ? own
      : input.adSets.filter(s => s.campaign_id === c.id && s.status === 'ACTIVE').reduce((sum, s) => sum + (budgetAmount(s.daily_budget) ?? 0), 0)
    if (!(daily > 0)) { withoutBudget++; continue }
    const rows = input.campaignInsights.filter(r => r.campaign_id === c.id && inRange(r.date_start, w7.start, w7.end))
    const spendDays = new Set(rows.filter(r => num(r.spend) > 0).map(r => r.date_start)).size
    if (spendDays < GUARDS.minSpendDaysOfSevenForBudget) { skippedIntermittent++; continue }
    budget += daily; spent += rows.reduce((s, r) => s + num(r.spend), 0) / 7; assessed++
  }
  if (!assessed) {
    return notAssessable('M-ST18', name, rule, 'No active campaign with a daily budget spent on at least 5 of the last 7 completed days (lifetime budgets are not assessed).')
  }
  const used = (spent / budget) * 100
  const status: CheckStatus = used > THRESHOLDS.budgetUtilization.passAbove ? 'pass' : used >= THRESHOLDS.budgetUtilization.failBelow ? 'warning' : 'fail'
  const measured = `${used.toFixed(0)}%`
  return {
    id: 'M-ST18', name, status, rule, measured,
    title: status === 'fail' ? 'Active campaigns are spending well under their daily budgets' : 'Active campaigns are spending somewhat under their daily budgets',
    statement: `Active campaigns used ${measured} of their combined daily budget on average over the last 7 completed days. The facebook-ads checklist treats under 60% as a fail and over 80% as a pass, and reads a low figure as a sign of targeting or bid problems.`,
    evidence_text: `${money(spent, input.currency)} spent a day against ${money(budget, input.currency)} budgeted a day, across ${assessed} active campaign${assessed === 1 ? '' : 's'}${skippedIntermittent ? `; ${skippedIntermittent} more spent on fewer than 5 of the 7 days and are not counted` : ''}${withoutBudget ? `; ${withoutBudget} have no daily budget set` : ''}.`,
    limitations: 'Targeting and bid settings are not stored, so the checklist’s suggested cause cannot be confirmed here. Budgets are today’s settings, and a campaign set up recently or paused part of the week will look under-used. Lifetime budgets are not assessed.',
    strength: status === 'fail' ? 'reasonable_inference' : 'weak_signal', reason: null,
  }
}

// ── M-CR4 (the CTR-decline half): creative fatigue signal ───────────────────────────────────────────────────────────────────
function checkCtrDecline(input: MetaChecksInput, w14: { start: string; end: string }): CheckResult {
  const rule = 'M-CR4: pass when no creative’s CTR fell more than 20% over 14 days; warning at 10-20% on some creatives; fail only when the decline is over 20% AND frequency is above 3.'
  const name = 'Creative fatigue (CTR decline)'
  const split = addDays(w14.start, 7)
  const early = { from: w14.start, to: addDays(split, -1) }
  const late = { from: split, to: w14.end }
  const activeCampaigns = new Set(input.campaigns.filter(c => c.status === 'ACTIVE' && !isZz(c.name)).map(c => c.id))
  const activeSets = new Set(input.adSets.filter(s => s.status === 'ACTIVE' && activeCampaigns.has(s.campaign_id)).map(s => s.id))
  const activeAds = new Map(input.ads.filter(a => a.status === 'ACTIVE' && activeSets.has(a.ad_set_id)).map(a => [a.id, a]))
  const sums = new Map<string, { ei: number; ec: number; li: number; lc: number }>()
  for (const r of input.adInsights) {
    if (!activeAds.has(r.ad_id)) continue
    const e = sums.get(r.ad_id) ?? { ei: 0, ec: 0, li: 0, lc: 0 }
    if (inRange(r.date_start, early.from, early.to)) { e.ei += num(r.impressions); e.ec += num(r.inline_link_clicks) }
    else if (inRange(r.date_start, late.from, late.to)) { e.li += num(r.impressions); e.lc += num(r.inline_link_clicks) }
    sums.set(r.ad_id, e)
  }
  const eligible = [...sums.entries()].filter(([, s]) => s.ei >= GUARDS.minImpressionsPerWeekForDecline && s.ec >= GUARDS.minLinkClicksEarlyWeekForDecline && s.li >= GUARDS.minImpressionsPerWeekForDecline)
    .map(([id, s]) => {
      const before = s.ec / s.ei; const after = s.lc / s.li
      return { name: plain(activeAds.get(id)!.name), before, after, decline: ((before - after) / before) * 100 }
    })
  if (!eligible.length) {
    return notAssessable('M-CR4', name, rule, `No active ad had at least ${int(GUARDS.minImpressionsPerWeekForDecline)} impressions in each of the last two weeks and ${GUARDS.minLinkClicksEarlyWeekForDecline} link clicks in the first.`)
  }
  const flagged = eligible.filter(a => a.decline >= THRESHOLDS.ctrDecline.warningAtLeast).sort((a, b) => b.decline - a.decline)
  const status: CheckStatus = flagged.length ? 'warning' : 'pass' // never 'fail': the skill's fail needs frequency above 3, which is not stored
  const top = flagged[0]
  const over20 = flagged.filter(a => a.decline > THRESHOLDS.ctrDecline.fatigueAbove).length
  return {
    id: 'M-CR4', name, status, rule, measured: top ? `${top.decline.toFixed(0)}% fall` : null,
    title: 'Some active ads’ click-through rate fell week on week',
    statement: `${flagged.length} of ${eligible.length} active ads with enough delivery saw their link click-through rate fall by 10% or more from one week to the next${over20 ? `, ${over20} of them by more than 20%` : ''}.`,
    evidence_text: top ? `Largest fall: “${top.name}” from ${pct(top.before)} to ${pct(top.after)} (${top.decline.toFixed(0)}% lower), comparing ${early.from} to ${early.to} with ${late.from} to ${late.to}.` : '',
    limitations: 'The checklist counts this as creative fatigue only when frequency is also above 3 over a 7-day window. Period reach frequency is not stored (only daily campaign frequency), so fatigue is NOT confirmed. Two weeks is a short comparison, and learning-phase changes, seasonality or a new audience can move CTR too.',
    strength: 'weak_signal', reason: null,
  }
}

// ── the assessable checks together ──────────────────────────────────────────────────────────────────────────────────────────
export function evaluateFacebookAdsChecks(input: MetaChecksInput): ChecklistOutcome {
  const w = strategyWindows(input.now)
  const w28 = w.current
  const w14 = { start: addDays(w.current.end, -13), end: w.current.end }
  const w7 = { start: addDays(w.current.end, -6), end: w.current.end }
  const results = [checkCtr(input, w28), checkAdsPerAdSet(input, w14), checkBudgetUtilization(input, w7), checkCtrDecline(input, w14)]

  const candidates: InsightCandidate[] = results.filter(r => r.status === 'warning' || r.status === 'fail').map(r => ({
    domain: 'paid', kind: 'finding', scope_key: CHECK_SCOPE_KEY, stable_key: `${CHECK_STABLE_KEY_PREFIX}${r.id}`,
    title: r.title, statement: r.statement, evidence_text: r.evidence_text, limitations: r.limitations, suggestion: null,
    strength: r.strength,
    refs: [{
      type: 'skill_check', skill: FACEBOOK_ADS_SKILL_REF, check_id: r.id, result: r.status as 'warning' | 'fail',
      measured: r.measured ?? '', rule: r.rule, window_start: w14.start, window_end: w28.end,
    }],
    recommendation_index: null,
  }))
  const assessedKeys = results.filter(r => r.status !== 'not_assessable').map(r => `${CHECK_STABLE_KEY_PREFIX}${r.id}`)
  return {
    asOf: w.today, window: { start: w28.start, end: w28.end }, results,
    extraction: {
      sourceKind: 'meta_account_checks', runId: checklistRunId(w.today), observedAt: input.now.toISOString(), candidates,
      // Only a check that WAS assessed can say an earlier finding no longer holds; one that could not be assessed says nothing.
      // `coverage` names the domain to load; `assessedKeys` narrows it to the checks that were actually judged.
      coverage: { paid: assessedKeys.length > 0 }, assessedKeys,
    },
  }
}

// ── the rest of the checklist, and exactly why it cannot be assessed ───────────────────────────────────────────────────────
export const EVALUATED_CHECK_IDS = ['M-CR12', 'M-CR2', 'M-ST18', 'M-CR4'] as const

export const FACEBOOK_ADS_NOT_ASSESSED: { blocker: string; checks: string[] }[] = [
  { blocker: 'Pixel, dataset and Conversions API health is not stored. Kockpit reads the pixel’s last-fired time live only while executing a tracking change and does not keep it; event match quality, deduplication, CAPI coverage, domain verification, event priority and attribution settings are not read anywhere.',
    checks: ['M-PX1', 'M-PX2', 'M-PX3', 'M-PX4', 'M-PX5', 'M-PX6', 'M-PX7', 'M-PX8', 'M-PX9', 'M-PX10'] },
  { blocker: 'Audiences and targeting are not stored: meta_ad_sets holds only a name, status and budget, so audience definitions, overlap, custom or lookalike audiences, exclusions, customer lists and Advantage+ settings are unknown.',
    checks: ['M-AU1', 'M-AU2', 'M-AU3', 'M-AU4', 'M-AU5', 'M-AU6', 'M-ST6'] },
  { blocker: 'Creative format, aspect ratio, UGC, Advantage+ creative and whether an organic post is boosted are not stored (meta_ads holds a name and status only); ad creation time is not stored, so creative freshness cannot be dated.',
    checks: ['M-CR1', 'M-CR3', 'M-CR6', 'M-CR7', 'M-CR8', 'M-CR9'] },
  { blocker: 'Video hook rate needs 3-second view data, which is not stored.', checks: ['M-CR5'] },
  { blocker: 'Frequency over a period (reach-based) is not stored, only daily campaign frequency, and campaigns are not labelled prospecting or retargeting.',
    checks: ['M-CR10', 'M-CR11', 'M-ST13'] },
  { blocker: 'Learning phase, bid strategy, placements, attribution settings, UTMs and A/B tests are not stored.',
    checks: ['M-ST3', 'M-ST4', 'M-ST9', 'M-ST10', 'M-ST11', 'M-ST12', 'M-ST15', 'M-ST16'] },
  { blocker: 'Target CPA or CPL is unknown (calibration is not supplied), so budget adequacy cannot be judged.', checks: ['M-ST17'] },
  { blocker: 'The checklist’s budget thresholds are in USD and the ad account is in DKK; no conversion basis is defined, so none is guessed.', checks: ['M-ST2', 'M-ST7'] },
  { blocker: 'The business goal is not stored, so objective alignment cannot be judged; a per-segment campaign count needs segments (country, funnel stage) that are not stored; breakdown review is a process, not data; Advantage+ Shopping needs a product catalog that is not stored.',
    checks: ['M-ST1', 'M-ST5', 'M-ST8', 'M-ST14'] },
]
