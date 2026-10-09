/**
 * Paid Strategy implementation service (executor-first). Server-only; the server actions authorize first and call this.
 *
 *   prepare   compile a preview from the stored recommendation. Writes one 'prepared' / 'needs_input' row. Never a side effect.
 *   confirm   re-compile from scratch (nothing the browser sent about plans or IDs is trusted), claim atomically in the
 *             database (budget reservation + exactly-once), then let Kockpit DO the work through the execution state machine.
 *   resume    continue from the step ledger after a blocker is cleared or an interruption. Never repeats a completed step.
 *   activate  a separate approval that switches on the verified PAUSED structure through the trusted executor.
 *   cancel    release the reservation. Objects already created stay paused in Meta.
 *   reject    a human decision that the recommendation should not be pursued. Releases the reservation, never touches Meta,
 *             and is remembered: later analyses receive it as a human business decision.
 *
 * The model is involved in exactly one place: writing creative words (lib/ai/paid-strategy-creative). It never sees or
 * returns an ID, and its output is validated before anything is built from it.
 */

import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { recordImplementationAudit } from './audit'
import { compileImplementation, toMajor, type CompileInput, type StoredRecommendation, type SyncedAdSet, type SyncedCampaign } from './compile'
import { activateClaimed, runClaimed, type Claim } from './execute'
import {
  CANCELLABLE_STATUSES, ImplementationInputsSchema, IN_FLIGHT_STATUSES, REJECTION_REASON_MAX, RESUMABLE_STATUSES,
  type CompiledImplementation, type ImplementationInputs, type ImplementationMode, type ImplementationStatus, type InputRequirement,
} from './types'
import type { Capability } from '../autonomous/capabilities'
import type { RunnerDeps } from '../autonomous/runner'
import type { Blocker, ExecutionLedger } from '../autonomous/types'

type Db = ReturnType<typeof createServiceClient>
const TABLE = 'marketing_paid_strategy_implementations'
const REPREPARABLE: ImplementationStatus[] = ['prepared', 'needs_input', 'failed']
const DEFAULT_DUE_DAYS = 7
/** An implementation stuck mid-run (a crash, a restart) can be resumed after this long. */
const STALE_MS = 5 * 60_000

interface RunRow {
  id: string; status: string; generated_at: string
  recommendations: StoredRecommendation[]
  evidence: { campaigns?: { ref: string; name: string }[]; budget?: { projection?: { reliable?: boolean; projected_incremental_headroom?: number | null } } } | null
}
interface Existing { id: string; status: ImplementationStatus; implementation_mode: ImplementationMode; linked_task_id: string | null; budget_reserved_dkk?: string | number; inputs?: ImplementationInputs; execution?: ExecutionLedger; compiled?: CompiledImplementation; updated_at?: string }

export type ClientPlatform = { targetLabel: string; actionLabel: string; before: string; after: string; incrementalDkk: number }
export type ClientPreview = Omit<CompiledImplementation, 'platform'> & { platform: ClientPlatform | null }
export interface PickerTarget { id: string; type: 'campaign' | 'adset'; label: string; status: string; dailyBudgetDkk: number | null; suggested: boolean }

export type PrepareOutcome =
  | { ok: true; alreadyStarted: false; preview: ClientPreview; targets: PickerTarget[]; defaults: { ownerUserId: string; dueDate: string } }
  | { ok: true; alreadyStarted: true; status: ImplementationStatus; mode: ImplementationMode }
  | { ok: false; error: string }

export type ConfirmOutcome =
  | { ok: true; duplicate: boolean; status: ImplementationStatus; message: string; blockers?: Blocker[] }
  | { ok: false; error: string; needsInput?: InputRequirement[] }

/** Test seam. Production leaves it empty and everything is resolved from the environment. */
export interface Injected { capabilities?: Capability[]; deps?: Partial<RunnerDeps> }

const copenhagenDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

