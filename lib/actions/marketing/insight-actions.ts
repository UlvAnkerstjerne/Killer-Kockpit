'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { callInsightActionOptions } from '@/lib/ai/insight-actions'
import { getCurrentUser } from '@/lib/auth'
import { normalizeTaskCreateInput, insertTaskWithAudit } from '@/lib/domain/task-creation'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { getPaidStrategy } from '@/lib/actions/marketing/paid-strategy'
import { getStrategyImplementations } from '@/lib/actions/marketing/paid-strategy-implementation'
import { chooseAction } from '@/lib/marketing/insights/actions/choose'
import { implementRouteFor } from '@/lib/marketing/insights/actions/eligibility'
import { proposeActions } from '@/lib/marketing/insights/actions/propose'
import { createActionStore } from '@/lib/marketing/insights/actions/repo'
import type { ActionRow } from '@/lib/marketing/insights/actions/types'
import type { InsightRow, LinkRow } from '@/lib/marketing/insights/types'
import type { InsightView } from '@/lib/marketing/insights/view'

export type ProposeOutcome = { ok: true; actions: ActionRow[]; reused: boolean } | { ok: false; error: string }
export type ChooseOutcome = { ok: true; action: ActionRow } | { ok: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Marketing access + paid_manage, the same bar as reading insights. Always the first thing every action here does. */
async function authorize(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!canAccessMarketing(user.role, user.marketing_access)) return { ok: false, error: 'No marketing access' }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_manage')) return { ok: false, error: 'paid_manage permission required' }
  return { ok: true, userId: user.id }
}

/** The insight, read under the USER's own RLS: an id the user cannot see is simply not found, so a made-up id gets nothing. */
async function loadInsightForUser(insightId: string): Promise<InsightView | null> {
  const db = await createClient()
  const [insight, links] = await Promise.all([
    db.from('marketing_insights').select('*').eq('id', insightId).maybeSingle(),
    db.from('marketing_insight_links').select('insight_id,target_type,target_run_id,target_index,relation').eq('insight_id', insightId),
  ])
  if (insight.error || !insight.data || links.error) return null
  return { ...(insight.data as InsightRow), history: [], links: ((links.data ?? []) as Pick<LinkRow, 'target_type' | 'target_run_id' | 'target_index' | 'relation'>[]), actions: [] }
}

/**
 * Drafts 2-3 options for one insight. Called ONLY when a person clicks. It creates no task and runs nothing: it stores drafts so
 * the option later chosen is the text the server drafted. Existing drafts are reused unless a fresh draft is asked for.
 */
export async function proposeInsightActions(insightId: string, redraft = false): Promise<ProposeOutcome> {
  const auth = await authorize()
  if (!auth.ok) return auth
  if (typeof insightId !== 'string' || !UUID.test(insightId)) return { ok: false, error: 'Insight not found.' }
  const insight = await loadInsightForUser(insightId)
  if (!insight) return { ok: false, error: 'Insight not found.' }
  const [strategy, implementations] = await Promise.all([getPaidStrategy(), getStrategyImplementations()])
  const route = implementRouteFor(insight, strategy, implementations)
  try {
    return await proposeActions({ store: createActionStore(createServiceClient()), call: callInsightActionOptions, newId: randomUUID, now: () => new Date() },
      { insight, actorId: auth.userId, route, redraft: redraft === true })
  } catch (error) {
    console.error('[insight-actions] propose failed:', error instanceof Error ? error.message : 'unknown error')
    return { ok: false, error: 'Options could not be saved. Confirm the insights migration has been applied.' }
  }
}

/**
 * Chooses one drafted option. A manual option creates ONE task through the existing audited task creation; the Paid Strategy
 * option only records the choice, and the recommendation's own Approve & implement flow (with its permissions, preview and
 * confirmations) does the work. Nothing is executed here.
 */
export async function chooseInsightAction(actionId: string, input: { ownerUserId?: string; dueOn?: string } = {}): Promise<ChooseOutcome> {
  const auth = await authorize()
  if (!auth.ok) return auth
  if (typeof actionId !== 'string' || !UUID.test(actionId)) return { ok: false, error: 'That option no longer exists.' }
  const service = createServiceClient()
  const store = createActionStore(service)
  try {
    const found = await store.get(actionId)
    if (!found) return { ok: false, error: 'That option no longer exists.' }
    const insight = await loadInsightForUser(found.insight_id)
    if (!insight) return { ok: false, error: 'That option no longer exists.' }
    const result = await chooseAction({
      store,
      createTask: async ({ title, description, ownerUserId, dueAt }) => {
        const normalized = normalizeTaskCreateInput({ title, description, owner_user_id: ownerUserId, priority: 2, due_at: dueAt }, auth.userId)
        if (!normalized.ok) return null
        return (await insertTaskWithAudit(service, auth.userId, normalized.data)).id ?? null
      },
      isActiveUser: async id => !!(await service.from('app_users').select('id').eq('id', id).eq('active', true).maybeSingle()).data,
      routeStillValid: async (runId, index) => implementRouteFor(
        { links: [{ target_type: 'paid_strategy_recommendation', target_run_id: runId, target_index: index, relation: 'derived_from' }] },
        await getPaidStrategy(), await getStrategyImplementations()),
      now: () => new Date(),
    }, { actionId, actorId: auth.userId, insight, ownerUserId: input.ownerUserId, dueOn: input.dueOn })
    if (result.ok) { revalidatePath('/marketing/brain'); revalidatePath('/marketing'); revalidatePath('/tasks'); revalidatePath('/today') }
    return result
  } catch (error) {
    console.error('[insight-actions] choose failed:', error instanceof Error ? error.message : 'unknown error')
    return { ok: false, error: 'The choice could not be saved. Nothing was changed.' }
  }
}

/** People a manual action can be assigned to: active users with marketing access (and SUPER_ADMINs). */
export async function listInsightActionAssignees(): Promise<{ ok: true; people: { id: string; name: string }[] } | { ok: false; error: string }> {
  const auth = await authorize()
  if (!auth.ok) return auth
  const { data, error } = await createServiceClient().from('app_users').select('id,display_name,role,marketing_access').eq('active', true).order('display_name')
  if (error) return { ok: false, error: 'People could not be loaded.' }
  return { ok: true, people: ((data ?? []) as { id: string; display_name: string | null; role: string; marketing_access: boolean }[])
    .filter(p => p.marketing_access || p.role === 'SUPER_ADMIN').map(p => ({ id: p.id, name: p.display_name ?? 'Unnamed user' })) }
}
