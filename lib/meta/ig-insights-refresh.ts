/**
 * lib/meta/ig-insights-refresh.ts
 *
 * Dependency-free core for (a) refreshing lifetime IG media insights on every
 * deep sync and (b) the one-off historical backfill (scripts/backfill-ig-media-insights.ts).
 *
 * Deliberately has NO imports so the script can load it with
 * `node --experimental-strip-types` (no path aliases / extensionless imports).
 *
 * Invariants:
 *   - Missing values stay null: a patch only contains metrics the API returned.
 *     A metric absent from a response never overwrites a stored value, and
 *     nothing is ever defaulted to 0.
 *   - A rate-limit error stops the run cleanly (no throw); progress is returned.
 */

export interface IgInsightsValues {
  reach?:              number
  plays?:              number
  saved?:              number
  likes?:              number
  comments?:           number
  shares?:             number
  total_interactions?: number
  other_metrics_json?: Record<string, number>
}

export interface IgInsightTarget {
  id:         string
  media_type: string
}

export type IgInsightsResult =
  | { kind: 'ok'; insights: IgInsightsValues }
  | { kind: 'unavailable'; reason?: string }   // API confirmed no insights for this media
  | { kind: 'error'; message: string }         // transient/unknown — retry later

export type IgInsightsPatch = Record<string, number | Record<string, number>>

/** Max insight calls per deep sync for the recent-post refresh (1 call per post). */
export const IG_REFRESH_MAX_CALLS_PER_SYNC = 60

/** DB column for each structured metric. */
const COLUMN_BY_METRIC: Array<[keyof IgInsightsValues, string]> = [
  ['reach', 'reach'],
  ['plays', 'plays'],
  ['saved', 'saved'],
  ['likes', 'likes'],
  ['comments', 'comments_count'],
  ['shares', 'shares'],
  ['total_interactions', 'total_interactions'],
  ['other_metrics_json', 'other_metrics_json'],
]

/** Only metrics actually returned (finite numbers); undefined/null are omitted, never zeroed. */
export function buildInsightsPatch(insights: IgInsightsValues): IgInsightsPatch {
  const patch: IgInsightsPatch = {}
  for (const [key, column] of COLUMN_BY_METRIC) {
    const v = insights[key]
    if (v === undefined || v === null) continue
    if (key === 'other_metrics_json') {
      if (typeof v === 'object' && Object.keys(v).length > 0) patch[column] = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      patch[column] = v
    }
  }
  return patch
}

export function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'MetaRateLimitError'
}

/** True if the stored row already carries any structured metric. */
export function hasStoredMetrics(row: {
  reach?: number | null; plays?: number | null; likes?: number | null
  saved?: number | null; comments_count?: number | null; shares?: number | null
  total_interactions?: number | null
}): boolean {
  return [row.reach, row.plays, row.likes, row.saved, row.comments_count, row.shares, row.total_interactions]
    .some((v) => v !== null && v !== undefined)
}

export interface RefreshOutcome {
  attempted:   number
  updated:     number
  unavailable: string[]   // ids the API confirmed have no insights (nothing written)
  errored:     string[]   // transient failures (nothing written, retry later)
  rateLimited: boolean
  remaining:   number     // targets not attempted (budget or rate limit)
}

export async function refreshIgInsights(opts: {
  targets:        IgInsightTarget[]
  fetchInsights:  (t: IgInsightTarget) => Promise<IgInsightsResult>
  writePatch:     (id: string, patch: IgInsightsPatch) => Promise<void>
  maxCalls:       number
  delayMs?:       number
  sleep?:         (ms: number) => Promise<void>
  onProgress?:    (msg: string) => void
}): Promise<RefreshOutcome> {
  const { targets, fetchInsights, writePatch, maxCalls, delayMs = 0, onProgress } = opts
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const out: RefreshOutcome = {
    attempted: 0, updated: 0, unavailable: [], errored: [], rateLimited: false, remaining: 0,
  }

  for (let i = 0; i < targets.length; i++) {
    if (out.attempted >= maxCalls) { out.remaining = targets.length - i; break }
    const t = targets[i]
    if (out.attempted > 0 && delayMs > 0) await sleep(delayMs)
    out.attempted++

    let res: IgInsightsResult
    try {
      res = await fetchInsights(t)
    } catch (err) {
      if (isRateLimitError(err)) {
        out.rateLimited = true
        out.attempted--          // this call did not complete
        out.remaining = targets.length - i
        break
      }
      out.errored.push(t.id)
      onProgress?.(`error ${t.id}: ${(err as Error).message}`)
      continue
    }

    if (res.kind === 'error') { out.errored.push(t.id); onProgress?.(`error ${t.id}: ${res.message}`); continue }
    if (res.kind === 'unavailable') { out.unavailable.push(t.id); continue }

    const patch = buildInsightsPatch(res.insights)
    if (Object.keys(patch).length === 0) { out.unavailable.push(t.id); continue }
    await writePatch(t.id, patch)
    out.updated++
  }
  return out
}
