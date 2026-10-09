import 'server-only'
import type { createClient } from '@/lib/supabase/server'
import type { Blocker, ExecutionLedger } from '../autonomous/types'
import { activationReview } from './review'
import type { ImplementationMode, ImplementationStatus, ImplementationView } from './types'

type UserDb = Awaited<ReturnType<typeof createClient>>

interface Row {
  id: string; strategy_run_id: string; recommendation_index: number; implementation_mode: ImplementationMode; status: ImplementationStatus
  linked_task_id: string | null; budget_reserved_dkk: number | string; error: string | null; approved_at: string | null; rejected_at: string | null; rejection_reason: string | null; execution: ExecutionLedger | Record<string, never> | null
}

/** Implementation states for the given runs, read with the user's own JWT (RLS = Paid Strategy access). */
export async function loadImplementationViews(userDb: UserDb, runIds: string[]): Promise<{ views: ImplementationView[]; error: boolean }> {
  if (!runIds.length) return { views: [], error: false }
  const rows = await userDb.from('marketing_paid_strategy_implementations')
    .select('id,strategy_run_id,recommendation_index,implementation_mode,status,linked_task_id,budget_reserved_dkk,error,approved_at,rejected_at,rejection_reason,execution')
    .in('strategy_run_id', runIds)
  if (rows.error) return { views: [], error: true }
  return {
    error: false,
    views: ((rows.data ?? []) as Row[]).map(r => {
      const ledger = r.execution && 'version' in r.execution ? r.execution as ExecutionLedger : null
      const blockers: Blocker[] = ledger?.blockers ?? []
      const message = typeof ledger?.evidence?.message === 'string' ? ledger.evidence.message : null
      return {
        id: r.id, strategyRunId: r.strategy_run_id, recommendationIndex: r.recommendation_index, mode: r.implementation_mode, status: r.status,
        budgetReservedDkk: Number(r.budget_reserved_dkk) || 0, error: r.error, approvedAt: r.approved_at, blockers, message,
        review: r.status === 'ready_to_activate' ? activationReview(r.implementation_mode, ledger) : null, linkedTaskId: r.linked_task_id,
        rejectedAt: r.rejected_at, rejectionReason: r.rejection_reason, metaObjectsExist: !!ledger?.evidence?.created,
      }
    }),
  }
}
