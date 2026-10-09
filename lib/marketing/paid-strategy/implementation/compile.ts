/**
 * Deterministic compiler: stored Paid Strategy recommendation + synced Kockpit data + capability discovery + a person's
 * inputs -> a preview of exactly what Kockpit will DO itself, where it expects to stop, and who it will ask for what.
 *
 * Pure (no I/O). No AI. It never produces a task: a person appears only as the exact decision, access grant or physical
 * act Kockpit cannot supply. The recommendation's PROSE is the only strategy input; IDs, statuses, budgets and currencies
 * come from synced tables, and any change to an existing object is built by the existing trusted compileExecutionPlan.
 */

import { compileExecutionPlan } from '@/lib/marketing/paid-recs/compile-plan'
import { MAX_AUTOMATED_BUDGET_CHANGE } from '@/lib/marketing/paid-recs/guardrails'
import { metaBudgetToMajor } from '@/lib/meta/money'
import { dataText } from '../evidence'
import type { PaidStrategyRecommendationType, PaidStrategyRun } from '../types'
import { byId, type Capability } from '../autonomous/capabilities'
import { diagnoseTracking } from '../autonomous/tracking'
import type { Blocker } from '../autonomous/types'
import type { BudgetView, CompiledImplementation, ImplementationInputs, ImplementationMode, InputRequirement, PlatformPreview, SpendPlan } from './types'

export type StoredRecommendation = PaidStrategyRun['recommendations'][number]

export interface SyncedCampaign { id: string; name: string; status: string; ad_account_id: string; daily_budget: unknown; currency: string }
export interface SyncedAdSet { id: string; campaign_id: string; name: string; status: string; daily_budget: unknown }

export interface CompileInput {
  recommendation: StoredRecommendation
  runGeneratedAt: string
  /** The evidence exactly as it was sent to the model; only its local C-ref -> name table is used. */
  evidenceCampaigns: { ref: string; name: string }[]
  projectedHeadroomDkk: number | null
  headroomReliable: boolean
  reservedByOthersDkk: number
  campaigns: SyncedCampaign[]
  adSets: SyncedAdSet[]
  configuredMetaAdAccountId: string | undefined
  capabilities: Capability[]
  inputs: ImplementationInputs
  now: Date
}

