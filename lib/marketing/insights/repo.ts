import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import type { InsightStore } from './capture'
import type { InsightDomain, InsightInsert, InsightPatch, InsightRow, InsightSourceKind, LinkRow, ObservationRow } from './types'

type Db = ReturnType<typeof createServiceClient>
export const MAX_STORED_INSIGHTS = 500
const UNIQUE_VIOLATION = '23505'

/** service_role access for the capture path. The caller has already authorized (SUPER_ADMIN, or a generator that did). */
export function createInsightStore(db: Db): InsightStore {
  return {
    async listInsights(domains: InsightDomain[]) {
      const { data, error } = await db.from('marketing_insights').select('*').in('domain', domains)
        .order('last_supported_at', { ascending: false }).limit(MAX_STORED_INSIGHTS)
      if (error) throw new Error('insights_storage')
      return (data ?? []) as InsightRow[]
    },
    async hasObservations(sourceKind: InsightSourceKind, runId: string) {
      const { data, error } = await db.from('marketing_insight_observations').select('id').eq('source_kind', sourceKind).eq('source_run_id', runId).limit(1)
      if (error) throw new Error('insights_storage')
      return (data ?? []).length > 0
    },
    async insertInsight(row: InsightInsert) {
      const { data, error } = await db.from('marketing_insights').insert(row).select('id').single()
      if (error || !data) throw new Error(error?.code === UNIQUE_VIOLATION ? 'insights_duplicate_key' : 'insights_storage')
      return data.id as string
    },
    async updateInsight(id: string, patch: InsightPatch) {
      const { error } = await db.from('marketing_insights').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) throw new Error('insights_storage')
    },
    async insertObservations(rows: ObservationRow[]) {
      // The unique (insight, run) index makes a replay a no-op rather than an error.
      const { error } = await db.from('marketing_insight_observations').upsert(rows, { onConflict: 'insight_id,source_kind,source_run_id', ignoreDuplicates: true })
      if (error) throw new Error('insights_storage')
    },
    async insertLinks(rows: LinkRow[]) {
      const { error } = await db.from('marketing_insight_links').upsert(rows, { onConflict: 'insight_id,target_type,target_run_id,target_slot,relation', ignoreDuplicates: true })
      if (error) throw new Error('insights_storage')
    },
  }
}
