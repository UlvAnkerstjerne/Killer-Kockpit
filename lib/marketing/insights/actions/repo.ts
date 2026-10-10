import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import type { ActionStore } from './store'
import type { ActionInsert, ActionRow } from './types'

type Db = ReturnType<typeof createServiceClient>
const TABLE = 'marketing_insight_actions'
const fail = () => { throw new Error('insight_actions_storage') }

/** service_role access. Every caller has already authorized the user and read the insight under that user's own RLS. */
export function createActionStore(db: Db): ActionStore {
  return {
    async listForInsight(insightId) {
      const { data, error } = await db.from(TABLE).select('*').eq('insight_id', insightId).order('proposed_at', { ascending: false }).limit(100)
      if (error) fail()
      return (data ?? []) as ActionRow[]
    },
    async get(id) {
      const { data, error } = await db.from(TABLE).select('*').eq('id', id).maybeSingle()
      if (error) fail()
      return (data as ActionRow | null) ?? null
    },
    async insertBatch(rows: ActionInsert[]) {
      const { data, error } = await db.from(TABLE).insert(rows).select('*')
      if (error || !data) fail()
      return data as ActionRow[]
    },
    async supersedeProposed(insightId) {
      const { error } = await db.from(TABLE).update({ status: 'superseded', updated_at: new Date().toISOString() }).eq('insight_id', insightId).eq('status', 'proposed')
      if (error) fail()
    },
    async claimProposed(id, actorId, at) {
      const { data, error } = await db.from(TABLE).update({ status: 'chosen', chosen_by_user_id: actorId, chosen_at: at, updated_at: at }).eq('id', id).eq('status', 'proposed').select('*').maybeSingle()
      // 23505: another option of the same draft was chosen first (marketing_insight_actions_one_choice_idx). Not an error: it lost.
      if (error?.code === '23505') return null
      if (error) fail()
      return (data as ActionRow | null) ?? null
    },
    async release(id) {
      const { error } = await db.from(TABLE).update({ status: 'proposed', chosen_by_user_id: null, chosen_at: null, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'chosen').is('linked_task_id', null)
      if (error) fail()
    },
    async finishChoice(id, patch) {
      const { error } = await db.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) fail()
    },
    async markSiblingsNotChosen(batchId, exceptId) {
      const { error } = await db.from(TABLE).update({ status: 'not_chosen', updated_at: new Date().toISOString() }).eq('batch_id', batchId).neq('id', exceptId).eq('status', 'proposed')
      if (error) fail()
    },
    async listOpen() {
      const { data, error } = await db.from(TABLE).select('*').eq('status', 'chosen').limit(500)
      if (error) fail()
      return (data ?? []) as ActionRow[]
    },
    async recordOutcome(id, patch) {
      const { error } = await db.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'chosen')
      if (error) fail()
    },
  }
}
