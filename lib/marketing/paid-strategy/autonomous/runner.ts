/**
 * The execution state machine for an approved Paid Strategy recommendation.
 *
 *   approved -> planning -> executing -> verifying -> ready_to_activate | in_motion | completed
 *                                   \-> waiting_for_input | waiting_for_access      (only at a genuine blocker)
 *                                   \-> needs_attention                             (uncertain or unexpected state)
 *
 * Principles, each enforced here and covered by tests:
 *   - Kockpit does the work. A person is asked only for a decision, an access grant, or a physical act.
 *   - Everything external is created PAUSED. Activation is a separate step with its own approval.
 *   - Every external create is recorded in the ledger BEFORE the next step, so a retry resumes instead of repeating.
 *   - After an uncertain response the object is looked up by its name token; it is adopted if found, and nothing
 *     is created again until that lookup has had time to be meaningful.
 *   - Nothing is reported done until it has been read back from the platform.
 *   - The model writes words only. Every ID here was resolved by the server from synced data or Meta reads.
 */

import { majorToMetaBudget } from '@/lib/meta/money'
import type { MetaAdConfig, MetaAdSetConfig, MetaCampaignConfig } from '@/lib/meta/campaign-config'
import type { CreateAdSetSpec, CreateAdSpec, CreateCampaignSpec, CreateCreativeSpec } from '@/lib/meta/creation'
import { MetaCreationUncertainError } from '@/lib/meta/creation'
import { MetaApiError } from '@/lib/meta/client'
import type { PaidRecExecutionPlan } from '@/lib/marketing/paid-recs/types'
import type { PlanExecution } from '@/lib/marketing/paid-recs/executor'
import { countryForMarket, geoFromExistingTargetings, geoFromSearch, planCampaignClone, type ClonePlan, type GeoLocations } from './campaign-plan'
import { byId, type Capability } from './capabilities'
import { applyPackageToCreative, heldConstant, physicalHandoff, type CreativePackage, type PhysicalHandoff, type Sources } from './creative'
import { diagnoseTracking, executeTracking, scanSiteHtml, type PixelFacts, type TrackingWriter } from './tracking'
import { stepDone, stepId, type Blocker, type ExecutionLedger, type StepRecord } from './types'
import type { CreativeAIResult, CreativeBrief } from '@/lib/ai/paid-strategy-creative'

export type RunStatus = 'completed' | 'in_motion' | 'ready_to_activate' | 'waiting_for_input' | 'waiting_for_access' | 'needs_attention' | 'failed' | 'planning' | 'executing' | 'verifying'

export interface MetaPort {
  readCampaign(id: string): Promise<MetaCampaignConfig>
  readAdSets(campaignId: string): Promise<MetaAdSetConfig[]>
  readAds(campaignId: string): Promise<MetaAdConfig[]>
  readAdSet(id: string): Promise<MetaAdSetConfig>
  readAd(id: string): Promise<MetaAdConfig>
  findByToken(act: string, kind: 'campaigns' | 'adsets' | 'ads' | 'adcreatives', token: string): Promise<Array<{ id: string; name: string; status?: string }>>
  geoSearch(name: string, country: string): Promise<Array<{ key: string; name: string; country_code: string; type: string }>>
  createCampaign(act: string, spec: CreateCampaignSpec, validateOnly: boolean): Promise<{ id?: string; validated?: true }>
  createAdSet(act: string, spec: CreateAdSetSpec, validateOnly: boolean): Promise<{ id?: string; validated?: true }>
  createCreative(act: string, spec: CreateCreativeSpec, validateOnly: boolean): Promise<{ id?: string; validated?: true }>
  createAd(act: string, spec: CreateAdSpec, validateOnly: boolean): Promise<{ id?: string; validated?: true }>
  setAdSetEndTime(adSetId: string, endTimeIso: string): Promise<void>
}

export interface RunnerDeps {
  now(): Date
  meta: MetaPort
  capabilities: Capability[]
  generateCreative(brief: CreativeBrief, sources: Sources): Promise<CreativeAIResult>
  fetchSiteHtml(url: string): Promise<string>
  readPixel(id: string): Promise<PixelFacts | null>
  writers: TrackingWriter[]
  /** The only task this feature may create: an irreducible physical act. */
  createHandoffTask(handoff: PhysicalHandoff, ownerUserId: string, dueDate: string): Promise<string | null>
  executePlan(plan: PaidRecExecutionPlan): Promise<PlanExecution>
  saveCreativeDraft(draft: { pkg: CreativePackage; title: string; campaignName: string; testDesign: Record<string, unknown>; assetState: 'existing_images' | 'needs_new_footage' }): Promise<void>
}

