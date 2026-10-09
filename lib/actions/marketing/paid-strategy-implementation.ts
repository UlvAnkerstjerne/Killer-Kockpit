'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { loadImplementationViews } from '@/lib/marketing/paid-strategy/implementation/read'
import type { ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'
import { activateImplementation, cancelImplementation, confirmImplementation, prepareImplementation, resumeImplementation, type ConfirmOutcome, type PrepareOutcome } from '@/lib/marketing/paid-strategy/implementation/service'

export type PrepareResult = PrepareOutcome & { canConfirm?: boolean; owners?: { id: string; name: string }[] }

type Authorized = { ok: true; userId: string; canApprove: boolean } | { ok: false; error: string }

/** Every call authorizes on the server. The browser decides nothing: it only shows or hides buttons. */
async function authorize(permission: 'paid_manage' | 'paid_approve'): Promise<Authorized> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessMarketing(user.role, user.marketing_access)) return { ok: false, error: 'No marketing access' }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, permission)) return { ok: false, error: `${permission} permission required` }
  return { ok: true, userId: user.id, canApprove: hasMarketingPermission(user.role, permissions, 'paid_approve') }
}

/** Compiles a preview. Has no side effect on Meta, tasks or budget. Requires paid_manage. */
export async function prepareStrategyImplementation(runId: string, index: number, inputs?: unknown): Promise<PrepareResult> {
  const auth = await authorize('paid_manage')
  if (!auth.ok) return auth
  const db = createServiceClient()
  const result = await prepareImplementation(db, auth.userId, String(runId), Number(index), inputs)
  if (!result.ok || result.alreadyStarted) return result
  let owners: { id: string; name: string }[] | undefined
  if (auth.canApprove) {
    const people = await db.from('app_users').select('id,display_name').eq('active', true).order('display_name')
    owners = ((people.data ?? []) as { id: string; display_name: string | null }[]).map(p => ({ id: p.id, name: p.display_name ?? 'Unnamed user' }))
  }
  return { ...result, canConfirm: auth.canApprove, owners }
}

/** The only action with side effects. Requires paid_approve; budget, exactly-once and recency are enforced in the database. */
export async function confirmStrategyImplementation(runId: string, index: number, inputs?: unknown): Promise<ConfirmOutcome> {
  const auth = await authorize('paid_approve')
  if (!auth.ok) return auth
  const result = await confirmImplementation(createServiceClient(), auth.userId, String(runId), Number(index), inputs)
  revalidatePath('/marketing/brain')
  return result
}

/** Continue after a blocker is cleared or an interruption. Never repeats a finished step. Requires paid_approve. */
export async function resumeStrategyImplementation(runId: string, index: number, inputs?: unknown): Promise<ConfirmOutcome> {
  const auth = await authorize('paid_approve')
  if (!auth.ok) return auth
  const result = await resumeImplementation(createServiceClient(), auth.userId, String(runId), Number(index), inputs)
  revalidatePath('/marketing/brain')
  return result
}

/** Switch on the verified paused structure. A separate approval from creation. Requires paid_approve. */
export async function activateStrategyImplementation(runId: string, index: number): Promise<ConfirmOutcome> {
  const auth = await authorize('paid_approve')
  if (!auth.ok) return auth
  const result = await activateImplementation(createServiceClient(), auth.userId, String(runId), Number(index))
  revalidatePath('/marketing/brain')
  return result
}

/** Release the reservation. Objects already created stay paused in Meta. Requires paid_approve. */
export async function cancelStrategyImplementation(runId: string, index: number): Promise<ConfirmOutcome> {
  const auth = await authorize('paid_approve')
  if (!auth.ok) return auth
  const result = await cancelImplementation(createServiceClient(), auth.userId, String(runId), Number(index))
  revalidatePath('/marketing/brain')
  return result
}

export interface StrategyImplementationData {
  /** Whether the Approve & implement button is offered. The server re-checks on every call. */
  canApprove: boolean
  views: ImplementationView[]
  error: string | null
}

/** Implementation states for the visible runs. Reads only; renders nothing it is not allowed to show. */
export async function getStrategyImplementations(): Promise<StrategyImplementationData> {
  const none: StrategyImplementationData = { canApprove: false, views: [], error: null }
  const auth = await authorize('paid_manage')
  if (!auth.ok) return none
  const userDb = await createClient()
  const runs = await userDb.from('marketing_paid_strategy_runs').select('id').eq('status', 'completed').order('generated_at', { ascending: false }).limit(6)
  if (runs.error) return { ...none, canApprove: auth.canApprove, error: 'Implementation state is unavailable. Confirm the migration is activated.' }
  const loaded = await loadImplementationViews(userDb, ((runs.data ?? []) as { id: string }[]).map(r => r.id))
  return { canApprove: auth.canApprove, views: loaded.views, error: loaded.error ? 'Implementation state is unavailable. Confirm the migration is activated.' : null }
}
