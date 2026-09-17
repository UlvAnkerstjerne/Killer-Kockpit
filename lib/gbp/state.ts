import type { createServiceClient } from '@/lib/supabase/server'
import { GbpDataError } from './data'
export type GbpDb = ReturnType<typeof createServiceClient>
export type GbpState = { id: string; status: string; cursor: string | null; last_success_at: string | null; last_attempt_at: string | null }
export async function readGbpState(db: GbpDb, integration: string): Promise<GbpState | null> {
  const { data, error } = await db.from('integration_sync_state').select('id,status,cursor,last_success_at,last_attempt_at')
    .eq('integration', integration).is('user_id', null).maybeSingle()
  if (error) throw new GbpDataError('Could not read GBP sync state.')
  return data as GbpState | null
}
export async function writeGbpState(db: GbpDb, integration: string, patch: Record<string, unknown>) {
  const state = await readGbpState(db, integration)
  const result = state
    ? await db.from('integration_sync_state').update(patch).eq('id', state.id)
    : await db.from('integration_sync_state').insert({ integration, user_id: null, ...patch })
  if (result.error) throw new GbpDataError('Could not save GBP sync state.')
}
/** One lease covers old/new routes and the existing manual server action. */
export async function claimGbpRun(db: GbpDb, now: Date): Promise<string | null> {
  const key = 'gbp_foundation'
  const state = await readGbpState(db, key)
  if (state?.status === 'syncing' && state.last_attempt_at && now.getTime() - Date.parse(state.last_attempt_at) < 30 * 60_000) return null
  const patch = { status: 'syncing', last_attempt_at: now.toISOString(), last_error: null }
  if (!state) {
    const { data, error } = await db.from('integration_sync_state').insert({ integration: key, user_id: null, ...patch }).select('id').single()
    if (error?.code === '23505') return null
    if (error || !data) throw new GbpDataError('Could not acquire GBP sync lease.')
    return data.id
  }
  let query = db.from('integration_sync_state').update(patch).eq('id', state.id).eq('status', state.status)
  query = state.last_attempt_at ? query.eq('last_attempt_at', state.last_attempt_at) : query.is('last_attempt_at', null)
  const { data, error } = await query.select('id').maybeSingle()
  if (error) throw new GbpDataError('Could not acquire GBP sync lease.')
  return data?.id ?? null
}
export async function finishGbpRun(db: GbpDb, id: string, startedAt: string, ok: boolean, error: string | null) {
  const { error: dbError } = await db.from('integration_sync_state').update({ status: ok ? 'synced' : 'failed', last_error: error,
    ...(ok ? { last_success_at: new Date().toISOString() } : {}) }).eq('id', id).eq('last_attempt_at', startedAt).select('id').single()
  if (dbError) throw new GbpDataError('Could not finish GBP sync lease.')
}
