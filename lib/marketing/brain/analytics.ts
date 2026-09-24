/** Pure analytics over lifetime counters for a publication cohort, not period gains. */
import { CLASSIFICATION_VERSION, type FingerprintRow, type CreativeFormat } from './taxonomy'
import type { CreativeAnalytics, CreativePost, Dimension, Media, MetricSummary, Pattern } from './types'

export const MIN_BASELINE_POSTS = 5
export const MIN_PATTERN_POSTS = 3
export const SUPPORTED_POSTS = 8
export const EXCEPTIONAL_RATIO = 3
export const STALE_SYNC_DAYS = 14
export const DAY = 86_400_000

export function mediaFormat(type: string): CreativeFormat {
  if (type === 'VIDEO' || type === 'REEL') return 'reel_video'
  if (type === 'CAROUSEL_ALBUM') return 'carousel'
  if (type === 'IMAGE') return 'image'
  return 'unknown'
}
export function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
export function primaryExposure(media: Media) {
  const format = mediaFormat(media.media_type)
  // Meta v26 views are already mapped into plays by ig-client. Never fall back
  // to reach for video: that would mix incompatible denominators in a cohort.
  const kind = format === 'reel_video' ? 'views' as const : 'reach' as const
  const value = format === 'unknown' ? null : kind === 'views'
    ? finiteCount(media.plays) ?? finiteCount(media.other_metrics_json?.views)
    : finiteCount(media.reach)
  return { format, kind, value: value !== null && value > 0 ? value : null }
}
export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
export function summary(values: (number | null)[]): MetricSummary {
  const valid = values.filter((v): v is number => v !== null && Number.isFinite(v))
  return { value: median(valid), count: valid.length }
}
export function rate(count: number | null, exposure: number): number | null {
  const valid = finiteCount(count)
  return valid === null || exposure <= 0 ? null : valid / exposure * 1000
}
export function analysisWindow(now: Date) {
  // Last 90 completed UTC publication days. Today's incomplete posts excluded.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { start: new Date(end.getTime() - 90 * DAY).toISOString(), end: end.toISOString() }
}
export function cohortKey(account: string, format: CreativeFormat, kind: string) {
  return `${account}:${format}:${kind}`
}
const DIMENSIONS: Dimension[] = ['hook_type', 'primary_theme', 'product_focus', 'creative_format', 'presentation_style']

export function buildAnalytics(media: Media[], fingerprints: FingerprintRow[], now = new Date()): CreativeAnalytics {
  const window = analysisWindow(now)
  const rows = [...new Map(media.map(p => [p.id, p])).values()].filter(p => p.published_at &&
    Date.parse(p.published_at) >= Date.parse(window.start) && Date.parse(p.published_at) < Date.parse(window.end))
  const fp = new Map(fingerprints.filter(f => f.classification_version === CLASSIFICATION_VERSION).map(f => [f.media_id, f]))
  const exposures = new Map<string, number[]>()
  for (const row of rows) {
    const e = primaryExposure(row)
    if (e.value === null) continue
    const key = cohortKey(row.ig_account_id, e.format, e.kind)
    exposures.set(key, [...(exposures.get(key) ?? []), e.value])
  }
  const posts: CreativePost[] = []
  for (const row of rows) {
    const e = primaryExposure(row)
    if (e.value === null) continue
    const compatible = exposures.get(cohortKey(row.ig_account_id, e.format, e.kind)) ?? []
    const baseline = compatible.length >= MIN_BASELINE_POSTS ? median(compatible) : null
    const f = fp.get(row.id)
    posts.push({
      id: row.id, account_id: row.ig_account_id, published_at: row.published_at!, synced_at: row.synced_at,
      permalink: row.permalink, thumbnail_url: row.thumbnail_url ?? (e.format !== 'reel_video' ? row.media_url : null),
      format: e.format, exposure_kind: e.kind, exposure: e.value, baseline, baseline_count: compatible.length,
      normalized_exposure: baseline && baseline > 0 ? e.value / baseline : null,
      shares: finiteCount(row.shares), saves: finiteCount(row.saved),
      share_rate: rate(row.shares, e.value), save_rate: rate(row.saved, e.value), comment_rate: rate(row.comments_count, e.value),
      fingerprint: f ? { hook_type: f.hook_type, hook_source: f.hook_source, primary_theme: f.primary_theme,
        product_focus: f.product_focus, presentation_style: f.presentation_style, confidence: f.confidence } : null,
    })
  }
  const groups = new Map<string, { dimension: Dimension; value: string; posts: CreativePost[] }>()
  for (const post of posts) {
    for (const dimension of DIMENSIONS) {
      const value = dimension === 'creative_format' ? post.format : post.fingerprint?.[dimension]
      // Low-confidence classifications remain visible on posts, but do not
      // support taxonomy claims. Format comes directly from trusted metadata.
      if (!value || (dimension !== 'creative_format' && post.fingerprint?.confidence === 'low')) continue
      const id = `${cohortKey(post.account_id, post.format, post.exposure_kind)}:${dimension}:${value}`
      const group = groups.get(id) ?? { dimension, value, posts: [] }
      group.posts.push(post)
      groups.set(id, group)
    }
  }
  const patterns: Pattern[] = [...groups].map(([id, group]): Pattern => {
    const sorted = [...group.posts].sort((a, b) => b.exposure - a.exposure || a.id.localeCompare(b.id))
    const first = sorted[0]
    return { id, dimension: group.dimension, value: group.value, account_id: first.account_id,
      format: first.format, exposure_kind: first.exposure_kind, count: sorted.length,
      normalized_exposure: summary(sorted.map(p => p.normalized_exposure)),
      share_rate: summary(sorted.map(p => p.share_rate)), save_rate: summary(sorted.map(p => p.save_rate)),
      comment_rate: summary(sorted.map(p => p.comment_rate)),
      evidence_level: sorted.length < MIN_PATTERN_POSTS ? 'insufficient' : sorted.length < SUPPORTED_POSTS ? 'emerging' : 'supported',
      supporting_media_ids: sorted.map(p => p.id), top_media_id: first.id }
  }).sort((a, b) => (b.normalized_exposure.value ?? -1) - (a.normalized_exposure.value ?? -1) || a.id.localeCompare(b.id))
  const formats = [...exposures.keys()].map(key => {
    const group = posts.filter(p => cohortKey(p.account_id, p.format, p.exposure_kind) === key)
    return { account_id: group[0].account_id, format: group[0].format, exposure_kind: group[0].exposure_kind,
      count: group.length, median_exposure: median(group.map(p => p.exposure)),
      share_rate: summary(group.map(p => p.share_rate)), save_rate: summary(group.map(p => p.save_rate)) }
  })
  return { window, posts, patterns, formats,
    exceptional: posts.filter(p => p.normalized_exposure !== null && p.normalized_exposure >= EXCEPTIONAL_RATIO)
      .sort((a, b) => b.normalized_exposure! - a.normalized_exposure! || a.id.localeCompare(b.id)).slice(0, 6),
    coverage: { total: rows.length, with_exposure: posts.length, classified: posts.filter(p => p.fingerprint).length,
      stale_syncs: posts.filter(p => !Number.isFinite(Date.parse(p.synced_at)) || now.getTime() - Date.parse(p.synced_at) > STALE_SYNC_DAYS * DAY).length },
  }
}