function parseInputs(raw: unknown): { ok: true; inputs: ImplementationInputs } | { ok: false; error: string } {
  const parsed = ImplementationInputsSchema.safeParse(raw ?? {})
  return parsed.success ? { ok: true, inputs: parsed.data } : { ok: false, error: 'Some of the details sent were not valid.' }
}

let capabilityCache: { at: number; caps: Capability[] } | null = null
async function loadCapabilities(db: Db, injected?: Injected): Promise<Capability[]> {
  if (injected?.capabilities) return injected.capabilities
  if (capabilityCache && Date.now() - capabilityCache.at < 5 * 60_000) return capabilityCache.caps
  const scopes = await db.from('google_oauth_tokens').select('scopes')
  const googleScopes = [...new Set(((scopes.data ?? []) as { scopes: string[] | null }[]).flatMap(r => r.scopes ?? []))]
  const { loadCapabilities: discover } = await import('../autonomous/ports')
  capabilityCache = { at: Date.now(), caps: await discover(googleScopes) }
  return capabilityCache.caps
}

async function loadContext(db: Db, runId: string, index: number, inputs: ImplementationInputs, now: Date, injected?: Injected) {
  if (!Number.isInteger(index) || index < 0 || index > 2 || !/^[0-9a-f-]{36}$/i.test(runId)) return { ok: false as const, error: 'That recommendation does not exist.' }
  const [run, latest, existing] = await Promise.all([
    db.from('marketing_paid_strategy_runs').select('id,status,generated_at,recommendations,evidence').eq('id', runId).maybeSingle(),
    db.from('marketing_paid_strategy_runs').select('id').eq('status', 'completed').order('generated_at', { ascending: false }).limit(1).maybeSingle(),
    db.from(TABLE).select('id,status,implementation_mode,linked_task_id,budget_reserved_dkk,inputs,execution,compiled,updated_at').eq('strategy_run_id', runId).eq('recommendation_index', index).maybeSingle(),
  ])
  if (run.error || latest.error || existing.error) return { ok: false as const, error: 'Paid Strategy storage is unavailable.' }
  const row = run.data as RunRow | null
  const recommendation = row?.recommendations?.[index]
  if (!row || row.status !== 'completed' || !recommendation) return { ok: false as const, error: 'That recommendation does not exist.' }
  if ((latest.data as { id: string } | null)?.id !== row.id) return { ok: false as const, error: 'Superseded by a newer strategy. Only the latest strategy can be implemented.' }

  const [campaignRows, adSetRows, accountRows, reserved] = await Promise.all([
    db.from('meta_ad_campaigns').select('id,name,status,ad_account_id,daily_budget').order('id'),
    db.from('meta_ad_sets').select('id,campaign_id,name,status,daily_budget').order('id'),
    db.from('meta_ad_accounts').select('id,currency'),
    db.rpc('paid_strategy_reserved_dkk', { p_exclude: (existing.data as Existing | null)?.id ?? null }),
  ])
  if (campaignRows.error || adSetRows.error || accountRows.error || reserved.error) return { ok: false as const, error: 'Synced Meta data is unavailable.' }
  const currency = new Map(((accountRows.data ?? []) as { id: string; currency: string }[]).map(a => [a.id, a.currency]))
  const campaigns: SyncedCampaign[] = ((campaignRows.data ?? []) as Omit<SyncedCampaign, 'currency'>[]).map(c => ({ ...c, currency: currency.get(c.ad_account_id) ?? '' }))
  const projection = row.evidence?.budget?.projection
  const compileInput: CompileInput = {
    recommendation, runGeneratedAt: new Date(row.generated_at).toISOString(), evidenceCampaigns: row.evidence?.campaigns ?? [],
    projectedHeadroomDkk: typeof projection?.projected_incremental_headroom === 'number' ? projection.projected_incremental_headroom : null,
    headroomReliable: projection?.reliable === true, reservedByOthersDkk: Number(reserved.data ?? 0) || 0,
    campaigns, adSets: (adSetRows.data ?? []) as SyncedAdSet[], configuredMetaAdAccountId: process.env.META_AD_ACCOUNT_ID || undefined,
    capabilities: await loadCapabilities(db, injected), inputs, now,
  }
  return { ok: true as const, run: row, recommendation, existing: existing.data as Existing | null, compileInput }
}

