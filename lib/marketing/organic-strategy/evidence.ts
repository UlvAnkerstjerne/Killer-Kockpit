/**
 * Organic Strategy — post-level evidence assembler.
 *
 * Pure: no I/O, no AI. Turns stored Instagram rows, current fingerprints and business context
 * into a bounded, privacy-safe JSON object for the specialist model.
 *
 * Why post-level: abstract aggregates ("hooks of type X do 1.4x") cannot tell the strategist WHAT
 * a post was about. The manual Claude-IG audit worked because the model could read the subjects.
 *
 * Trust boundary:
 *   - Instagram IDs, handles, URLs, permalinks and comment text never leave this module for the
 *     model. Posts get local refs (P1.., U1.., B1..).
 *   - Every caption and business note is untrusted text: redacted with the same function the
 *     classifier uses (links, e-mails, @mentions, phone-like numbers), whitespace-collapsed,
 *     truncated, and prefixed `DATA:`.
 *   - A missing counter is `null`, never 0. Rates are computed only from present counters and a
 *     present exposure, and are shown per 1,000 of the format's own exposure.
 */

import { priorInsightsEvidence, type PriorInsightInput } from '@/lib/marketing/insights/prior'
import { MIN_BASELINE_POSTS, mediaFormat, primaryExposure } from '@/lib/marketing/brain/analytics'
import { captionSource } from '@/lib/marketing/brain/classification'
import type { MarketingBusinessContextItem } from '@/lib/marketing/brain/business-context'
import type { FingerprintRow } from '@/lib/marketing/brain/taxonomy'
import type { Media } from '@/lib/marketing/brain/types'
import type { OrganicStrategyPostRef } from './types'

export const ORGANIC_EVIDENCE_VERSION = 'organic-strategy-evidence-v1'
export const MAX_MEASURED_POSTS = 40
/** Of the measured cap, this many are reserved for the highest-exposure posts so breakouts can never be crowded out by recency. */
export const TOP_EXPOSURE_RESERVED = 20
export const MAX_UNMEASURED_POSTS = 12
export const MEASURED_CAPTION_CHARS = 600
export const UNMEASURED_CAPTION_CHARS = 220
export const MAX_BUSINESS_CONTEXT_ITEMS = 8
export const BUSINESS_CONTEXT_CHARS = 400
/** Fewer measured posts than this and the strategist is not asked at all. */
export const MIN_MEASURED_POSTS_FOR_STRATEGY = 3

// ── helpers ─────────────────────────────────────────────────────────────────────

/** A stored counter, or null when unavailable. Zero is a real value; missing is not zero. */
function counter(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}
const round = (n: number, dp = 1): number => { const f = 10 ** dp; return Math.round(n * f) / f }

