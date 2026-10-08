'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { generatePaidStrategy, type PaidStrategyRefreshResult } from '@/lib/marketing/paid-strategy/generate'
import type { PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'

export interface PaidStrategyData {
  allowed: boolean
  canGenerate: boolean
  latest: PaidStrategyRun | null
  previous: PaidStrategyRun[]
  latestAttempt: Pick<PaidStrategyRun, 'status' | 'error'> | null
  error: string | null
}

const TABLE = 'marketing_paid_strategy_runs'
const LIST_COLUMNS = 'id,started_at,generated_at,status,window_start,window_end,model,prompt_version,skill_ref,skill_hash,recommendations,error'
const PREVIOUS_RUNS = 5

export async function getPaidStrategy(): Promise<PaidStrategyData> {
  const denied: PaidStrategyData = { allowed: false, canGenerate: false, latest: null, previous: [], latestAttempt: null, error: null }
  const user = await getCurrentUser()
  if (!user || !canAccessMarketing(user.role, user.marketing_access)) return denied
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_manage')) return denied
  const base = { ...denied, allowed: true, canGenerate: user.role === 'SUPER_ADMIN' }

  // Reads use the user JWT and RLS. No AI request happens on page render.
  const db = await createClient()
  const [latest, history, attempt] = await Promise.all([
    db.from(TABLE).select('*').eq('status', 'completed').order('generated_at', { ascending: false }).limit(1).maybeSingle(),
    db.from(TABLE).select(LIST_COLUMNS).eq('status', 'completed').order('generated_at', { ascending: false }).limit(PREVIOUS_RUNS + 1),
    db.from(TABLE).select('status,error').order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (latest.error || history.error || attempt.error) {
    return { ...base, error: 'Paid Strategy storage is unavailable. Confirm the migration is activated.' }
  }
  const latestRun = latest.data as PaidStrategyRun | null
  return {
    ...base,
    latest: latestRun,
    previous: ((history.data ?? []) as PaidStrategyRun[]).filter(r => r.id !== latestRun?.id).slice(0, PREVIOUS_RUNS),
    latestAttempt: attempt.data as PaidStrategyData['latestAttempt'],
  }
}

export async function generatePaidStrategyAnalysis(): Promise<PaidStrategyRefreshResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (user.role !== 'SUPER_ADMIN') return { ok: false, error: 'Only SUPER_ADMIN can generate Paid Strategy.' }
  const result = await generatePaidStrategy(createServiceClient(), user.id)
  revalidatePath('/marketing/brain')
  return result
}