/** What the browser may see: no execution plan, no platform IDs. */
export function toClientPreview(c: CompiledImplementation): ClientPreview {
  return { ...c, platform: c.platform ? { targetLabel: c.platform.targetLabel, actionLabel: c.platform.actionLabel, before: c.platform.before, after: c.platform.after, incrementalDkk: c.platform.incrementalDkk } : null }
}

function pickerTargets(input: CompileInput, referencedNames: Set<string>): PickerTarget[] {
  const account = input.configuredMetaAdAccountId
  const campaigns = input.campaigns.filter(c => account && c.ad_account_id === account && c.status !== 'DELETED' && c.status !== 'ARCHIVED')
  return [
    ...campaigns.map(c => ({ id: c.id, type: 'campaign' as const, label: c.name, status: c.status, dailyBudgetDkk: toMajor(c.daily_budget), suggested: referencedNames.has(c.name) })),
    ...input.adSets.filter(s => campaigns.some(c => c.id === s.campaign_id)).map(s => {
      const parent = campaigns.find(c => c.id === s.campaign_id)!
      return { id: s.id, type: 'adset' as const, label: `${s.name} (in ${parent.name})`, status: s.status, dailyBudgetDkk: toMajor(s.daily_budget), suggested: false }
    }),
  ]
}

async function savePreparation(db: Db, actorId: string, runId: string, index: number, rec: StoredRecommendation, inputs: ImplementationInputs, compiled: CompiledImplementation, existing: Existing | null) {
  const status: ImplementationStatus = compiled.mode === 'needs_input' ? 'needs_input' : 'prepared'
  const now = new Date().toISOString()
  const values = { implementation_mode: compiled.mode, status, inputs, compiled, recommendation_snapshot: rec, prepared_by_user_id: actorId, prepared_at: now, updated_at: now }
  if (!existing) {
    const inserted = await db.from(TABLE).insert({ strategy_run_id: runId, recommendation_index: index, ...values }).select('id').single()
    if (!inserted.error && inserted.data) return (inserted.data as { id: string }).id
  }
  const updated = await db.from(TABLE).update(values).eq('strategy_run_id', runId).eq('recommendation_index', index).in('status', REPREPARABLE).select('id').maybeSingle()
  return (updated.data as { id: string } | null)?.id ?? null
}

export async function prepareImplementation(db: Db, actorId: string, runId: string, index: number, rawInputs: unknown, now = new Date(), injected?: Injected): Promise<PrepareOutcome> {
  const parsed = parseInputs(rawInputs)
  if (!parsed.ok) return parsed
  const ctx = await loadContext(db, runId, index, parsed.inputs, now, injected)
  if (!ctx.ok) return ctx
  if (ctx.existing && !REPREPARABLE.includes(ctx.existing.status)) return { ok: true, alreadyStarted: true, status: ctx.existing.status, mode: ctx.existing.implementation_mode }
  const compiled = compileImplementation(ctx.compileInput, index)
  const id = await savePreparation(db, actorId, runId, index, ctx.recommendation, parsed.inputs, compiled, ctx.existing)
  if (!id) return { ok: false, error: 'This recommendation was just started by someone else. Reload to see its state.' }
  await recordImplementationAudit(db, actorId, 'prepared', id, { strategy_run_id: runId, recommendation_index: index, mode: compiled.mode, intended_mode: compiled.intendedMode, requested_budget_dkk: compiled.budget.requestedDkk, missing: compiled.missing.map(m => m.key), expected_blockers: compiled.expectedBlockers.map(b => b.code) })
  return {
    ok: true, alreadyStarted: false, preview: toClientPreview(compiled),
    targets: compiled.intendedMode === 'platform_action' ? pickerTargets(ctx.compileInput, new Set(compiled.referencedCampaigns.map(r => r.name))) : [],
    defaults: { ownerUserId: actorId, dueDate: copenhagenDate(addDays(now, DEFAULT_DUE_DAYS)) },
  }
}