export const toMajor = metaBudgetToMajor
const dkk = (n: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n)} DKK`
// Costs round UP and capacity rounds DOWN, so rounding can never let a plan slip past the ceiling.
const roundUp2 = (n: number) => (Math.ceil(n * 100 - 1e-9) / 100) || 0
const roundDown2 = (n: number) => (Math.floor(n * 100 + 1e-9) / 100) || 0

export const MODE_BY_TYPE: Record<PaidStrategyRecommendationType, Exclude<ImplementationMode, 'needs_input'>> = {
  tracking: 'tracking_execution', funnel: 'tracking_execution',
  creative: 'creative_execution', copy: 'creative_execution',
  campaign_structure: 'campaign_creation', retargeting: 'campaign_creation', audience: 'campaign_creation',
  budget: 'platform_action',
}

export const MARKETS = ['Malmö', 'Malmo', 'Copenhagen', 'København', 'Aarhus', 'Odense', 'Aalborg', 'Stockholm', 'Göteborg', 'Gothenburg', 'Lund']
const marketRe = (m: string) => new RegExp(`(?<![\\p{L}])${m}(?![\\p{L}])`, 'iu')
const actionText = (r: StoredRecommendation) => [r.title, r.hypothesis, r.exact_test_or_action].join('\n')
export const detectMarket = (text: string): string | null => MARKETS.find(m => marketRe(m).test(text)) ?? null

/** "daily budget of 100 DKK ... for 21 days" -> a plan. Anything not stated stays null and becomes a question, never a guess. */
export function parseSpendPlan(text: string): { dailyBudgetDkk: number | null; durationDays: number | null } {
  const num = (s: string) => Number(s.replace(/[,\s]/g, ''))
  const daily = /daily budget (?:of )?(\d[\d,.]*)\s*DKK/i.exec(text) ?? /(\d[\d,.]*)\s*DKK\s*(?:per day|a day|\/\s*day)/i.exec(text)
  const days = /(?:for|over|run for|running for)\s+(\d{1,2})\s*days/i.exec(text)
  const d = daily ? num(daily[1]) : NaN
  return { dailyBudgetDkk: Number.isFinite(d) && d > 0 ? d : null, durationDays: days ? Number(days[1]) : null }
}

/** Local C-refs the model used ("C2") -> real synced campaign, via the stored evidence name. Ambiguity resolves to nothing. */
export function referencedCampaigns(rec: StoredRecommendation, evidenceCampaigns: CompileInput['evidenceCampaigns'], synced: SyncedCampaign[]) {
  // Only the action fields: the evidence prose cites many campaigns for context, which says nothing about the target.
  const text = actionText(rec)
  const found: { ref: string; name: string; campaign: SyncedCampaign }[] = []
  for (const m of text.matchAll(/\bC(\d{1,2})\b/g)) {
    const ref = `C${m[1]}`
    if (found.some(f => f.ref === ref)) continue
    const ev = evidenceCampaigns.find(c => c.ref === ref)
    if (!ev) continue
    const matches = synced.filter(c => dataText(c.name) === ev.name)
    if (matches.length === 1) found.push({ ref, name: matches[0].name, campaign: matches[0] })
  }
  return found
}

function remainingDaysInMonth(now: Date): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate() - d + 1
}

function budgetView(input: CompileInput, requested: number): BudgetView {
  const proposed = Math.max(0, input.recommendation.incremental_budget_dkk ?? 0)
  const reliable = input.headroomReliable && input.projectedHeadroomDkk != null
  return {
    proposedDkk: proposed, requestedDkk: requested, reliable,
    availableDkk: reliable ? Math.max(0, roundDown2(input.projectedHeadroomDkk! - input.reservedByOthersDkk)) : null,
    reservedByOthersDkk: input.reservedByOthersDkk, projectedHeadroomDkk: input.projectedHeadroomDkk,
  }
}

/** Blockers for a requested incremental amount. Combined approvals can never exceed the shared headroom. */
function budgetBlocker(b: BudgetView): InputRequirement | null {
  if (b.requestedDkk <= 0) return null
  if (!b.reliable || b.availableDkk == null) return { key: 'reserve_budget', label: 'Extra budget', detail: 'There is no reliable spend headroom this month, so no extra paid budget can be approved.' }
  if (b.requestedDkk > b.availableDkk) return { key: 'reserve_budget', label: 'Extra budget', detail: `Only ${dkk(b.availableDkk)} of the shared headroom is still available (${dkk(b.reservedByOthersDkk)} is already reserved by other approved strategy work). Lower the daily budget or the number of days.` }
  return null
}

function platformPreview(input: CompileInput): { preview: PlatformPreview | null; missing: InputRequirement[]; blocker: string | null } {
  const choice = input.inputs.platform
  const missing: InputRequirement[] = []
  if (!choice) {
    missing.push({ key: 'platform_target', label: 'Which existing campaign or ad set', detail: 'Pick the synced Meta object this change applies to. Kockpit never takes it from the advice text.' })
    missing.push({ key: 'platform_action', label: 'What to change', detail: 'Pause, resume, or set a new daily budget (within 20% of the current budget).' })
    return { preview: null, missing, blocker: null }
  }
  if (!input.configuredMetaAdAccountId) return { preview: null, missing: [], blocker: 'The Meta ad account is not configured, so account ownership cannot be verified.' }
  const adSet = choice.targetType === 'adset' ? input.adSets.find(s => s.id === choice.targetId) : undefined
  const campaign = input.campaigns.find(c => c.id === (choice.targetType === 'adset' ? adSet?.campaign_id : choice.targetId))
  if (!campaign || (choice.targetType === 'adset' && !adSet)) return { preview: null, missing: [], blocker: 'That target is not in the synced Meta data. Nothing was changed.' }
  if (choice.targetType === 'adset' && choice.action !== 'set_daily_budget') return { preview: null, missing: [], blocker: 'Kockpit can only pause or resume whole campaigns from here. Ad set and ad status changes are not supported in this version.' }
  if (campaign.currency !== 'DKK') return { preview: null, missing: [], blocker: `The account currency is ${campaign.currency}, not DKK, so the 15,000 DKK ceiling cannot be applied.` }

  const current = toMajor(adSet ? adSet.daily_budget : campaign.daily_budget)
  const label = adSet ? `ad set "${adSet.name}" in "${campaign.name}"` : `campaign "${campaign.name}"`
  const remaining = remainingDaysInMonth(input.now)
  let intent: unknown
  let before: string, after: string, actionLabel: string, incremental = 0

  if (choice.action === 'set_daily_budget') {
    if (choice.targetDailyBudget == null) { missing.push({ key: 'platform_budget', label: 'New daily budget (DKK)' }); return { preview: null, missing, blocker: null } }
    if (current == null) return { preview: null, missing: [], blocker: `This ${adSet ? 'ad set' : 'campaign'} has no daily budget in the synced data (its budget may sit on the ${adSet ? 'campaign' : 'ad sets'}).` }
    intent = { action_type: 'set_daily_budget', target_id: choice.targetId, target_type: choice.targetType, target_daily_budget: choice.targetDailyBudget }
    before = `${dkk(current)} per day`; after = `${dkk(choice.targetDailyBudget)} per day`
    actionLabel = choice.targetDailyBudget >= current ? 'Increase the daily budget' : 'Reduce the daily budget'
    incremental = Math.max(0, choice.targetDailyBudget - current) * remaining
  } else {
    const pause = choice.action === 'pause_campaign'
    if (pause && campaign.status !== 'ACTIVE') return { preview: null, missing: [], blocker: `The campaign is ${campaign.status}, not ACTIVE, so there is nothing to pause.` }
    if (!pause && campaign.status !== 'PAUSED') return { preview: null, missing: [], blocker: `The campaign is ${campaign.status}, not PAUSED, so there is nothing to resume.` }
    intent = { action_type: choice.action, target_id: choice.targetId }
    before = campaign.status; after = pause ? 'PAUSED' : 'ACTIVE'; actionLabel = pause ? 'Pause' : 'Resume'
    if (!pause) {
      const perDay = current ?? input.adSets.filter(s => s.campaign_id === campaign.id && s.status === 'ACTIVE').reduce((s, a) => s + (toMajor(a.daily_budget) ?? 0), 0)
      if (!perDay) return { preview: null, missing: [], blocker: 'The daily spend this would restart is unknown, so no budget can be reserved for it.' }
      incremental = perDay * remaining
    }
  }

  const compiled = compileExecutionPlan(intent, {
    platform: 'meta', campaignId: campaign.id, accountId: campaign.ad_account_id, status: campaign.status, currency: campaign.currency,
    dailyBudget: current, ...(adSet ? { adSetId: adSet.id } : {}),
  }, { metaAdAccountId: input.configuredMetaAdAccountId })
  if (!compiled.ok) return { preview: null, missing: [], blocker: compiled.reason }
  return { preview: { plan: compiled.plan, targetLabel: label, actionLabel, before, after, incrementalDkk: roundUp2(incremental) }, missing: [], blocker: null }
}

const capBlockers = (caps: Capability[], ids: Parameters<typeof byId>[1][]): Blocker[] =>
  ids.map(id => byId(caps, id)).filter(c => c.state === 'missing').map(c => ({ kind: 'access' as const, code: `missing_${c.id}`, capability: c.id, message: c.evidence, unblock: c.unblock ?? '' }))

export function compileImplementation(input: CompileInput, _index: number): CompiledImplementation {
  const r = input.recommendation
  const intendedMode = MODE_BY_TYPE[r.recommendation_type] ?? 'campaign_creation'
  const refs = referencedCampaigns(r, input.evidenceCampaigns, input.campaigns)
  const referenced = refs.map(x => ({ ref: x.ref, name: x.name }))
  const common = { intendedMode, referencedCampaigns: referenced, market: null as string | null, spend: null as SpendPlan | null, platform: null as PlatformPreview | null, missing: [] as InputRequirement[], expectedBlockers: [] as Blocker[], peopleNeeded: [] as string[], changesMeta: false }
  const zero = budgetView(input, 0)

  // ── Existing-object change (guardrailed, unchanged from v1) ───────────────────
  if (intendedMode === 'platform_action') {
    const { preview, missing, blocker } = platformPreview(input)
    if (!preview) {
      return { ...common, mode: 'needs_input', headline: blocker ?? 'Kockpit needs a few details before it can prepare this change.', willDo: [], willNot: ['Nothing has been changed in Meta.', 'Kockpit never takes a campaign ID from the advice text. You choose the target from synced Meta data.'], peopleNeeded: blocker ? [blocker] : missing.map(m => m.label), budget: zero, missing }
    }
    const budget = budgetView(input, preview.incrementalDkk)
    const blockerReq = budgetBlocker(budget)
    return {
      ...common, mode: blockerReq ? 'needs_input' : 'platform_action', headline: `${preview.actionLabel}: ${preview.targetLabel}, from ${preview.before} to ${preview.after}.`,
      willDo: [`On ${preview.targetLabel}: ${preview.actionLabel.toLowerCase()}, ${preview.before} → ${preview.after}.`, 'Re-read the live state first and stop if the status, budget, currency or account no longer match.', 'Read the result back from Meta and record before and after.'],
      willNot: [`Budget changes above ${Math.round(MAX_AUTOMATED_BUDGET_CHANGE * 100)}% are refused.`, 'No campaign, ad set, ad or creative is created.', 'If Meta does not confirm the change, Kockpit does not retry; it flags it for a person.'],
      peopleNeeded: ['Someone reviews the result in Meta after the change is verified.'], changesMeta: true, budget, missing: blockerReq ? [blockerReq] : [], platform: preview,
    }
  }

  // ── Tracking: Kockpit investigates the real stack and implements what it can write to ──
  if (intendedMode === 'tracking_execution') {
    const expected = diagnoseTracking(input.capabilities, null, null).blockers
    return {
      ...common, mode: 'tracking_execution', expectedBlockers: expected,
      headline: expected.length ? 'Kockpit will investigate your live tracking now. Today it expects to stop at the access listed below, and will say exactly what is missing.' : 'Kockpit will implement and verify the downstream conversion event.',
      willDo: ['Inspect the live website: tag manager, Meta pixel, the enquiry form and where enquiries go.', 'Read the pixel from Meta and record what already fires.', 'Implement the downstream conversion event itself wherever Kockpit can write.', 'Verify the event reaches Meta before calling it done, and record the evidence.'],
      willNot: ['It will not create a task for work Kockpit can do.', 'It will not report this complete without a verified write.', 'It will not change any Meta campaign or spend anything.', 'Extra paid-media budget: 0 DKK.'],
      peopleNeeded: expected.map(b => `${b.message} Smallest unblock: ${b.unblock}`), budget: zero,
    }
  }

  // ── Creative: Kockpit writes the creative and builds the paused ad ──────────────
  if (intendedMode === 'creative_execution') {
    const blockers: Blocker[] = [...capBlockers(input.capabilities, ['creative_text_generation', 'meta_ad_creation'])]
    if (refs.length !== 1) blockers.push({ kind: 'input', code: 'source_unresolved', message: `The recommendation names ${refs.length === 0 ? 'no campaign' : 'several campaigns'} Kockpit can match to exactly one synced campaign.`, unblock: 'Say which campaign the new ad belongs to.' })
    return {
      ...common, mode: blockers.length ? 'needs_input' : 'creative_execution', expectedBlockers: blockers, changesMeta: true,
      headline: `Kockpit will write the creative and prepare a paused ad${refs[0] ? ` in "${refs[0].name}"` : ''}: ${r.title}`,
      willDo: ['Write hook options, primary text, headline, description and call to action, using only facts the existing ad already states.', 'Reuse the existing images and destination, and run the new ad in the same ad set (same audience, placements and budget).', 'Have Meta validate it, then create it PAUSED and read it back.', 'Save the creative draft with its test design: what changes, what stays constant, the success metric and the length of the test.', 'Stop at READY TO ACTIVATE for your review.'],
      willNot: ['It will not publish or spend anything: the ad stays paused until you activate it.', 'It will not invent an offer, price, guarantee or response time. Ideas the existing ad does not support are listed as decisions.', 'It will not create a task, unless the idea genuinely needs new footage, and then only for the filming.', 'Extra paid-media budget: 0 DKK.'],
      peopleNeeded: ['Review the draft and activate it (your final creative approval).', 'Only if new footage is required: film the listed shots.'], budget: zero,
    }
  }

  // ── New campaign: Kockpit reads the source and builds a paused clone ───────────
  const source = refs.length === 1 ? refs[0] : null
  const market = input.inputs.campaign ? detectMarket(actionText(r)) : detectMarket(actionText(r))
  const sourceMarket = source ? detectMarket(source.name) : null
  const parsed = parseSpendPlan(actionText(r))
  const daily = input.inputs.campaign?.dailyBudgetDkk ?? parsed.dailyBudgetDkk
  const days = input.inputs.campaign?.durationDays ?? parsed.durationDays
  const spend: SpendPlan | null = daily != null && days != null ? { dailyBudgetDkk: daily, durationDays: days, totalDkk: roundUp2(daily * days) } : null
  const missing: InputRequirement[] = []
  if (daily == null) missing.push({ key: 'daily_budget', label: 'Daily budget (DKK)', detail: 'The recommendation does not state one.' })
  if (days == null) missing.push({ key: 'duration', label: 'Number of days to run', detail: 'The recommendation does not state one.' })
  const blockers: Blocker[] = [...capBlockers(input.capabilities, ['meta_campaign_creation', 'meta_adset_creation', 'meta_ad_creation'])]
  if (r.recommendation_type !== 'campaign_structure') blockers.push({ kind: 'capability', code: 'structure_unsupported', message: `Building ${r.recommendation_type} structures (audiences and retargeting) in Meta is not built yet; only cloning an existing campaign for a new market is.`, unblock: 'This needs to be built before Kockpit can do it.' })
  if (!source) blockers.push({ kind: 'input', code: 'source_unresolved', message: `The recommendation names ${refs.length === 0 ? 'no campaign' : 'several campaigns'} Kockpit can match to exactly one synced campaign to mirror.`, unblock: 'Say which campaign to mirror.' })
  if (!market) blockers.push({ kind: 'input', code: 'market_unresolved', message: 'The target market could not be read from the recommendation.', unblock: 'Say which market to target.' })
  else if (source && !sourceMarket) blockers.push({ kind: 'input', code: 'source_market', message: `The market of "${source.name}" could not be read, so the copy cannot be localised safely.`, unblock: 'Say which market the source campaign is for.' })
  else if (market && sourceMarket && market.toLowerCase() === sourceMarket.toLowerCase()) blockers.push({ kind: 'input', code: 'same_market', message: `The target market (${market}) is the same as the source campaign's.`, unblock: 'Say which different market to target.' })
  if (!input.configuredMetaAdAccountId) blockers.push({ kind: 'access', code: 'account_unconfigured', capability: 'meta_campaign_creation', message: 'The Meta ad account is not configured, so account ownership cannot be verified.', unblock: 'Set the Killer Kebab ad account in Kockpit.' })
  if (source && input.configuredMetaAdAccountId && source.campaign.ad_account_id !== input.configuredMetaAdAccountId) blockers.push({ kind: 'access', code: 'account_mismatch', message: 'The campaign to mirror is not in the configured Meta ad account.', unblock: 'Nothing can be created from a campaign in another account.' })
  if (spend && spend.totalDkk > Math.max(0, r.incremental_budget_dkk ?? 0) + 1e-9) blockers.push({ kind: 'input', code: 'budget_over_approval', message: `${dkk(daily!)} a day for ${days} days is ${dkk(spend.totalDkk)}, above the ${dkk(r.incremental_budget_dkk ?? 0)} the strategy proposed.`, unblock: 'Lower the daily budget or the number of days.' })

  const budget = budgetView(input, spend ? spend.totalDkk : 0)
  const budgetReq = budgetBlocker(budget)
  const allMissing = [...missing, ...(budgetReq ? [budgetReq] : [])]
  const stuck = blockers.length > 0 || allMissing.length > 0
  const where = market ?? 'the new market'
  return {
    ...common, mode: stuck ? 'needs_input' : 'campaign_creation', expectedBlockers: blockers, missing: allMissing, spend, market, budget, changesMeta: true,
    headline: `Kockpit will build a paused ${where} copy of ${source ? `"${source.name}"` : 'the source campaign'}${spend ? `: ${dkk(spend.dailyBudgetDkk)} a day for ${spend.durationDays} days (${dkk(spend.totalDkk)} at most)` : ''}.`,
    willDo: [
      `Read ${source ? `"${source.name}"` : 'the source campaign'}: objective, optimisation, attribution, placements, targeting, ad copy and images.`,
      `Build the ${where} version: same optimisation, placements and images, ${where} location, copy localised from ${sourceMarket ?? 'the source market'}.`,
      'Have Meta validate every request, then create the campaign, ad set, creative and ad, all PAUSED, and read each one back.',
      spend ? `Reserve ${dkk(spend.totalDkk)} against the shared headroom (only after you confirm).` : 'Reserve the budget once it is known.',
      'Stop at READY TO ACTIVATE showing the exact structure. Activating is a separate approval.',
    ],
    willNot: ['It will not activate or spend anything: everything is created paused.', 'It will not change the source campaign or any existing campaign.', 'It will not create a task. If a step fails, the objects already created stay paused and a retry never duplicates them.', 'It will not exceed the reserved budget or the 15,000 DKK monthly ceiling.'],
    peopleNeeded: ['Review the paused structure and activate it. Check the destination page suits the new market.'],
  }
}
