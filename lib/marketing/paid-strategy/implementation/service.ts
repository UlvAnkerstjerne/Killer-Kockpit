/**
 * Paid Strategy implementation service. Server-only; the server actions authorize first and call this.
 *
 *   prepare  compile a preview from the stored recommendation. Writes one 'prepared' / 'needs_input' row. Never a side effect.
 *   confirm  re-compile from scratch (nothing the browser sent about plans or IDs is trusted), claim atomically in the
 *            database (budget reservation + exactly-once), then perform the one side effect.
 *
 * The AI is not involved anywhere in this file.
 */

import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { recordImplementationAudit } from './audit'
import { compileImplementation, toMajor, type CompileInput, type StoredRecommendation, type SyncedAdSet, type SyncedCampaign } from './compile'
import { executeClaimedImplementation } from './execute'
import {
  ImplementationInputsSchema, type CompiledImplementation, type ImplementationInputs, type ImplementationMode,
  type ImplementationStatus, type InputRequirement,
} from './types'

type Db = ReturnType<typeof createServiceClient>
const TABLE = 'marketing_paid_strategy_implementations'
const REPREPARABLE: ImplementationStatus[] = ['prepared', 'needs_input', 'failed']
const DEFAULT_DUE_DAYS = 7

interface RunRow {
  id: string; status: string; generated_at: string
  recommendations: StoredRecommendation[]
  evidence: { campaigns?: { ref: string; name: string }[]; budget?: { projection?: { reliable?: boolean; projected_incremental_headroom?: number | null } } } | null
}
interface Existing { id: string; status: ImplementationStatus; implementation_mode: ImplementationMode; linked_task_id: string | null }

export type ClientPlatform = { targetLabel: string; actionLabel: string; before: string; after: string; incrementalDkk: number }
export type ClientPreview = Omit<CompiledImplementation, 'platform' | 'package'> & {
  platform: ClientPlatform | null
  package: (Omit<NonNullable<CompiledImplementation['package']>, 'source_campaign_to_mirror'> & { source_campaign_to_mirror: string | null }) | null
}
export interface PickerTarget { id: string; type: 'campaign' | 'adset'; label: string; status: string; dailyBudgetDkk: number | null; suggested: boolean }

export type PrepareOutcome =
  | { ok: true; alreadyStarted: false; preview: ClientPreview; targets: PickerTarget[]; defaults: { ownerUserId: string; dueDate: string } }
  | { ok: true; alreadyStarted: true; status: ImplementationStatus; mode: ImplementationMode; linkedTaskId: string | null }
  | { ok: false; error: string }

export type ConfirmOutcome =
  | { ok: true; duplicate: boolean; status: ImplementationStatus; linkedTaskId?: string | null; message: string }
  | { ok: false; error: string; needsInput?: InputRequirement[] }

const copenhagenDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

function parseInputs(raw: unknown): { ok: true; inputs: ImplementationInputs } | { ok: false; error: string } {
  const parsed = ImplementationInputsSchema.safeParse(raw ?? {})
  return parsed.success ? { ok: true, inputs: parsed.data } : { ok: false, error: 'Some of the details sent were not valid.' }
}