export interface RunContext {
  ledger: ExecutionLedger
  rec: { title: string; hypothesis: string; exact_test_or_action: string; success_metric: string; incremental_budget_dkk?: number }
  configuredAccountId: string | undefined
  /** Server-resolved from synced data (the model's C-ref -> unique synced campaign). null when it could not be resolved. */
  source: { campaignId: string; accountId: string; name: string; currency: string } | null
  market: string | null
  sourceMarket: string | null
  /** Synced campaign names + ids for market-geo discovery. */
  syncedCampaigns: { id: string; name: string; accountId: string }[]
  approvedIncrementalDkk: number
  dailyBudgetDkk: number | null
  durationDays: number | null
  ownerUserId: string
  dueDate: string
  save(status: RunStatus, ledger: ExecutionLedger, blockers?: Blocker[]): Promise<void>
}

export interface RunResult { status: RunStatus; message: string; blockers: Blocker[]; ledger: ExecutionLedger }

/** After an uncertain create we do not create again until the name lookup has had time to be meaningful. */
export const UNCERTAIN_WAIT_MS = 10 * 60_000

class Halt extends Error { constructor(readonly status: RunStatus, readonly userMessage: string, readonly blockers: Blocker[] = []) { super(userMessage) } }

const statusFor = (b: Blocker[]): RunStatus => b.some(x => x.kind === 'access' || x.kind === 'capability') ? 'waiting_for_access' : 'waiting_for_input'
const record = (l: ExecutionLedger, s: Omit<StepRecord, 'at'>, now: Date) => {
  l.steps = l.steps.filter(x => x.key !== s.key); l.steps.push({ ...s, at: now.toISOString() })
}

function mapMetaError(e: unknown, what: string): Halt {
  if (e instanceof MetaApiError) {
    const permission = e.code === 200 || e.code === 10 || /permission|not authorized|access/i.test(e.message)
    if (permission) return new Halt('waiting_for_access', `Meta refused the ${what}: ${e.message}`, [{ kind: 'access', code: 'meta_permission', capability: 'meta_creative_creation', message: `Meta refused the ${what} for lack of permission: ${e.message}`, unblock: 'Assign the Facebook Page and Instagram account to the Kockpit system user in Business Manager (or grant the missing permission Meta names).' }])
    return new Halt('needs_attention', `Meta rejected the ${what}: ${e.message}`)
  }
  return new Halt('needs_attention', `The ${what} failed unexpectedly. Nothing further was attempted.`)
}

/**
 * Create-once. Order: ledger -> name-token lookup -> create. A create that may have reached Meta is recorded as
 * uncertain; the next run looks the object up before doing anything else.
 */