const REFUSALS: Record<string, string> = {
  superseded: 'Superseded by a newer strategy. Only the latest strategy can be implemented.',
  not_prepared: 'This recommendation has not been prepared yet. Reopen it and try again.',
  headroom_unreliable: 'There is no reliable spend headroom this month, so no extra paid budget can be approved.',
  actor_inactive: 'Your account is not active.', invalid_mode: 'This recommendation cannot be implemented yet.', invalid_budget: 'The budget amount is not valid.',
}

async function runnerDeps(db: Db, actorId: string, implementationId: string, caps: Capability[], injected?: Injected): Promise<RunnerDeps> {
  const o: Partial<RunnerDeps> = injected?.deps ?? {}
  // Only the network edges (Meta, the model, the website) can be overridden. Creative drafts and the handoff task always go through the database.
  const ports = o.meta && o.fetchSiteHtml && o.readPixel && o.executePlan ? null : await import('../autonomous/ports')
  const ai = o.generateCreative ? null : await import('@/lib/ai/paid-strategy-creative')
  const { normalizeTaskCreateInput, insertTaskWithAudit } = await import('@/lib/domain/task-creation')
  return {
    now: o.now ?? (() => new Date()), capabilities: caps, writers: o.writers ?? [],
    meta: o.meta ?? ports!.metaPort, fetchSiteHtml: o.fetchSiteHtml ?? ports!.fetchSiteHtml, readPixel: o.readPixel ?? ports!.readPixel, executePlan: o.executePlan ?? ports!.executePlanViaTrustedExecutor,
    generateCreative: o.generateCreative ?? ((brief, sources) => ai!.generateCreativePackage(brief, sources)),
    createHandoffTask: async (h, owner, due) => {
      const normalized = normalizeTaskCreateInput({ title: h.title, description: h.description, owner_user_id: owner, priority: 2, due_at: new Date(`${due}T12:00:00Z`).toISOString() }, actorId)
      if (!normalized.ok) return null
      const created = await insertTaskWithAudit(db, actorId, normalized.data)
      if (created.id) await db.from(TABLE).update({ linked_task_id: created.id }).eq('id', implementationId)
      return created.id ?? null
    },
    saveCreativeDraft: async d => {
      const saved = await db.from('marketing_paid_strategy_creative_drafts').upsert({
        implementation_id: implementationId, title: d.title.slice(0, 200), campaign_name: d.campaignName.slice(0, 200), angle: d.pkg.offer_angle, primary_text: d.pkg.primary_text, headline: d.pkg.headline, description: d.pkg.description,
        cta: d.pkg.cta, hook_options: d.pkg.hook_options, script: d.pkg.video_script, shot_list: d.pkg.shot_list, test_design: d.testDesign, asset_state: d.assetState, approval_state: 'pending_review', updated_at: new Date().toISOString(),
      }, { onConflict: 'implementation_id' })
      if (saved.error) throw new Error('The creative draft could not be saved.')
    },
  }
}

