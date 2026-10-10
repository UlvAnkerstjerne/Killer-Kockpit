/**
 * scripts/backfill-ig-media-insights.ts
 *
 * One-off, idempotent historical backfill of lifetime IG media insights for
 * stored posts older than the 90-day window that the weekly deep sync keeps
 * fresh. NEVER run from the sync; run by hand.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-ig-media-insights.ts            # dry-run (default)
 *   node --experimental-strip-types scripts/backfill-ig-media-insights.ts --probe 5  # dry-run + 5 read-only API calls
 *   node --experimental-strip-types scripts/backfill-ig-media-insights.ts --apply    # write
 *
 * Flags:
 *   --apply            write metrics to meta_ig_media (otherwise nothing is written)
 *   --probe N          dry-run only: call the Graph API for N sample posts (newest first) and report
 *   --limit N          max API calls per run (default 100)
 *   --delay-ms N       pause between calls (default 400)
 *   --env-file PATH    env file (default .env.local)
 *   --state-file PATH  local JSON of ids confirmed unavailable (default scripts/.ig-insights-backfill-state.json)
 *
 * Safety:
 *   - Eligible = older than 90 days AND no structured metric stored AND not in the state file.
 *   - Only returned metrics are written; missing values stay null (never 0).
 *   - Rate limit (usage header >= 75 or Graph codes 4/17/32/613): stop cleanly, report, safe to re-run.
 *   - Posts the API confirms have no insights are recorded in the state file (no DB write) and skipped next run.
 *   - Transient errors are not recorded; they are retried next run.
 */

import * as fs from 'fs'
import { createClient } from '@supabase/supabase-js'
import {
  buildInsightsPatch,
  hasStoredMetrics,
  refreshIgInsights,
  type IgInsightsResult,
  type IgInsightsValues,
// @ts-expect-error TS5097: node --experimental-strip-types requires the explicit .ts extension
} from '../lib/meta/ig-insights-refresh.ts'

// ── Args / env ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const APPLY = flag('--apply')
const PROBE = Number(opt('--probe', '0'))
const LIMIT = Number(opt('--limit', '100'))
const DELAY_MS = Number(opt('--delay-ms', '400'))
const STATE_FILE = opt('--state-file', 'scripts/.ig-insights-backfill-state.json')
const RECENT_DAYS = 90

for (const line of fs.readFileSync(opt('--env-file', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/)
  if (m) process.env[m[1]] = m[2]
}

const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN
const IG_ID = process.env.META_INSTAGRAM_BUSINESS_ACCOUNT_ID
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
if (!SUPABASE_URL || !SUPABASE_KEY || !IG_ID || (!META_TOKEN && (APPLY || PROBE > 0))) {
  console.error('Missing required env vars')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY)
const BASE = 'https://graph.facebook.com/v26.0'

// ── Graph fetch (mirrors lib/meta/ig-client.ts fetchIgMediaInsights) ──────────

class MetaRateLimitError extends Error {
  constructor(m: string) { super(m); this.name = 'MetaRateLimitError' }
}

const RATE_CODES = new Set([4, 17, 32, 613])
const STRUCTURED = new Set(['reach', 'plays', 'saved', 'likes', 'comments', 'shares', 'total_interactions'])

async function fetchInsights(id: string, mediaType: string): Promise<IgInsightsResult> {
  const isVideo = mediaType === 'VIDEO' || mediaType === 'REEL'
  const metric = isVideo
    ? 'reach,views,saved,likes,comments,shares,total_interactions'
    : 'reach,saved,likes,comments,shares,total_interactions'
  let res: Response
  try {
    res = await fetch(`${BASE}/${id}/insights?metric=${metric}`, { headers: { Authorization: `Bearer ${META_TOKEN}` } })
  } catch (e) {
    return { kind: 'error', message: (e as Error).message }
  }

  const usage = res.headers.get('x-business-use-case-usage')
  if (usage) {
    try {
      const parsed = JSON.parse(usage) as Record<string, Array<{ call_count?: number }>>
      const max = Math.max(0, ...Object.values(parsed).flatMap((a) => a.map((i) => i.call_count ?? 0)))
      if (max >= 75) throw new MetaRateLimitError(`usage ${max}`)
    } catch (e) { if (e instanceof MetaRateLimitError) throw e }
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number }
    data?: Array<{ name: string; values?: Array<{ value: number }> }>
  }
  if (body.error) {
    const { code, error_subcode: sub, message } = body.error
    if (code !== undefined && RATE_CODES.has(code)) throw new MetaRateLimitError(message ?? `code ${code}`)
    // 100 = invalid param/unsupported for this media; 2108006 = posted before business conversion
    if (code === 100 || sub === 2108006) return { kind: 'unavailable', reason: `code ${code}/${sub ?? '-'}: ${message}` }
    return { kind: 'error', message: `code ${code}: ${message}` }
  }

  const insights: IgInsightsValues = {}
  const other: Record<string, number> = {}
  for (const item of body.data ?? []) {
    const v = item.values?.[0]?.value
    if (v === undefined || v === null) continue
    const field = item.name === 'views' ? 'plays' : item.name
    if (STRUCTURED.has(field)) (insights as Record<string, unknown>)[field] = v
    else other[item.name] = v
  }
  if (Object.keys(other).length > 0) insights.other_metrics_json = other
  return { kind: 'ok', insights }
}