async function ensure(ctx: RunContext, deps: RunnerDeps, key: string, kind: 'campaigns' | 'adsets' | 'ads' | 'adcreatives', name: string, create: () => Promise<{ id?: string }>): Promise<string> {
  const known = stepId(ctx.ledger, key)
  if (known) return known
  const act = ctx.configuredAccountId!
  const found = (await deps.meta.findByToken(act, kind, ctx.ledger.token)).filter(o => o.name === name)
  if (found.length > 1) throw new Halt('needs_attention', `More than one ${kind.replace(/s$/, '')} named "${name}" exists in the ad account. Nothing was created; a person must choose which to keep.`)
  if (found.length === 1) { record(ctx.ledger, { key, status: 'done', externalId: found[0].id, detail: { adopted: true } }, deps.now()); await ctx.save('executing', ctx.ledger); return found[0].id }

  const prior = ctx.ledger.steps.find(s => s.key === key && s.status === 'uncertain')
  if (prior && deps.now().getTime() - Date.parse(prior.at) < UNCERTAIN_WAIT_MS) {
    throw new Halt('needs_attention', `A previous attempt to create the ${kind.replace(/s$/, '')} may have succeeded. Kockpit will look it up again after a short wait rather than create a duplicate.`)
  }
  try {
    const res = await create()
    if (!res.id) throw new MetaCreationUncertainError('No id returned.')
    record(ctx.ledger, { key, status: 'done', externalId: res.id }, deps.now()); await ctx.save('executing', ctx.ledger)
    return res.id
  } catch (e) {
    if (e instanceof MetaCreationUncertainError) {
      record(ctx.ledger, { key, status: 'uncertain', detail: { reason: e.message } }, deps.now()); await ctx.save('needs_attention', ctx.ledger)
      throw new Halt('needs_attention', `Meta did not confirm the ${kind.replace(/s$/, '')} was created, and it may exist. Nothing was created again.`)
    }
    record(ctx.ledger, { key, status: 'failed', detail: { reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' } }, deps.now())
    throw mapMetaError(e, `${kind.replace(/s$/, '')}`)
  }
}

const finish = async (ctx: RunContext, status: RunStatus, message: string, blockers: Blocker[] = []): Promise<RunResult> => {
  ctx.ledger.blockers = blockers
  ctx.ledger.evidence.message = message
  await ctx.save(status, ctx.ledger, blockers)
  return { status, message, blockers, ledger: ctx.ledger }
}
const halted = (ctx: RunContext, e: unknown) => {
  if (e instanceof Halt) return finish(ctx, e.status, e.userMessage, e.blockers)
  return finish(ctx, 'needs_attention', 'An unexpected error stopped the work. Nothing further was attempted.')
}

// ── Malmö-style campaign creation ───────────────────────────────────────────────

export async function runCampaignCreation(ctx: RunContext, deps: RunnerDeps): Promise<RunResult> {
  try {
    await ctx.save('planning', ctx.ledger)
    const caps = ['meta_campaign_creation', 'meta_adset_creation', 'meta_ad_creation'].map(id => byId(deps.capabilities, id as never))
    const missing = caps.filter(c => c.state === 'missing')
    if (missing.length) return finish(ctx, 'waiting_for_access', 'Kockpit cannot create Meta campaigns.', missing.map(c => ({ kind: 'access' as const, code: `missing_${c.id}`, capability: c.id, message: c.evidence, unblock: c.unblock ?? '' })))
    if (!ctx.source || !ctx.market || !ctx.sourceMarket) return finish(ctx, 'waiting_for_input', 'The campaign to mirror or the target market could not be determined.', [{ kind: 'input', code: 'source_unresolved', message: 'Kockpit could not tell unambiguously which campaign to mirror or which market to target.', unblock: 'Say which existing campaign to mirror and the target market.' }])
    const act = ctx.configuredAccountId
    // Ownership first: nothing is read for, or created in, an account that is not the configured one.
    if (!act) return finish(ctx, 'waiting_for_access', 'The Meta ad account is not configured.', [{ kind: 'access', code: 'account_unconfigured', capability: 'meta_campaign_creation', message: 'The Meta ad account is not configured, so account ownership cannot be verified.', unblock: 'Set the Killer Kebab ad account in Kockpit.' }])
    if (ctx.source.accountId !== act) return finish(ctx, 'waiting_for_access', 'The campaign to mirror is not in the configured Meta ad account.', [{ kind: 'access', code: 'account_mismatch', message: 'The source campaign does not belong to the configured Meta ad account.', unblock: 'Nothing can be created from a campaign in another account.' }])

    // 1. Read the source structure from Meta (read-only) and resolve the market's geography.
    const [campaign, adSets, ads] = await Promise.all([deps.meta.readCampaign(ctx.source.campaignId), deps.meta.readAdSets(ctx.source.campaignId), deps.meta.readAds(ctx.source.campaignId)])
    const candidates: { campaignName: string; targeting: Record<string, unknown> | null }[] = []
    for (const c of ctx.syncedCampaigns.filter(c => c.accountId === act && new RegExp(`(?<![\\p{L}])${ctx.market}(?![\\p{L}])`, 'iu').test(c.name)).slice(0, 3)) {
      for (const s of await deps.meta.readAdSets(c.id)) candidates.push({ campaignName: c.name, targeting: s.targeting })
    }
    let geo = geoFromExistingTargetings(ctx.market, candidates)
    if (!geo.geo && !geo.blocker) {
      const country = countryForMarket(ctx.market)
      if (country) geo = geoFromSearch(ctx.market, country, await deps.meta.geoSearch(ctx.market, country))
    }
    if (geo.blocker) return finish(ctx, 'waiting_for_input', geo.blocker.message, [geo.blocker])

    // 2. Compile the proposed structure deterministically and validate it.
    const planned = planCampaignClone({
      token: ctx.ledger.token, market: ctx.market, sourceMarket: ctx.sourceMarket, sourceCampaignName: ctx.source.name, configuredAccountId: act, sourceAccountId: ctx.source.accountId,
      currency: ctx.source.currency, source: { campaign, adSets, ads }, geo: { geo: geo.geo as GeoLocations | null, origin: geo.origin },
      dailyBudgetDkk: ctx.dailyBudgetDkk, durationDays: ctx.durationDays, approvedIncrementalDkk: ctx.approvedIncrementalDkk,
    })
    if (!planned.ok) return finish(ctx, statusFor(planned.blockers), planned.blockers[0].message, planned.blockers)
    const plan = planned.plan
    ctx.ledger.evidence.plan = plan.review
    ctx.ledger.evidence.clonePlan = plan
    await ctx.save('executing', ctx.ledger)

    // 3. Meta validates every request before anything is created.
    if (!stepDone(ctx.ledger, 'preflight')) {
      await ctx.save('verifying', ctx.ledger)
      const validate = async <T>(what: string, call: () => Promise<T>) => { try { await call() } catch (e) { throw mapMetaError(e, `${what} (validation only, nothing was created)`) } }
      await validate('campaign', () => deps.meta.createCampaign(act!, plan.campaign, true))
      await validate('ad set', () => deps.meta.createAdSet(act!, { ...plan.adSet, campaignId: plan.source.campaignId }, true))
      await validate('creative', () => deps.meta.createCreative(act!, plan.creative, true))
      record(ctx.ledger, { key: 'preflight', status: 'done' }, deps.now())
      await ctx.save('executing', ctx.ledger)
    }

    // 4. Create, PAUSED, one object at a time, each recorded and read back.
    const campaignId = await ensure(ctx, deps, 'create_campaign', 'campaigns', plan.campaign.name, () => deps.meta.createCampaign(act!, plan.campaign, false))
    const c = await deps.meta.readCampaign(campaignId)
    if (c.status !== 'PAUSED' || !c.name.includes(ctx.ledger.token)) throw new Halt('needs_attention', 'The new campaign did not read back as paused. Nothing was activated.')

    const adSetId = await ensure(ctx, deps, 'create_adset', 'adsets', plan.adSet.name, () => deps.meta.createAdSet(act!, { ...plan.adSet, campaignId }, false))
    const s = await deps.meta.readAdSet(adSetId)
    if (s.status !== 'PAUSED' || s.campaign_id !== campaignId || s.daily_budget !== String(plan.adSet.dailyBudgetMinor)) throw new Halt('needs_attention', 'The new ad set did not read back as expected (paused, in the new campaign, with the approved daily budget). Nothing was activated.')

    const creativeId = await ensure(ctx, deps, 'create_creative', 'adcreatives', plan.creative.name, () => deps.meta.createCreative(act!, plan.creative, false))
    const adId = await ensure(ctx, deps, 'create_ad', 'ads', plan.adName, () => deps.meta.createAd(act!, { name: plan.adName, adSetId, creativeId }, false))
    const a = await deps.meta.readAd(adId)
    if (a.status !== 'PAUSED' || a.adset_id !== adSetId || a.creative?.id !== creativeId) throw new Halt('needs_attention', 'The new ad did not read back as expected (paused, in the new ad set, with the new creative). Nothing was activated.')

    // 5. Final verification of the whole structure.
    await ctx.save('verifying', ctx.ledger)
    ctx.ledger.evidence.created = { campaignId, adSetId, creativeId, adId, verifiedAt: deps.now().toISOString(), allPaused: true }
    record(ctx.ledger, { key: 'final_verify', status: 'done' }, deps.now())
    return finish(ctx, 'ready_to_activate', 'The paused Malmö structure was created and verified. It cannot spend until it is activated.')
  } catch (e) { return halted(ctx, e) }
}

// ── Creative execution ───────────────────────────────────────────────────────────

export async function runCreativeExecution(ctx: RunContext, deps: RunnerDeps): Promise<RunResult> {
  try {
    await ctx.save('planning', ctx.ledger)
    if (byId(deps.capabilities, 'creative_text_generation').state === 'missing') return finish(ctx, 'waiting_for_access', 'Kockpit cannot write creative.', [{ kind: 'access', code: 'no_ai', capability: 'creative_text_generation', message: 'The AI provider is not configured.', unblock: 'Configure ANTHROPIC_API_KEY.' }])
    if (!ctx.source) return finish(ctx, 'waiting_for_input', 'The campaign this creative is for could not be determined.', [{ kind: 'input', code: 'source_unresolved', message: 'Kockpit could not tell unambiguously which campaign this creative is for.', unblock: 'Say which campaign the new ad belongs to.' }])
    const act = ctx.configuredAccountId
    if (!act || ctx.source.accountId !== act) return finish(ctx, 'waiting_for_access', 'Account ownership could not be verified.', [{ kind: 'access', code: 'account_mismatch', message: 'The campaign is not in the configured Meta ad account.', unblock: 'Nothing can be created for a campaign in another account.' }])

    const [adSets, ads] = await Promise.all([deps.meta.readAdSets(ctx.source.campaignId), deps.meta.readAds(ctx.source.campaignId)])
    const active = adSets.filter(s => s.effective_status === 'ACTIVE' || s.status === 'ACTIVE')
    if (active.length !== 1) return finish(ctx, 'waiting_for_input', 'Exactly one active ad set is needed.', [{ kind: 'input', code: 'source_adset', message: `The campaign has ${active.length} active ad sets; the new ad goes into exactly one.`, unblock: 'Say which ad set the new ad should run in.' }])
    const live = ads.filter(a => a.adset_id === active[0].id && (a.effective_status === 'ACTIVE' || a.status === 'ACTIVE') && a.creative?.object_story_spec)
    if (live.length !== 1) return finish(ctx, 'waiting_for_input', 'Exactly one existing ad is needed as the control.', [{ kind: 'input', code: 'source_ad', message: `The ad set has ${live.length} active ads with a usable creative; the new ad is compared against exactly one.`, unblock: 'Say which ad is the control.' }])
    const control = live[0], oss = control.creative!.object_story_spec as Record<string, Record<string, unknown>>
    const shape = oss.link_data ?? oss.video_data
    const existingCopy = typeof shape?.message === 'string' ? shape.message : ''

    // 1. The words. Reused from the ledger on a retry: the model is never asked twice for the same approval.
    let pkg = ctx.ledger.evidence.package as CreativePackage | undefined
    if (!pkg) {
      await ctx.save('executing', ctx.ledger)
      const result = await deps.generateCreative({ title: ctx.rec.title, hypothesis: ctx.rec.hypothesis, exactTestOrAction: ctx.rec.exact_test_or_action, successMetric: ctx.rec.success_metric, existingCopy, existingCta: control.creative!.call_to_action_type, campaignName: ctx.source.name },
        { copy: existingCopy, recommendation: `${ctx.rec.title}\n${ctx.rec.hypothesis}\n${ctx.rec.exact_test_or_action}\n${ctx.rec.success_metric}` })
      if (!result.ok) return finish(ctx, 'failed', result.error)
      pkg = result.package
      ctx.ledger.evidence.package = pkg
      record(ctx.ledger, { key: 'write_creative', status: 'done' }, deps.now())
      await ctx.save('executing', ctx.ledger)
    }

    // 2. Map onto a copy of the control creative; compute what is held constant from the structure.
    const mapped = applyPackageToCreative(control.creative!.object_story_spec!, pkg)
    const testDesign = { variable: pkg.variable_tested, changed: mapped.changed, heldConstant: heldConstant(mapped.changed, true), successMetric: pkg.success_metric, durationDays: pkg.experiment_days, control: control.name, adSet: active[0].name, needsBusinessDecision: pkg.needs_business_decision }
    ctx.ledger.evidence.testDesign = testDesign
    if (!stepDone(ctx.ledger, 'save_draft')) {
      await deps.saveCreativeDraft({ pkg, title: ctx.rec.title, campaignName: ctx.source.name, testDesign, assetState: pkg.requires_new_footage ? 'needs_new_footage' : 'existing_images' })
      record(ctx.ledger, { key: 'save_draft', status: 'done' }, deps.now())
    }

    // 3. A physical act is the only thing a person is asked to do. Everything else is already prepared.
    const handoff = physicalHandoff(pkg)
    if (handoff) {
      if (!stepDone(ctx.ledger, 'handoff_task')) {
        const taskId = await deps.createHandoffTask(handoff, ctx.ownerUserId, ctx.dueDate)
        if (!taskId) throw new Halt('needs_attention', 'The filming request could not be created.')
        record(ctx.ledger, { key: 'handoff_task', status: 'done', externalId: taskId }, deps.now())
      }
      return finish(ctx, 'waiting_for_input', `Copy, script and test design are ready. Only the filming is left (${pkg.shot_list.length} shots).`, [{ kind: 'physical', code: 'film_shots', message: `Film ${pkg.shot_list.length} shots.`, unblock: handoff.title }])
    }

    // 4. Meta validates, then the paused draft is created in the existing ad set.
    const name = `${control.name.replace(/\s*\[KK-[a-f0-9]+\]$/i, '')} - Offer test [${ctx.ledger.token}]`
    const creativeSpec: CreateCreativeSpec = { name: `${control.creative!.name ?? 'Creative'} - Offer test [${ctx.ledger.token}]`, objectStorySpec: mapped.spec, degreesOfFreedomSpec: control.creative!.degrees_of_freedom_spec, urlTags: control.creative!.url_tags }
    if (!stepDone(ctx.ledger, 'preflight')) {
      await ctx.save('verifying', ctx.ledger)
      try { await deps.meta.createCreative(act, creativeSpec, true) } catch (e) { throw mapMetaError(e, 'creative (validation only, nothing was created)') }
      record(ctx.ledger, { key: 'preflight', status: 'done' }, deps.now())
    }
    const creativeId = await ensure(ctx, deps, 'create_creative', 'adcreatives', creativeSpec.name, () => deps.meta.createCreative(act, creativeSpec, false))
    const adId = await ensure(ctx, deps, 'create_ad', 'ads', name, () => deps.meta.createAd(act, { name, adSetId: active[0].id, creativeId }, false))
    const a = await deps.meta.readAd(adId)
    if (a.status !== 'PAUSED' || a.adset_id !== active[0].id || a.creative?.id !== creativeId) throw new Halt('needs_attention', 'The new ad did not read back as expected (paused, in the existing ad set, with the new creative). Nothing was activated.')
    ctx.ledger.evidence.created = { adSetId: active[0].id, creativeId, adId, verifiedAt: deps.now().toISOString(), allPaused: true }
    record(ctx.ledger, { key: 'final_verify', status: 'done' }, deps.now())
    return finish(ctx, 'ready_to_activate', 'The creative is written and the paused ad is ready in the existing ad set. It cannot spend until it is activated.')
  } catch (e) { return halted(ctx, e) }
}

// ── Tracking ─────────────────────────────────────────────────────────────────────

export async function runTrackingExecution(ctx: RunContext, deps: RunnerDeps, siteUrl: string): Promise<RunResult> {
  try {
    await ctx.save('planning', ctx.ledger)
    let site = null, siteError: string | undefined, pixel = null
    try { site = scanSiteHtml(await deps.fetchSiteHtml(siteUrl)) } catch (e) { siteError = e instanceof Error ? e.message.slice(0, 120) : 'unavailable' }
    try { const id = site?.pixelIds[0]; pixel = id ? await deps.readPixel(id) : null } catch { /* the pixel read is evidence, not a requirement */ }
    const diagnosis = diagnoseTracking(deps.capabilities, site, pixel, siteError)
    ctx.ledger.evidence.diagnosis = diagnosis.evidence
    record(ctx.ledger, { key: 'diagnose', status: 'done' }, deps.now())
    await ctx.save('executing', ctx.ledger)
    const outcome = await executeTracking(diagnosis, deps.writers)
    if (outcome.status === 'completed') { record(ctx.ledger, { key: 'write_and_verify', status: 'done', externalId: outcome.ref, detail: { evidence: outcome.evidence } }, deps.now()); return finish(ctx, 'completed', outcome.evidence) }
    if (outcome.status === 'needs_attention') { record(ctx.ledger, { key: 'write_and_verify', status: 'uncertain', detail: { reason: outcome.reason } }, deps.now()); return finish(ctx, 'needs_attention', outcome.reason) }
    return finish(ctx, 'waiting_for_access', 'Blocked: Kockpit cannot implement this tracking yet.', outcome.blockers)
  } catch (e) { return halted(ctx, e) }
}

// ── Activation (separate from creation, with its own approval) ───────────────────

export interface ActivationContext { ledger: ExecutionLedger; configuredAccountId: string; durationDays: number | null; mode: 'campaign_creation' | 'creative_execution'; save: RunContext['save'] }

/** Re-verifies the whole paused structure, then activates ad -> ad set -> campaign through the trusted executor. */
export async function runActivation(ctx: ActivationContext, deps: RunnerDeps): Promise<RunResult> {
  const created = ctx.ledger.evidence.created as { campaignId?: string; adSetId: string; adId: string } | undefined
  const asRun: RunContext = { ledger: ctx.ledger, save: ctx.save } as RunContext
  try {
    if (!created) return finish(asRun, 'needs_attention', 'There is no verified structure to activate.')
    await ctx.save('verifying', ctx.ledger)
    const [ad, adSet, campaign] = await Promise.all([deps.meta.readAd(created.adId), deps.meta.readAdSet(created.adSetId), created.campaignId ? deps.meta.readCampaign(created.campaignId) : Promise.resolve(null)])
    const plan = ctx.ledger.evidence.clonePlan as ClonePlan | undefined
    const stillPaused = (ad.status === 'PAUSED' || stepDone(ctx.ledger, 'activate_ad')) && (ctx.mode === 'creative_execution' || ((adSet.status === 'PAUSED' || stepDone(ctx.ledger, 'activate_adset')) && campaign && (campaign.status === 'PAUSED' || stepDone(ctx.ledger, 'activate_campaign'))))
    if (!stillPaused) throw new Halt('needs_attention', 'The structure changed in Meta since it was created. Nothing was activated; review it first.')
    if (ctx.mode === 'campaign_creation' && plan && adSet.daily_budget !== String(majorToMetaBudget(plan.dailyBudgetDkk))) throw new Halt('needs_attention', 'The ad set budget no longer matches the approved budget. Nothing was activated.')

    await ctx.save('executing', ctx.ledger)
    const run = async (key: string, plan2: PaidRecExecutionPlan) => {
      if (stepDone(ctx.ledger, key)) return
      const r = await deps.executePlan(plan2)
      if (!r.ok) {
        record(ctx.ledger, { key, status: r.uncertain ? 'uncertain' : 'failed', detail: { reason: r.reason, before: r.before, after: r.after } }, deps.now())
        throw new Halt('needs_attention', r.reason)
      }
      record(ctx.ledger, { key, status: 'done', detail: { before: r.before, after: r.after } }, deps.now()); await ctx.save('executing', ctx.ledger)
    }
    const act = ctx.configuredAccountId
    if (ctx.mode === 'campaign_creation') {
      if (!stepDone(ctx.ledger, 'set_end_time') && ctx.durationDays) {
        const end = new Date(deps.now().getTime() + ctx.durationDays * 86_400_000).toISOString()
        await deps.meta.setAdSetEndTime(created.adSetId, end)
        const back = await deps.meta.readAdSet(created.adSetId)
        if (!back.end_time || Math.abs(Date.parse(back.end_time) - Date.parse(end)) > 60_000) throw new Halt('needs_attention', 'The end date did not read back as set. Nothing was activated.')
        record(ctx.ledger, { key: 'set_end_time', status: 'done', detail: { end } }, deps.now())
      }
      await run('activate_ad', { action_type: 'meta_resume_ad', platform: 'meta', target_type: 'ad', target_id: created.adId, ad_account_id: act, expected_current_status: 'PAUSED' })
      await run('activate_adset', { action_type: 'meta_resume_adset', platform: 'meta', target_type: 'adset', target_id: created.adSetId, campaign_id: created.campaignId!, ad_account_id: act, expected_current_status: 'PAUSED' })
      await run('activate_campaign', { action_type: 'meta_resume_campaign', platform: 'meta', target_type: 'campaign', target_id: created.campaignId!, ad_account_id: act, expected_current_status: 'PAUSED' })
    } else {
      await run('activate_ad', { action_type: 'meta_resume_ad', platform: 'meta', target_type: 'ad', target_id: created.adId, ad_account_id: act, expected_current_status: 'PAUSED' })
    }
    return finish(asRun, 'in_motion', 'Activated and read back from Meta. It is now spending within the approved budget.')
  } catch (e) { return halted(asRun, e) }
}