export async function confirmImplementation(db: Db, actorId: string, runId: string, index: number, rawInputs: unknown, now = new Date(), injected?: Injected): Promise<ConfirmOutcome> {
  const parsed = parseInputs(rawInputs)
  if (!parsed.ok) return parsed
  const inputs = parsed.inputs
  const ownerUserId = inputs.ownerUserId ?? actorId
  const dueDate = inputs.dueDate ?? copenhagenDate(addDays(now, DEFAULT_DUE_DAYS))
  if (dueDate < copenhagenDate(now) || dueDate > copenhagenDate(addDays(now, 366))) return { ok: false, error: 'Choose a due date from today up to a year ahead.' }
  const owner = await db.from('app_users').select('id').eq('id', ownerUserId).eq('active', true).maybeSingle()
  if (owner.error || !owner.data) return { ok: false, error: 'The chosen owner is not an active user.' }

  const ctx = await loadContext(db, runId, index, inputs, now, injected)
  if (!ctx.ok) return ctx
  if (ctx.existing?.status === 'rejected') return { ok: false, error: 'This recommendation was rejected. It cannot be implemented.' }
  if (ctx.existing && !REPREPARABLE.includes(ctx.existing.status)) return { ok: true, duplicate: true, status: ctx.existing.status, message: 'This recommendation is already being implemented. Nothing was duplicated.' }
  const compiled = compileImplementation(ctx.compileInput, index)
  await savePreparation(db, actorId, runId, index, ctx.recommendation, inputs, compiled, ctx.existing)
  if (compiled.mode === 'needs_input') {
    return { ok: false, error: compiled.expectedBlockers[0]?.message ?? 'More information is needed before this can be implemented.', needsInput: compiled.missing.length ? compiled.missing : [{ key: 'platform_target', label: compiled.expectedBlockers[0]?.unblock ?? 'More details' }] }
  }

  // Atomic admission: latest-run check, exactly-once, and the shared budget reservation happen in one transaction.
  const budget = compiled.budget.requestedDkk
  const claim = await db.rpc('approve_paid_strategy_implementation', {
    p_run_id: runId, p_index: index, p_actor: actorId, p_mode: compiled.mode, p_budget: budget, p_inputs: { ...inputs, ownerUserId, dueDate }, p_compiled: compiled,
  })
  const outcome = (claim.data ?? null) as { result?: string; id?: string; status?: ImplementationStatus; available?: number } | null
  if (claim.error || !outcome?.result) return { ok: false, error: 'The implementation could not be started. Nothing was changed.' }
  if (outcome.result === 'already_claimed' && outcome.status === 'rejected') return { ok: false, error: 'This recommendation was rejected. It cannot be implemented.' }
  if (outcome.result === 'already_claimed') return { ok: true, duplicate: true, status: outcome.status ?? 'approved', message: 'This recommendation is already being implemented. Nothing was duplicated.' }
  if (outcome.result === 'exceeds_headroom') return { ok: false, error: `That would exceed the shared spend headroom. ${new Intl.NumberFormat('en-GB').format(outcome.available ?? 0)} DKK is still available.`, needsInput: [{ key: 'reserve_budget', label: 'Extra budget' }] }
  if (outcome.result !== 'claimed' || !outcome.id) return { ok: false, error: REFUSALS[outcome.result ?? ''] ?? 'The implementation could not be started. Nothing was changed.' }

  const deps = await runnerDeps(db, actorId, outcome.id, ctx.compileInput.capabilities, injected)
  return runClaimed(db, deps, { id: outcome.id, actorId, runId, index, compiled, recommendation: ctx.recommendation, ownerUserId, dueDate, budgetReservedDkk: budget }, ctx.compileInput)
}

