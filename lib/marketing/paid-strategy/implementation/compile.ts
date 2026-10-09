/**
 * Deterministic compiler: stored Paid Strategy recommendation + synced Kockpit data + a person's inputs
 * -> a preview of exactly what Kockpit would do and what it would not.
 *
 * Pure (no I/O). No AI. The recommendation's PROSE is the only strategy input: IDs, statuses, budgets and
 * currencies come from synced tables, and any platform change is built by the existing trusted
 * compileExecutionPlan, which enforces account ownership and the 20% budget-change guardrail.
 */

import { compileExecutionPlan } from '@/lib/marketing/paid-recs/compile-plan'
import { MAX_AUTOMATED_BUDGET_CHANGE } from '@/lib/marketing/paid-recs/guardrails'
import { dataText } from '../evidence'
import type { PaidStrategyRecommendationType, PaidStrategyRun } from '../types'
import type {
  BudgetView, CompiledImplementation, ImplementationInputs, ImplementationMode, ImplementationPackage, InputRequirement,
  PlatformPreview, TaskDraft,
} from './types'

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
  inputs: ImplementationInputs
  now: Date
}

/** Meta stores budgets in the currency's minor unit; the trusted compiler and executor work in major units. */
const MINOR_UNITS = 100
export const toMajor = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v) / MINOR_UNITS
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}
const dkk = (n: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n)} DKK`
// Costs round UP and capacity rounds DOWN, so rounding can never let a plan slip past the ceiling.
const roundUp2 = (n: number) => (Math.ceil(n * 100 - 1e-9) / 100) || 0
const roundDown2 = (n: number) => (Math.floor(n * 100 + 1e-9) / 100) || 0

export const MODE_BY_TYPE: Record<PaidStrategyRecommendationType, Exclude<ImplementationMode, 'needs_input'>> = {
  tracking: 'implementation_task',
  funnel: 'implementation_task',
  creative: 'creative_task',
  copy: 'creative_task',
  campaign_structure: 'implementation_package',
  retargeting: 'implementation_package',
  audience: 'implementation_package',
  budget: 'platform_action',
}

const MARKETS = ['Malmö', 'Malmo', 'Copenhagen', 'København', 'Aarhus', 'Odense', 'Aalborg', 'Stockholm', 'Göteborg', 'Gothenburg', 'Lund']
const recText = (r: StoredRecommendation) => [r.title, r.hypothesis, r.exact_test_or_action].join('\n')

/** Local C-refs the model used ("C2") -> real synced campaign, via the stored evidence name. Ambiguity resolves to nothing. */
export function referencedCampaigns(rec: StoredRecommendation, evidenceCampaigns: CompileInput['evidenceCampaigns'], synced: SyncedCampaign[]) {
  // Only the action fields: the evidence prose cites many campaigns for context, which says nothing about the target.
  const text = [rec.title, rec.hypothesis, rec.exact_test_or_action].join('\n')
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
  if (!b.reliable || b.availableDkk == null) {
    return { key: 'reserve_budget', label: 'Extra budget', detail: 'There is no reliable spend headroom this month, so no extra paid budget can be approved. Set it to 0 DKK to continue.' }
  }
  if (b.requestedDkk > b.availableDkk) {
    return { key: 'reserve_budget', label: 'Extra budget', detail: `Only ${dkk(b.availableDkk)} of the shared headroom is still available (${dkk(b.reservedByOthersDkk)} is already reserved by other approved strategy work). Lower the amount to continue.` }
  }
  return null
}

const sourceLine = (input: CompileInput, index: number) =>
  `Source: Paid Strategy · generated ${input.runGeneratedAt.slice(0, 10)} · recommendation ${index + 1} of the run`

function baseDescription(input: CompileInput, index: number, extra: string[]): string {
  const r = input.recommendation
  return [
    `**${r.title}**`, '',
    `**Why it matters:** ${r.interpretation}`, '',
    `**Hypothesis:** ${r.hypothesis}`, '',
    ...extra,
    `**Success condition:** ${r.success_metric}`, '',
    `**Evidence behind the recommendation:** ${r.evidence}`, '',
    `**Known limitation:** ${r.evidence_limitations}`, '',
    `_${sourceLine(input, index)}. This is a creative/strategic draft for human review; check every factual detail before acting._`,
  ].join('\n')
}

function taskFor(mode: 'implementation_task' | 'creative_task' | 'implementation_package', input: CompileInput, index: number, refs: { ref: string; name: string }[], requested: number, pkg: ImplementationPackage | null): TaskDraft {
  const r = input.recommendation
  const context = refs.length ? refs.map(x => `${x.ref} = ${x.name}`).join('; ') : 'None resolved from the synced campaigns'
  if (mode === 'implementation_task') {
    return {
      title: `Implement: ${r.title}`.slice(0, 160), priority: 2,
      description: baseDescription(input, index, [
        `**Implementation action:** ${r.exact_test_or_action}`, '',
        `**Done means:** the change is live and verified, and the resulting setup (event name, form, page or field) is written down on this task.`, '',
        `**Extra paid budget authorised:** ${dkk(requested)}`, '',
      ]),
    }
  }
  if (mode === 'creative_task') {
    return {
      title: `Killer Kreative: ${r.title}`.slice(0, 160), priority: 2,
      description: baseDescription(input, index, [
        `**Creative objective:** ${r.hypothesis}`, '',
        `**Exact angle or test:** ${r.exact_test_or_action}`, '',
        `**Campaign and context:** ${context}`, '',
        `**New spend needed:** ${requested > 0 ? `up to ${dkk(requested)} on top of existing spend` : 'none'}`, '',
        `**Constraints:** the finished asset must be approved by a person before anything is published. Kockpit creates no ads and publishes nothing. Check every factual claim in the copy and visuals.`, '',
        `**Keep constant so the test is readable:** audience, placement, schedule, budget, landing page and lead form. Change only the creative variable described above.`, '',
      ]),
    }
  }
  const p = pkg!
  return {
    title: `Launch package: ${r.title}`.slice(0, 160), priority: 2,
    description: baseDescription(input, index, [
      `**Package:** ${p.kind.replace(/_/g, ' ')}${p.market ? ` · ${p.market}` : ''}`, '',
      `**Recommended structure:** ${p.recommended_structure}`, '',
      `**Maximum incremental budget reserved:** ${dkk(p.maximum_incremental_budget_dkk)}`, '',
      `**Still to confirm:**`, ...p.must_still_be_confirmed.map(x => `- ${x}`), '',
      `**Assets required:**`, ...p.required_creative_assets.map(x => `- ${x}`), '',
      `**Tracking required:**`, ...p.required_tracking.map(x => `- ${x}`), '',
      `**Not done by Kockpit:** ${p.not_done_by_kockpit.join(' ')}`, '',
    ]),
  }
}

function buildPackage(input: CompileInput, requested: number, source: { ref: string; name: string; id: string } | null): ImplementationPackage {
  const r = input.recommendation
  const p = input.inputs.package ?? {}
  const text = recText(r)
  const market = p.location?.trim() || MARKETS.find(m => new RegExp(`(?<![\\p{L}])${m}(?![\\p{L}])`, 'iu').test(text)) || null
  const confirm: string[] = []
  if (!market) confirm.push('Target location or radius')
  confirm.push('Final starting daily budget, inside the reserved maximum')
  if (!p.leadForm && !p.landingPage) confirm.push('Lead form or landing page the campaign sends people to')
  if (!source) confirm.push('Which existing campaign this should mirror (none could be matched unambiguously)')
  if (!p.conversionEvent) confirm.push('Conversion event the campaign optimises for')
  const kind: ImplementationPackage['kind'] = r.recommendation_type === 'retargeting' ? 'retargeting_structure'
    : r.recommendation_type === 'audience' ? 'new_audience_structure' : 'new_campaign'
  return {
    version: 'v1', kind,
    objective: r.hypothesis,
    market,
    campaign_purpose: r.title,
    recommended_structure: r.exact_test_or_action,
    starting_budget_note: requested > 0
      ? `Start low inside the reserved maximum of ${dkk(requested)}; this is a ceiling for the test, not a target.`
      : 'No extra paid budget is reserved. Any launch must be funded by reallocating existing spend or be approved separately.',
    maximum_incremental_budget_dkk: requested,
    success_metric: r.success_metric,
    source_campaign_to_mirror: source ? { id: source.id, name: source.name } : null,
    must_still_be_confirmed: confirm,
    required_creative_assets: [p.asset ? `Approved asset: ${p.asset}` : 'Approved creative and copy for this market (a person must approve them before use)'],
    required_tracking: [
      p.conversionEvent ? `Conversion event: ${p.conversionEvent}` : 'The same conversion event the source campaign uses, verified end to end before any spend',
      `Known limitation: ${r.evidence_limitations}`,
    ],
    not_done_by_kockpit: [
      'Kockpit does not create the campaign, ad set, ad or creative in Meta in this version.',
      'No budget is spent until a person launches it.',
    ],
  }
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

export function compileImplementation(input: CompileInput, index: number): CompiledImplementation {
  const r = input.recommendation
  const intendedMode = MODE_BY_TYPE[r.recommendation_type] ?? 'implementation_package'
  const refs = referencedCampaigns(r, input.evidenceCampaigns, input.campaigns)
  const referenced = refs.map(x => ({ ref: x.ref, name: x.name }))

  const common = { intendedMode, referencedCampaigns: referenced }
  // The strategy may propose less than the headroom; an approver may lower the amount but never raise it.
  const proposed = Math.max(0, r.incremental_budget_dkk ?? 0)
  const requested = Math.min(proposed, input.inputs.reserveBudgetDkk ?? proposed)

  // ── Safe platform action (existing objects only) ───────────────────────────
  if (intendedMode === 'platform_action') {
    const { preview, missing, blocker } = platformPreview(input)
    const emptyBudget = budgetView(input, 0)
    if (!preview) {
      return {
        ...common, mode: 'needs_input', headline: blocker ?? 'Kockpit needs a few details before it can prepare this change.',
        willDo: [], willNot: ['Nothing has been changed in Meta.'],
        needsPerson: blocker ? [blocker] : missing.map(m => m.label),
        cannotAutomate: ['Kockpit never takes a campaign ID from the advice text. You choose the target from synced Meta data.', 'Kockpit cannot create campaigns, ad sets, ads or creatives.'],
        changesMeta: false, budget: emptyBudget, missing, task: null, package: null, platform: null,
      }
    }
    const budget = budgetView(input, preview.incrementalDkk)
    const blockerReq = budgetBlocker(budget)
    const missingAll: InputRequirement[] = blockerReq ? [blockerReq] : []
    const mode: ImplementationMode = blockerReq ? 'needs_input' : 'platform_action'
    return {
      ...common, mode, headline: `${preview.actionLabel}: ${preview.targetLabel}, from ${preview.before} to ${preview.after}.`,
      willDo: [
        `On ${preview.targetLabel}: ${preview.actionLabel.toLowerCase()}, ${preview.before} → ${preview.after}.`,
        'Re-read the live state first and stop if the status, budget, currency or account no longer match.',
        'Read the result back from Meta and record before and after.',
      ],
      willNot: [
        `Budget changes above ${Math.round(MAX_AUTOMATED_BUDGET_CHANGE * 100)}% are refused.`,
        'No campaign, ad set, ad or creative is created.',
        'If Meta does not confirm the change, Kockpit does not retry; it flags it for a person.',
      ],
      needsPerson: ['Someone reviews the result in Meta after the change is verified.'],
      cannotAutomate: [],
      changesMeta: true, budget, missing: missingAll, task: null, package: null, platform: preview,
    }
  }

  // ── Task / package modes ───────────────────────────────────────────────────
  const budget = budgetView(input, requested)
  const blockerReq = budgetBlocker(budget)
  const missing: InputRequirement[] = blockerReq ? [blockerReq] : []
  // Exactly one referenced campaign can be the structure to mirror; several references are ambiguous, so a person confirms.
  const source = refs.length === 1 ? { ref: refs[0].ref, name: refs[0].name, id: refs[0].campaign.id } : null
  const pkg = intendedMode === 'implementation_package' ? buildPackage(input, requested, source) : null
  const task = taskFor(intendedMode, input, index, referenced, requested, pkg)
  const budgetLine = requested > 0 ? `Extra paid-media budget reserved: ${dkk(requested)} (shared headroom; this does not spend it).` : 'Extra paid-media budget: 0 DKK.'
  const mode: ImplementationMode = blockerReq ? 'needs_input' : intendedMode

  if (intendedMode === 'implementation_task') {
    return {
      ...common, mode, headline: `Create an implementation task: ${r.title}`,
      willDo: ['Create one Kockpit task with the exact action, why it matters, the success condition, the evidence and the limitation.', 'Link the task back to this strategy run and recommendation.'],
      willNot: ['This will not change Meta, Google or any ad account.', 'It will not change the website, tracking or CRM itself.', budgetLine],
      needsPerson: ['A person must carry out the work described in the task and record the result.'],
      cannotAutomate: ['Kockpit cannot change tracking, funnels, landing pages or CRM setup on its own.'],
      changesMeta: false, budget, missing, task, package: null, platform: null,
    }
  }
  if (intendedMode === 'creative_task') {
    return {
      ...common, mode, headline: `Create a Killer Kreative task: ${r.title}`,
      willDo: ['Create one creative task with the objective, the exact angle to test, the success metric, the constraints and what must stay constant.', 'Link the task back to this strategy run and recommendation.'],
      willNot: ['This will not change Meta.', 'No ad is created or published; the creative must be approved by a person first.', budgetLine],
      needsPerson: ['A person creates the asset and approves every factual claim in it.'],
      cannotAutomate: ['Kockpit cannot produce or publish creative. There is no automated creative step yet.'],
      changesMeta: false, budget, missing, task, package: null, platform: null,
    }
  }
  return {
    ...common, mode, headline: `Create a structured launch package and implementation task: ${r.title}`,
    willDo: ['Save a structured launch package (objective, market, structure, budget ceiling, success metric, what is still unconfirmed, required assets and tracking).', 'Create one task from the package and link it back to this strategy run.'],
    willNot: ['No Meta campaign, ad set, ad or creative will be created in this version.', 'No money is spent until a person launches it.', budgetLine],
    needsPerson: pkg!.must_still_be_confirmed,
    cannotAutomate: ['Creating a new campaign structure in Meta is not supported by Kockpit yet.'],
    changesMeta: false, budget, missing, task, package: pkg, platform: null,
  }
}