// ── State (ids confirmed unavailable; local file, no schema change) ───────────

interface State { unavailable: Record<string, string> }
function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State } catch { return { unavailable: {} } }
}
function saveState(s: State) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86400_000).toISOString()
  const { data, error } = await db
    .from('meta_ig_media')
    .select('id, media_type, published_at, reach, plays, likes, saved, comments_count, shares, total_interactions')
    .eq('ig_account_id', IG_ID)
    .lt('published_at', cutoff)
    .order('published_at', { ascending: false })
    .limit(5000)
  if (error) throw new Error(error.message)

  const state = loadState()
  const rows = data ?? []
  const missing = rows.filter((r) => !hasStoredMetrics(r))
  const eligible = missing.filter((r) => !(r.id in state.unavailable))
  const byYear: Record<string, number> = {}
  for (const r of eligible) byYear[r.published_at.slice(0, 4)] = (byYear[r.published_at.slice(0, 4)] ?? 0) + 1

  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`)
  console.log(`Stored posts older than ${RECENT_DAYS}d: ${rows.length}`)
  console.log(`  already have metrics: ${rows.length - missing.length}`)
  console.log(`  known unavailable (state file): ${missing.length - eligible.length}`)
  console.log(`  eligible: ${eligible.length}  (by year: ${JSON.stringify(byYear)})`)
  console.log(`Estimated API calls: ${eligible.length} (1 per post); this run capped at ${LIMIT} => ${Math.min(LIMIT, eligible.length)}; runs needed: ${Math.ceil(eligible.length / LIMIT)}`)

  if (!APPLY && PROBE === 0) { console.log('\nDry-run only. Use --probe N for a read-only API sample, --apply to write.'); return }

  const targets = eligible.map((r) => ({ id: r.id, media_type: r.media_type, published_at: r.published_at as string }))
  const pubById = new Map(targets.map((t) => [t.id, t.published_at]))

  if (!APPLY) {
    // Read-only probe: sample across the age range (evenly spaced), no writes, no state changes.
    const n = Math.min(PROBE, targets.length)
    const step = targets.length / Math.max(n, 1)
    const sample = Array.from({ length: n }, (_, i) => targets[Math.floor(i * step)])
    console.log(`\nProbing ${n} posts (read-only):`)
    for (const t of sample) {
      try {
        const r = await fetchInsights(t.id, t.media_type)
        const desc = r.kind === 'ok' ? `ok keys=${Object.keys(buildInsightsPatch(r.insights)).join(',')}`
          : r.kind === 'unavailable' ? `UNAVAILABLE ${r.reason}` : `error ${r.message}`
        console.log(`  ${t.published_at.slice(0, 10)} ${t.media_type.padEnd(14)} ${desc}`)
      } catch (e) { console.log(`  rate limited: ${(e as Error).message} — stopping`); break }
      await new Promise((r) => setTimeout(r, DELAY_MS))
    }
    return
  }

  const out = await refreshIgInsights({
    targets,
    maxCalls: LIMIT,
    delayMs: DELAY_MS,
    onProgress: (m) => console.warn('  ' + m),
    fetchInsights: (t) => fetchInsights(t.id, t.media_type),
    writePatch: async (id, patch) => {
      const { error: e } = await db.from('meta_ig_media').update({ ...patch, synced_at: new Date().toISOString() }).eq('id', id)
      if (e) throw new Error(e.message)
    },
  })
  for (const id of out.unavailable) state.unavailable[id] = `unavailable ${pubById.get(id)?.slice(0, 10)} (${new Date().toISOString().slice(0, 10)})`
  saveState(state)

  console.log(`\nAttempted ${out.attempted} | updated ${out.updated} | unavailable ${out.unavailable.length} | errors ${out.errored.length} | remaining ${out.remaining}`)
  if (out.rateLimited) console.log('Stopped on rate limit. Progress is saved; re-run later to continue.')
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