/** Continue after a blocker is cleared (access granted, a decision supplied) or after an interruption. Never repeats a finished step. */
export async function resumeImplementation(db: Db, actorId: string, runId: string, index: number, rawInputs: unknown, now = new Date(), injected?: Injected): Promise<ConfirmOutcome> {
  const parsed = parseInputs(rawInputs)
  if (!parsed.ok) return parsed
  const existing = await db.from(TABLE).select('id,status,implementation_mode,budget_reserved_dkk,inputs,execution,compiled,updated_at').eq('strategy_run_id', runId).eq('recommendation_index', index).maybeSingle()
  const row = existing.data as Existing | null
  if (existing.error || !row) return { ok: false, error: 'Nothing has been started for this recommendation.' }
  const stale = IN_FLIGHT_STATUSES.includes(row.status) && now.getTime() - Date.parse(String(row.updated_at)) > STALE_MS
  if (!RESUMABLE_STATUSES.includes(row.status) && !stale) return { ok: true, duplicate: true, status: row.status, message: 'This is already being worked on. Nothing was started twice.' }
  if (row.implementation_mode === 'platform_action') return { ok: false, error: 'A change to an existing campaign is never retried automatically. Check Meta, then cancel and prepare it again.' }

  const inputs: ImplementationInputs = { ...(row.inputs ?? {}), ...parsed.inputs }
  const ctx = await loadContext(db, runId, index, inputs, now, injected)
  if (!ctx.ok) return ctx
  // Atomic: only one resume can take it from this exact status.
  const taken = await db.from(TABLE).update({ status: 'planning', inputs, updated_at: now.toISOString() }).eq('id', row.id).eq('status', row.status).select('id').maybeSingle()
  if (taken.error || !taken.data) return { ok: true, duplicate: true, status: row.status, message: 'This is already being worked on. Nothing was started twice.' }
  await recordImplementationAudit(db, actorId, 'resumed', row.id, { strategy_run_id: runId, recommendation_index: index, from_status: row.status })

  const compiled = compileImplementation({ ...ctx.compileInput, inputs }, index)
  const reserved = Number(row.budget_reserved_dkk) || 0
  const deps = await runnerDeps(db, actorId, row.id, ctx.compileInput.capabilities, injected)
  const ownerUserId = (row.inputs as { ownerUserId?: string } | undefined)?.ownerUserId ?? actorId
  const dueDate = (row.inputs as { dueDate?: string } | undefined)?.dueDate ?? copenhagenDate(addDays(now, DEFAULT_DUE_DAYS))
  return runClaimed(db, deps, { id: row.id, actorId, runId, index, compiled: { ...compiled, mode: row.implementation_mode }, recommendation: ctx.recommendation, ownerUserId, dueDate, budgetReservedDkk: reserved, ledger: row.execution && row.execution.version ? row.execution : undefined }, ctx.compileInput)
}

/** Switch on a verified, paused structure. A separate approval from the one that created it. */
export async function activateImplementation(db: Db, actorId: string, runId: string, index: number, now = new Date(), injected?: Injected): Promise<ConfirmOutcome> {
  const ctx = await loadContext(db, runId, index, {}, now, injected)
  if (!ctx.ok) return ctx
  const row = ctx.existing
  if (!row) return { ok: false, error: 'Nothing has been prepared for this recommendation.' }
  if (row.status !== 'ready_to_activate') return row.status === 'in_motion' || row.status === 'executing' ? { ok: true, duplicate: true, status: row.status, message: 'This is already being activated or is live. Nothing was switched on twice.' } : { ok: false, error: 'There is nothing ready to activate.' }
  const taken = await db.from(TABLE).update({ status: 'executing', updated_at: now.toISOString() }).eq('id', row.id).eq('status', 'ready_to_activate').select('id').maybeSingle()
  if (taken.error || !taken.data) return { ok: true, duplicate: true, status: 'executing', message: 'This is already being activated. Nothing was switched on twice.' }
  const compiled = row.compiled as CompiledImplementation
  const deps = await runnerDeps(db, actorId, row.id, ctx.compileInput.capabilities, injected)
  return activateClaimed(db, deps, { id: row.id, mode: row.implementation_mode, ledger: row.execution!, durationDays: compiled?.spend?.durationDays ?? null, configuredAccountId: ctx.compileInput.configuredMetaAdAccountId ?? '', actorId, runId, index })
}

