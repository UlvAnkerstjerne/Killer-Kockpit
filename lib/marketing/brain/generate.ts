import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { callCreativeClassifier } from '@/lib/ai/creative-classifier'
import { callCreativeInterpretation } from '@/lib/ai/creative-interpretation'
import { analysisWindow, buildAnalytics } from './analytics'
import { classifyLibrary } from './classification'
import { buildCreativeSignals } from './signals'
import { CLASSIFICATION_VERSION, INTERPRETATION_PROMPT_VERSION, type FingerprintRow } from './taxonomy'
import type { ClassificationCounts, Media } from './types'

type Db = ReturnType<typeof createServiceClient>
export const MAX_LIBRARY_ROWS = 1000
const LEASE_MS = 5 * 60_000
const MEDIA_COLUMNS = 'id,ig_account_id,media_type,caption,permalink,published_at,media_url,thumbnail_url,reach,plays,saved,likes,comments_count,shares,total_interactions,other_metrics_json,synced_at'
export type RefreshResult = { ok: boolean; runId?: string; counts?: ClassificationCounts; partial?: boolean; error?: string }

async function loadLibrary<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset <= MAX_LIBRARY_ROWS; offset += 500) {
    const { data, error } = await query(offset, offset + 499)
    if (error) throw new Error('storage')
    rows.push(...(data ?? []) as T[])
    if (rows.length > MAX_LIBRARY_ROWS) throw new Error('library_limit')
    if (!data || data.length < 500) return rows
  }
  return rows
}

/** Manual only. Caller must authenticate/authorize SUPER_ADMIN before creating
 * this service client. No Meta calls or writes to existing marketing tables. */
export async function generateCreativeIntelligence(db: Db, actorId: string, options: { force?: boolean; now?: Date } = {}): Promise<RefreshResult> {
  const now = options.now ?? new Date()
  const window = analysisWindow(now)
  let runId: string | undefined
  try {
    const expired = await db.from('marketing_creative_intelligence_runs').update({ status: 'failed', lease_expires_at: null, error: 'Refresh interrupted. Please refresh again.' })
      .eq('status', 'running').lt('lease_expires_at', now.toISOString())
    if (expired.error) throw new Error('storage')
    const claim = await db.from('marketing_creative_intelligence_runs').insert({
      status: 'running', requested_by: actorId, started_at: now.toISOString(), generated_at: now.toISOString(),
      analysis_start: window.start, analysis_end: window.end,
      classification_version: CLASSIFICATION_VERSION, prompt_version: INTERPRETATION_PROMPT_VERSION,
      lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
    }).select('id').single()
    if (claim.error?.code === '23505') return { ok: false, error: 'A Creative Intelligence refresh is already running. Try again after it finishes.' }
    if (claim.error || !claim.data) throw new Error('storage')
    runId = claim.data.id as string
    const heartbeat = async () => {
      const tick = new Date()
      const result = await db.from('marketing_creative_intelligence_runs')
        .update({ lease_expires_at: new Date(tick.getTime() + LEASE_MS).toISOString() })
        .eq('id', runId!).eq('status', 'running').gt('lease_expires_at', tick.toISOString()).select('id').single()
      if (result.error || !result.data) throw new Error('Refresh lease lost')
    }
    // Bound reads explicitly and fail closed on overflow rather than silently
    // sampling the newest/highest posts and presenting a biased complete report.
    const [media, existing] = await Promise.all([
      loadLibrary<Media>((from, to) => db.from('meta_ig_media').select(MEDIA_COLUMNS).order('published_at', { ascending: false }).order('id').range(from, to)),
      loadLibrary<FingerprintRow>((from, to) => db.from('marketing_content_fingerprints').select('*').order('media_id').range(from, to)),
    ])
    const classified = await classifyLibrary({ media, existing, now, force: options.force,
      classify: callCreativeClassifier, heartbeat,
      save: async rows => {
        const result = await db.from('marketing_content_fingerprints').upsert(rows, { onConflict: 'platform,media_id' })
        if (result.error) throw new Error('storage')
      },
    })
    const analytics = buildAnalytics(media, classified.fingerprints, now)
    const signals = buildCreativeSignals(analytics)
    await heartbeat()
    const interpretation = await callCreativeInterpretation(signals)
    await heartbeat()
    const partial = classified.counts.failed > 0 || classified.counts.deferred > 0 || !interpretation.ok
    const completed = await db.from('marketing_creative_intelligence_runs').update({
      status: partial ? 'partial' : 'completed', generated_at: new Date().toISOString(), lease_expires_at: null,
      analytics, signals, observations: interpretation.ok ? interpretation.observations : [],
      model: interpretation.ok ? interpretation.model : null, classification_counts: classified.counts,
      error: !interpretation.ok ? interpretation.error : partial ? 'Some content could not be classified. Refresh again to retry remaining items.' : null,
    }).eq('id', runId).eq('status', 'running').select('id').single()
    if (completed.error || !completed.data) throw new Error('storage')
    return { ok: true, runId, counts: classified.counts, partial }
  } catch (error) {
    const message = error instanceof Error && error.message === 'library_limit'
      ? 'The library exceeds the v1 safety limit. Increase the bounded loader before refreshing.'
      : 'Creative Intelligence refresh failed. Previous results and successful classifications are preserved.'
    if (runId) {
      await db.from('marketing_creative_intelligence_runs').update({ status: 'failed', lease_expires_at: null, error: message })
        .eq('id', runId).eq('status', 'running')
    }
    return { ok: false, error: message }
  }
}
