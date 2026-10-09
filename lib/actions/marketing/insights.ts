'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing } from '@/lib/permissions'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { backfillInsights } from '@/lib/marketing/insights/service'
import type { InsightRow, LinkRow, ObservationRow } from '@/lib/marketing/insights/types'
import type { InsightView } from '@/lib/marketing/insights/view'

export interface InsightsData { allowed: boolean; canCapture: boolean; insights: InsightView[]; error: string | null }
const MAX_VIEWED_INSIGHTS = 80

/**
 * Reads use the user's JWT, so RLS decides who sees anything (SUPER_ADMIN, or marketing access + paid_manage: the same rule as
 * Creative Intelligence). Someone without that permission simply gets no rows. Nothing is written here.
 */
export async function getMarketingInsights(): Promise<InsightsData> {
  const user = await getCurrentUser()
  const none: InsightsData = { allowed: false, canCapture: false, insights: [], error: null }
  if (!user || !canAccessMarketing(user.role, user.marketing_access)) return none
  const base = { ...none, allowed: true, canCapture: user.role === 'SUPER_ADMIN' }
  const db = await createClient()
  const found = await db.from('marketing_insights').select('*').order('last_supported_at', { ascending: false }).limit(MAX_VIEWED_INSIGHTS)
  if (found.error) return { ...base, error: 'Insights storage is unavailable. Confirm the migration is activated.' }
  const rows = (found.data ?? []) as InsightRow[]
  if (!rows.length) return base
  const ids = rows.map(r => r.id)
  const [history, links] = await Promise.all([
    db.from('marketing_insight_observations').select('insight_id,observed_at,strength,change').in('insight_id', ids).order('observed_at', { ascending: false }).limit(1000),
    db.from('marketing_insight_links').select('insight_id,target_type,target_run_id,target_index,relation').in('insight_id', ids).limit(1000),
  ])
  if (history.error || links.error) return { ...base, error: 'Insights storage is unavailable. Confirm the migration is activated.' }
  const historyBy = new Map<string, InsightView['history']>()
  for (const h of (history.data ?? []) as Pick<ObservationRow, 'insight_id' | 'observed_at' | 'strength' | 'change'>[]) {
    historyBy.set(h.insight_id, [...(historyBy.get(h.insight_id) ?? []), { observed_at: h.observed_at, strength: h.strength, change: h.change }])
  }
  const linksBy = new Map<string, InsightView['links']>()
  for (const l of (links.data ?? []) as Pick<LinkRow, 'insight_id' | 'target_type' | 'target_run_id' | 'target_index' | 'relation'>[]) {
    linksBy.set(l.insight_id, [...(linksBy.get(l.insight_id) ?? []), { target_type: l.target_type, target_run_id: l.target_run_id, target_index: l.target_index, relation: l.relation }])
  }
  return { ...base, insights: rows.map(r => ({ ...r, history: historyBy.get(r.id) ?? [], links: linksBy.get(r.id) ?? [] })) }
}

export type CaptureInsightsResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * SUPER_ADMIN only. Replays the most recent saved runs through the same idempotent capture the generators use, oldest first, so
 * insights from before this feature appear with their history. Safe to run any number of times.
 */
export async function captureMarketingInsights(): Promise<CaptureInsightsResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (user.role !== 'SUPER_ADMIN') return { ok: false, error: 'Only SUPER_ADMIN can capture insights.' }
  try {
    const result = await backfillInsights(createServiceClient())
    revalidatePath('/marketing/brain')
    revalidatePath('/marketing')
    const runs = result.creative + result.paid
    return { ok: true, message: runs ? `Captured from ${runs} saved run${runs === 1 ? '' : 's'}: ${result.created} new, ${result.updated} updated.` : 'Everything saved was already captured.' }
  } catch {
    return { ok: false, error: 'Insights could not be captured. Confirm the insights migration has been applied.' }
  }
}
