'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getUserMarketingPermissions } from './permissions'
import { generateCreativeIntelligence, type RefreshResult } from '@/lib/marketing/brain/generate'
import type { CreativeRun } from '@/lib/marketing/brain/types'

export interface BrainData { allowed: boolean; canRefresh: boolean; run: CreativeRun | null; latestAttempt: Pick<CreativeRun, 'status' | 'error'> | null; error: string | null }

export async function getCreativeIntelligence(): Promise<BrainData> {
  const user = await getCurrentUser()
  const denied: BrainData = { allowed: false, canRefresh: false, run: null, latestAttempt: null, error: null }
  if (!user || !canAccessMarketing(user.role, user.marketing_access)) return denied
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'paid_manage')) return denied
  const base = { ...denied, allowed: true, canRefresh: user.role === 'SUPER_ADMIN' }
  // Reads use the user JWT and RLS, including requests outside the page layout.
  const db = await createClient()
  const [latest, attempt] = await Promise.all([
    db.from('marketing_creative_intelligence_runs').select('*').in('status', ['completed', 'partial'])
      .order('generated_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('marketing_creative_intelligence_runs').select('status,error').order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (latest.error || attempt.error) return { ...base, error: 'Creative Intelligence storage is unavailable. Confirm the migration is activated.' }
  return { ...base, run: latest.data as CreativeRun | null, latestAttempt: attempt.data as BrainData['latestAttempt'] }
}

export async function refreshCreativeIntelligence(force = false): Promise<RefreshResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (user.role !== 'SUPER_ADMIN') return { ok: false, error: 'Only SUPER_ADMIN can refresh Creative Intelligence.' }
  if (typeof force !== 'boolean') return { ok: false, error: 'Invalid refresh option.' }
  const result = await generateCreativeIntelligence(createServiceClient(), user.id, { force })
  revalidatePath('/marketing/brain')
  return result
}