async function loadContext(db: Db, runId: string, index: number, inputs: ImplementationInputs, now: Date) {
  if (!Number.isInteger(index) || index < 0 || index > 2 || !/^[0-9a-f-]{36}$/i.test(runId)) return { ok: false as const, error: 'That recommendation does not exist.' }
  const [run, latest, existing] = await Promise.all([
    db.from('marketing_paid_strategy_runs').select('id,status,generated_at,recommendations,evidence').eq('id', runId).maybeSingle(),
    db.from('marketing_paid_strategy_runs').select('id').eq('status', 'completed').order('generated_at', { ascending: false }).limit(1).maybeSingle(),
    db.from(TABLE).select('id,status,implementation_mode,linked_task_id').eq('strategy_run_id', runId).eq('recommendation_index', index).maybeSingle(),
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
    headroomReliable: projection?.reliable === true,
    reservedByOthersDkk: Number(reserved.data ?? 0) || 0,
    campaigns, adSets: (adSetRows.data ?? []) as SyncedAdSet[],
    configuredMetaAdAccountId: process.env.META_AD_ACCOUNT_ID || undefined,
    inputs, now,
  }
  return { ok: true as const, run: row, recommendation, existing: existing.data as Existing | null, compileInput }
}

/** What the browser may see: no execution plan, no platform IDs. */
export function toClientPreview(c: CompiledImplementation): ClientPreview {
  return {
    ...c,
    platform: c.platform ? { targetLabel: c.platform.targetLabel, actionLabel: c.platform.actionLabel, before: c.platform.before, after: c.platform.after, incrementalDkk: c.platform.incrementalDkk } : null,
    package: c.package ? { ...c.package, source_campaign_to_mirror: c.package.source_campaign_to_mirror?.name ?? null } : null,
  }
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

/** Persist the preparation. Never touches a row that has already been approved. */
async function savePreparation(db: Db, actorId: string, runId: string, index: number, rec: StoredRecommendation, inputs: ImplementationInputs, compiled: CompiledImplementation, existing: Existing | null) {
  const status: ImplementationStatus = compiled.mode === 'needs_input' ? 'needs_input' : 'prepared'
  const values = { implementation_mode: compiled.mode, status, inputs, compiled, recommendation_snapshot: rec, prepared_by_user_id: actorId, prepared_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  if (!existing) {
    const inserted = await db.from(TABLE).insert({ strategy_run_id: runId, recommendation_index: index, ...values }).select('id').single()
    if (!inserted.error && inserted.data) return (inserted.data as { id: string }).id
    // A concurrent preparation won the unique constraint: fall through and update that row if it is still preparable.
  }
  const updated = await db.from(TABLE).update(values).eq('strategy_run_id', runId).eq('recommendation_index', index).in('status', REPREPARABLE).select('id').maybeSingle()
  return (updated.data as { id: string } | null)?.id ?? null
}

export async function prepareImplementation(db: Db, actorId: string, runId: string, index: number, rawInputs: unknown, now = new Date()): Promise<PrepareOutcome> {
  const parsed = parseInputs(rawInputs)
  if (!parsed.ok) return parsed
  const ctx = await loadContext(db, runId, index, parsed.inputs, now)
  if (!ctx.ok) return ctx
  if (ctx.existing && !REPREPARABLE.includes(ctx.existing.status)) {
    return { ok: true, alreadyStarted: true, status: ctx.existing.status, mode: ctx.existing.implementation_mode, linkedTaskId: ctx.existing.linked_task_id }
  }
  const compiled = compileImplementation(ctx.compileInput, index)
  const id = await savePreparation(db, actorId, runId, index, ctx.recommendation, parsed.inputs, compiled, ctx.existing)
  if (!id) return { ok: false, error: 'This recommendation was just started by someone else. Reload to see its state.' }
  await recordImplementationAudit(db, actorId, 'prepared', id, { strategy_run_id: runId, recommendation_index: index, mode: compiled.mode, intended_mode: compiled.intendedMode, requested_budget_dkk: compiled.budget.requestedDkk, missing: compiled.missing.map(m => m.key) })
  const referenced = new Set(compiled.referencedCampaigns.map(r => r.name))
  return {
    ok: true, alreadyStarted: false, preview: toClientPreview(compiled),
    targets: compiled.intendedMode === 'platform_action' ? pickerTargets(ctx.compileInput, referenced) : [],
    defaults: { ownerUserId: actorId, dueDate: copenhagenDate(addDays(now, DEFAULT_DUE_DAYS)) },
  }
}

const REFUSALS: Record<string, string> = {
  superseded: 'Superseded by a newer strategy. Only the latest strategy can be implemented.',
  not_prepared: 'This recommendation has not been prepared yet. Reopen it and try again.',
  headroom_unreliable: 'There is no reliable spend headroom this month, so no extra paid budget can be approved.',
  actor_inactive: 'Your account is not active.',
  invalid_mode: 'This recommendation cannot be implemented yet.',
  invalid_budget: 'The budget amount is not valid.',
}

export async function confirmImplementation(db: Db, actorId: string, runId: string, index: number, rawInputs: unknown, now = new Date()): Promise<ConfirmOutcome> {
  const parsed = parseInputs(rawInputs)
  if (!parsed.ok) return parsed
  const inputs = parsed.inputs

  const ownerUserId = inputs.ownerUserId ?? actorId
  const dueDate = inputs.dueDate ?? copenhagenDate(addDays(now, DEFAULT_DUE_DAYS))
  if (dueDate < copenhagenDate(now) || dueDate > copenhagenDate(addDays(now, 366))) return { ok: false, error: 'Choose a due date from today up to a year ahead.' }
  const owner = await db.from('app_users').select('id').eq('id', ownerUserId).eq('active', true).maybeSingle()
  if (owner.error || !owner.data) return { ok: false, error: 'The chosen owner is not an active user.' }

  const ctx = await loadContext(db, runId, index, inputs, now)
  if (!ctx.ok) return ctx
  if (ctx.existing && !REPREPARABLE.includes(ctx.existing.status)) {
    return { ok: true, duplicate: true, status: ctx.existing.status, linkedTaskId: ctx.existing.linked_task_id, message: 'This recommendation is already being implemented. Nothing was duplicated.' }
  }
  const compiled = compileImplementation(ctx.compileInput, index)
  if (compiled.mode === 'needs_input') {
    await savePreparation(db, actorId, runId, index, ctx.recommendation, inputs, compiled, ctx.existing)
    return { ok: false, error: 'More information is needed before this can be implemented.', needsInput: compiled.missing.length ? compiled.missing : [{ key: 'platform_target', label: compiled.needsPerson[0] ?? 'More details' }] }
  }
  await savePreparation(db, actorId, runId, index, ctx.recommendation, inputs, compiled, ctx.existing)

  // Atomic admission: latest-run check, exactly-once, and the shared budget reservation happen in one transaction.
  const budget = compiled.platform ? compiled.platform.incrementalDkk : compiled.budget.requestedDkk
  const claim = await db.rpc('approve_paid_strategy_implementation', {
    p_run_id: runId, p_index: index, p_actor: actorId, p_mode: compiled.mode, p_budget: budget,
    p_inputs: { ...inputs, ownerUserId, dueDate }, p_compiled: compiled,
  })
  const outcome = (claim.data ?? null) as { result?: string; id?: string; status?: ImplementationStatus; available?: number } | null
  if (claim.error || !outcome?.result) return { ok: false, error: 'The implementation could not be started. Nothing was changed.' }
  if (outcome.result === 'already_claimed') {
    return { ok: true, duplicate: true, status: outcome.status ?? 'approved', message: 'This recommendation is already being implemented. Nothing was duplicated.' }
  }
  if (outcome.result === 'exceeds_headroom') {
    return { ok: false, error: `That would exceed the shared spend headroom. ${new Intl.NumberFormat('en-GB').format(outcome.available ?? 0)} DKK is still available.`, needsInput: [{ key: 'reserve_budget', label: 'Extra budget' }] }
  }
  if (outcome.result !== 'claimed' || !outcome.id) return { ok: false, error: REFUSALS[outcome.result ?? ''] ?? 'The implementation could not be started. Nothing was changed.' }

  return executeClaimedImplementation(db, { id: outcome.id, actorId, runId, index, compiled, ownerUserId, dueDate, recommendation: ctx.recommendation, budgetReservedDkk: budget })
}
