import 'server-only'
import type { createClient, createServiceClient } from '@/lib/supabase/server'
import { effectiveStatus } from './state'
import type { ImplementationMode, ImplementationStatus, ImplementationView } from './types'

type UserDb = Awaited<ReturnType<typeof createClient>>
type ServiceDb = ReturnType<typeof createServiceClient>

interface Row {
  id: string; strategy_run_id: string; recommendation_index: number; implementation_mode: ImplementationMode; status: ImplementationStatus
  linked_task_id: string | null; budget_reserved_dkk: number | string; error: string | null; approved_at: string | null
}

/**
 * Implementation states for the given runs. The rows themselves are read with the user's own JWT (RLS = Paid Strategy
 * access). Only the linked task's status and its owner's display name come from the service client, and only after the
 * caller has been authorised for paid_manage.
 */
export async function loadImplementationViews(userDb: UserDb, serviceDb: ServiceDb, runIds: string[]): Promise<{ views: ImplementationView[]; error: boolean }> {
  if (!runIds.length) return { views: [], error: false }
  const rows = await userDb.from('marketing_paid_strategy_implementations')
    .select('id,strategy_run_id,recommendation_index,implementation_mode,status,linked_task_id,budget_reserved_dkk,error,approved_at')
    .in('strategy_run_id', runIds)
  if (rows.error) return { views: [], error: true }
  const data = (rows.data ?? []) as Row[]
  const taskIds = [...new Set(data.map(r => r.linked_task_id).filter((x): x is string => !!x))]
  const tasks = new Map<string, { status: string; owner: string | null }>()
  if (taskIds.length) {
    const t = await serviceDb.from('tasks').select('id,status,owner_user_id').in('id', taskIds)
    const owners = [...new Set(((t.data ?? []) as { owner_user_id: string | null }[]).map(x => x.owner_user_id).filter((x): x is string => !!x))]
    const names = new Map<string, string>()
    if (owners.length) {
      const u = await serviceDb.from('app_users').select('id,display_name').in('id', owners)
      for (const x of (u.data ?? []) as { id: string; display_name: string | null }[]) if (x.display_name) names.set(x.id, x.display_name)
    }
    for (const x of (t.data ?? []) as { id: string; status: string; owner_user_id: string | null }[]) {
      tasks.set(x.id, { status: x.status, owner: x.owner_user_id ? names.get(x.owner_user_id) ?? null : null })
    }
  }
  return {
    error: false,
    views: data.map(r => {
      const task = r.linked_task_id ? tasks.get(r.linked_task_id) : undefined
      return {
        id: r.id, strategyRunId: r.strategy_run_id, recommendationIndex: r.recommendation_index, mode: r.implementation_mode,
        status: effectiveStatus(r.status, task?.status ?? null), linkedTaskId: r.linked_task_id, linkedTaskStatus: task?.status ?? null,
        ownerName: task?.owner ?? null, budgetReservedDkk: Number(r.budget_reserved_dkk) || 0, error: r.error, approvedAt: r.approved_at,
      }
    }),
  }
}