/** Untrusted social text: redact contact details/links, collapse whitespace, truncate, mark as data. */
export function untrustedText(value: string | null | undefined, max: number): string {
  return `DATA:${captionSource(value ?? null).replace(/\s+/g, ' ').trim().slice(0, max)}`
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function views(m: Media): number | null {
  return mediaFormat(m.media_type) === 'reel_video' ? counter(m.plays) ?? counter(m.other_metrics_json?.views) : null
}

/** Any stored performance counter at all. Unmeasured posts have none; they are NOT zero-performance posts. */
export function isMeasured(m: Media): boolean {
  return [m.reach, m.plays, m.other_metrics_json?.views, m.saved, m.shares, m.likes, m.comments_count, m.total_interactions]
    .some(v => counter(v) !== null)
}

function validPublished(m: Media, now: Date): boolean {
  return !!m.published_at && Number.isFinite(Date.parse(m.published_at)) && Date.parse(m.published_at) < now.getTime()
}
const publishedMs = (m: Media) => Date.parse(m.published_at!)

/** Highest-exposure posts first (so breakouts always survive the cap), then most recent to fill; final order: newest first. */
export function selectMeasured(measured: Media[]): Media[] {
  if (measured.length <= MAX_MEASURED_POSTS) return [...measured].sort(newestFirst)
  const byExposure = [...measured].sort((a, b) => (primaryExposure(b).value ?? -1) - (primaryExposure(a).value ?? -1) || newestFirst(a, b))
  const chosen = new Map(byExposure.slice(0, TOP_EXPOSURE_RESERVED).map(m => [m.id, m]))
  for (const m of [...measured].sort(newestFirst)) {
    if (chosen.size >= MAX_MEASURED_POSTS) break
    chosen.set(m.id, m)
  }
  return [...chosen.values()].sort(newestFirst)
}
function newestFirst(a: Media, b: Media) { return publishedMs(b) - publishedMs(a) || a.id.localeCompare(b.id) }

// ── blind spots (told to the model verbatim) ──────────────────────────────────────

export const KNOWN_BLIND_SPOTS = [
  'No retention, watch time, completion rate or drop-off data is stored.',
  'Reach is not split into followers and non-followers.',
  'No audience demographics or locations are stored.',
  'Posting times and traffic sources are not supplied; only the publication date is.',
  'The visuals have not been analysed: no footage, thumbnails or on-screen text were seen. Only captions and counters exist, and presentation style and human presence are not classified.',
  'Counters are lifetime totals read at sync time. Older posts had longer to accumulate them.',
  'Video exposure is views; other formats use reach. Rates and ratios are comparable only within the same format.',
  'A missing metric is unknown, not zero. A post with no metrics is unmeasured, not a failure.',
  'Classifications are AI-derived from caption text only and have not been reviewed by a human.',
  'No comment text or competitor data is supplied.',
] as const

// ── builder ─────────────────────────────────────────────────────────────────────

export interface OrganicEvidenceInput {
  /** Earlier durable insights as context (never evidence). Optional: absent leaves the evidence exactly as before. */
  priorInsights?: PriorInsightInput[]
  media: Media[]
  fingerprints: FingerprintRow[]
  businessContext: MarketingBusinessContextItem[]
  followersLatest: number | null
  now: Date
}

type Rates = { shares: number | null; saves: number | null; likes: number | null; comments: number | null; interactions: number | null }

export function buildOrganicEvidence(input: OrganicEvidenceInput) {
  const unique = [...new Map(input.media.map(m => [m.id, m])).values()]
  const valid = unique.filter(m => validPublished(m, input.now))
  const measuredAll = valid.filter(isMeasured)
  const unmeasuredAll = valid.filter(m => !isMeasured(m))
  const fingerprintByMedia = new Map(input.fingerprints.map(f => [f.media_id, f]))

  // Format baselines over ALL measured posts with a primary exposure, not just those in the prompt.
  const exposureByFormat = new Map<string, number[]>()
  for (const m of measuredAll) {
    const e = primaryExposure(m)
    if (e.value !== null) exposureByFormat.set(e.format, [...(exposureByFormat.get(e.format) ?? []), e.value])
  }
  const baseline = (format: string): number | null => {
    const values = exposureByFormat.get(format) ?? []
    return values.length >= MIN_BASELINE_POSTS ? median(values) : null
  }

  const selected = selectMeasured(measuredAll)
  const posts = selected.map((m, i) => {
    const e = primaryExposure(m)
    const per1k = (v: number | null): number | null => (e.value !== null && v !== null ? round((v / e.value) * 1000) : null)
    const metrics = {
      reach: counter(m.reach), views: views(m), likes: counter(m.likes), comments: counter(m.comments_count),
      shares: counter(m.shares), saves: counter(m.saved), interactions: counter(m.total_interactions),
    }
    const rates: Rates = {
      shares: per1k(metrics.shares), saves: per1k(metrics.saves), likes: per1k(metrics.likes),
      comments: per1k(metrics.comments), interactions: per1k(metrics.interactions),
    }
    const base = e.value !== null ? baseline(e.format) : null
    const f = fingerprintByMedia.get(m.id)
    const known = <T extends string>(v: T | undefined): T | undefined => (v && v !== 'unknown' ? v : undefined)
    return {
      ref: `P${i + 1}`,
      published: m.published_at!.slice(0, 10),
      media_type: m.media_type,
      format: e.format,
      caption: untrustedText(m.caption, MEASURED_CAPTION_CHARS),
      metrics,
      primary_exposure: e.value !== null ? { kind: e.kind, value: e.value } : null,
      rates_per_1k_primary_exposure: rates,
      exposure_vs_format_median: base !== null && e.value !== null ? round(e.value / base, 2) : null,
      classification: f ? {
        hook_type: known(f.hook_type), primary_theme: known(f.primary_theme), secondary_themes: f.secondary_themes.length ? f.secondary_themes : undefined,
        product_focus: known(f.product_focus), presentation_style: known(f.presentation_style), human_presence: known(f.human_presence),
        language: known(f.language), cta_type: known(f.cta_type), confidence: f.confidence,
      } : null,
    }
  })

  const unmeasuredSelected = [...unmeasuredAll].sort(newestFirst).slice(0, MAX_UNMEASURED_POSTS)
  const recent_unmeasured_posts = unmeasuredSelected.map((m, i) => ({
    ref: `U${i + 1}`,
    published: m.published_at!.slice(0, 10),
    media_type: m.media_type,
    caption: untrustedText(m.caption, UNMEASURED_CAPTION_CHARS),
    performance: 'not measured',
  }))

  const businessSelected = input.businessContext.slice(0, MAX_BUSINESS_CONTEXT_ITEMS)
  const creative_context = businessSelected.map((c, i) => ({
    ref: `B${i + 1}`,
    project: untrustedText(c.project_title, 80),
    note: untrustedText(c.body, BUSINESS_CONTEXT_CHARS),
    occurred_on: c.occurred_on,
    age_days: c.age_days,
  }))

  const formatCount = (list: Media[]) => {
    const out: Record<string, number> = { reel_video: 0, carousel: 0, image: 0, unknown: 0 }
    for (const m of list) out[mediaFormat(m.media_type)] += 1
    return out
  }
  const measuredByFormat = formatCount(measuredAll)
  const notes: string[] = [
    `Only ${measuredAll.length} of ${unique.length} stored posts have any performance metric. The other ${unique.length - measuredAll.length} have none (unknown, not zero).`,
  ]
  for (const [format, n] of Object.entries(measuredByFormat)) {
    if (format !== 'unknown' && n >= 1 && n < MIN_BASELINE_POSTS) {
      notes.push(`Only ${n} measured ${format} post${n === 1 ? '' : 's'}: too few for any ${format}-level conclusion or baseline.`)
    }
  }
  if (measuredAll.length > posts.length) notes.push(`${measuredAll.length - posts.length} measured posts are omitted from the list (highest-exposure posts are always kept).`)
  if (unmeasuredSelected.length) notes.push(`The ${unmeasuredSelected.length} most recent unmeasured posts are listed for subject coverage only. Their performance is unknown.`)

  const summary = {
    stored_posts: unique.length,
    measured_posts: measuredAll.length,
    unmeasured_posts: unique.length - measuredAll.length,
    measured_in_prompt: posts.length,
    unmeasured_in_prompt: recent_unmeasured_posts.length,
    business_context_items: creative_context.length,
  }

  const blindSpots: string[] = [...KNOWN_BLIND_SPOTS]
  if (input.followersLatest === null) blindSpots.push('The current follower count is not supplied.')

  const evidence = {
    schema_version: ORGANIC_EVIDENCE_VERSION,
    as_of_date: input.now.toISOString().slice(0, 10),
    account: { followers_latest: input.followersLatest },
    sample: {
      ...summary,
      measured_by_format: measuredByFormat,
      format_baselines_available: [...exposureByFormat.keys()].filter(f => baseline(f) !== null),
      minimum_posts_for_a_format_baseline: MIN_BASELINE_POSTS,
      notes,
    },
    known_blind_spots: blindSpots,
    posts,
    recent_unmeasured_posts,
    creative_context: {
      purpose: 'Authentic subject matter from real company updates. NOT evidence of organic performance.',
      items: creative_context,
    },
    ...priorInsightsSection(input.priorInsights),
  }

  const refs: OrganicStrategyPostRef[] = [
    ...selected.map((m, i) => ({ ref: `P${i + 1}`, published_at: m.published_at!, media_type: m.media_type, permalink: m.permalink })),
    ...unmeasuredSelected.map((m, i) => ({ ref: `U${i + 1}`, published_at: m.published_at!, media_type: m.media_type, permalink: m.permalink })),
  ]
  const publishedDates = selected.map(m => m.published_at!.slice(0, 10)).sort()

  return {
    evidence,
    refs,
    summary,
    window: { first_published: publishedDates[0] ?? null, last_published: publishedDates[publishedDates.length - 1] ?? null, as_of: evidence.as_of_date },
  }
}

/** Only present when there are prior insights, so a first run sees exactly the evidence it always did. */
function priorInsightsSection(items: PriorInsightInput[] | undefined) {
  const prior = priorInsightsEvidence(items ?? [], untrustedText)
  return prior ? { prior_insights: prior } : {}
}

export type OrganicEvidence = ReturnType<typeof buildOrganicEvidence>['evidence']