export async function cancelImplementation(db: Db, actorId: string, runId: string, index: number): Promise<ConfirmOutcome> {
  const existing = await db.from(TABLE).select('id,status,execution').eq('strategy_run_id', runId).eq('recommendation_index', index).maybeSingle()
  const row = existing.data as { id: string; status: ImplementationStatus; execution?: ExecutionLedger } | null
  if (existing.error || !row) return { ok: false, error: 'Nothing has been started for this recommendation.' }
  if (row.status === 'rejected') return { ok: true, duplicate: true, status: 'rejected', message: 'Already rejected. Nothing is reserved.' }
  if (!CANCELLABLE_STATUSES.includes(row.status)) return row.status === 'cancelled' ? { ok: true, duplicate: true, status: 'cancelled', message: 'Already cancelled.' } : { ok: false, error: 'This is being worked on or is live and cannot be cancelled from here.' }
  const done = await db.from(TABLE).update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', row.id).eq('status', row.status).select('id').maybeSingle()
  if (done.error || !done.data) return { ok: true, duplicate: true, status: row.status, message: 'Its state changed just now. Reload to see it.' }
  const created = (row.execution?.evidence?.created ?? null) as Record<string, unknown> | null
  await recordImplementationAudit(db, actorId, 'cancelled', row.id, { strategy_run_id: runId, recommendation_index: index, from_status: row.status, meta_objects_left_paused: !!created })
  return { ok: true, duplicate: false, status: 'cancelled', message: created ? 'Cancelled. The budget is released. The paused objects already created in Meta stay paused and cannot spend.' : 'Cancelled. The budget is released.' }
}

export type RejectOutcome =
  | { ok: true; duplicate: boolean; status: 'rejected'; message: string; budgetReleasedDkk: number; metaObjectsExist: boolean }
  | { ok: false; error: string }

const REJECT_REFUSALS: Record<string, string> = {
  superseded: 'Superseded by a newer strategy. Only the latest strategy can be rejected.',
  not_found: 'That recommendation does not exist.',
  actor_inactive: 'Your account is not active.',
  reason_too_long: `The reason is too long (${REJECTION_REASON_MAX} characters at most).`,
  in_flight: 'Kockpit is working on this right now. Wait for it to finish or stop, then reject it.',
  live: 'This is live or finished. Rejecting is only for ideas that are not running. Stopping something live is a separate step.',
  conflict: 'Its state changed just now. Reload to see it.',
}

/** Free text from a person: strip control characters and surrounding space. An empty reason is valid. */
export const cleanRejectionReason = (raw: unknown): string | null => {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim() : ''
  return text || null
}

/**
 * A human decision that this recommendation should not be pursued. One atomic database function does the whole thing:
 * latest-run check, the row (created if none exists), the reservation release and the audit event. Repeating it is a no-op.
 * Nothing here calls Meta: objects that already exist stay paused and cannot spend.
 */
export async function rejectImplementation(db: Db, actorId: string, runId: string, index: number, rawReason?: unknown): Promise<RejectOutcome> {
  if (!Number.isInteger(index) || index < 0 || index > 2 || !/^[0-9a-f-]{36}$/i.test(runId)) return { ok: false, error: 'That recommendation does not exist.' }
  const reason = cleanRejectionReason(rawReason)
  if (reason && reason.length > REJECTION_REASON_MAX) return { ok: false, error: REJECT_REFUSALS.reason_too_long }
  const res = await db.rpc('reject_paid_strategy_implementation', { p_run_id: runId, p_index: index, p_actor: actorId, p_reason: reason })
  const out = (res.data ?? null) as { result?: string; released?: number | string; meta_objects_existed?: boolean } | null
  if (res.error || !out?.result) return { ok: false, error: 'The rejection could not be saved. Nothing was changed.' }
  const paused = out.meta_objects_existed === true
  const note = paused ? ' The paused objects already created in Meta remain and cannot spend.' : ''
  if (out.result === 'already_rejected') return { ok: true, duplicate: true, status: 'rejected', message: `Already rejected.${note}`, budgetReleasedDkk: 0, metaObjectsExist: paused }
  if (out.result !== 'rejected') return { ok: false, error: REJECT_REFUSALS[out.result] ?? 'The rejection could not be saved. Nothing was changed.' }
  const released = Number(out.released) || 0
  return { ok: true, duplicate: false, status: 'rejected', message: `Rejected.${released > 0 ? ' The reserved budget is released.' : ''}${note}`, budgetReleasedDkk: released, metaObjectsExist: paused }
}
