import type { Media, CreativeRun } from '@/lib/marketing/brain/types'
import { CLASSIFICATION_VERSION, CLASSIFIER_PROMPT_VERSION, INTERPRETATION_PROMPT_VERSION, type FingerprintRow } from '@/lib/marketing/brain/taxonomy'
import { sourceHash } from '@/lib/marketing/brain/classification'
import { buildAnalytics } from '@/lib/marketing/brain/analytics'
import { buildCreativeSignals, signalEvidence, signalFinding } from '@/lib/marketing/brain/signals'

/** Prompt version of runs saved before the v2 interpretation (one-signal observations). */
export const LEGACY_PROMPT_VERSION = '2026-09-24-v1'
export const NOW = new Date('2026-09-24T12:00:00Z')
export function media(n: number, overrides: Partial<Media> = {}): Media {
  return { id: `post-${n}`, ig_account_id: 'synthetic-ig', media_type: 'VIDEO', caption: 'Why choose falafel? Freshly made every day.',
    permalink: `https://www.instagram.com/p/synthetic-${n}/`, published_at: '2026-09-10T12:00:00Z', thumbnail_url: null, media_url: null,
    reach: 400, plays: 1000, shares: 10, saved: 5, comments_count: 2, likes: 20, total_interactions: 37,
    other_metrics_json: null, synced_at: NOW.toISOString(), ...overrides }
}
export function fingerprint(post: Media, overrides: Partial<FingerprintRow> = {}): FingerprintRow {
  return { media_id: post.id, platform: 'instagram', source_hash: sourceHash(post), classified_at: NOW.toISOString(),
    classification_version: CLASSIFICATION_VERSION, ai_model: 'synthetic-model', prompt_version: CLASSIFIER_PROMPT_VERSION,
    hook_type: 'question', hook_text: 'Why choose falafel?', hook_source: 'caption', primary_theme: 'education_explainer',
    secondary_themes: [], product_focus: 'falafel', creative_format: 'reel_video', presentation_style: 'unknown', human_presence: 'unknown',
    language: 'en', cta_type: 'none', confidence: 'high', ...overrides }
}
export function strongSample() {
  const posts = Array.from({ length: 8 }, (_, i) => media(i, { plays: i < 4 ? 3000 : 1000, shares: i < 4 ? 90 : 5, saved: i < 4 ? 60 : 2 }))
  const fingerprints = posts.map((p, i) => fingerprint(p, i < 4 ? {} : { hook_type: 'direct_product', primary_theme: 'product', product_focus: 'kebab' }))
  const analytics = buildAnalytics(posts, fingerprints, NOW)
  return { posts, fingerprints, analytics, signals: buildCreativeSignals(analytics) }
}
export function savedRun(): CreativeRun {
  const { analytics, signals } = strongSample()
  return { id: 'synthetic-run', generated_at: NOW.toISOString(), analysis_start: analytics.window.start, analysis_end: analytics.window.end,
    model: 'synthetic-model', prompt_version: LEGACY_PROMPT_VERSION, classification_version: CLASSIFICATION_VERSION,
    status: 'completed', analytics, signals, observations: signals.slice(0, 2).map(s => ({ signal_id: s.id,
      finding: signalFinding(s), evidence: signalEvidence(s), interpretation: 'The explanatory angle may encourage people to pass the idea along.',
      suggested_experiment: 'Test another comparison caption against direct product copy while keeping the edit consistent.' })),
    classification_counts: { eligible: 8, classified: 8, skipped: 0, failed: 0, deferred: 0 }, error: null }
}

/** Production-like evidence: seven Reels, two exceptional (11.1× and 7.3× the Reel median). */
export function twoReelsSample() {
  const plays = [600, 800, 900, 1000, 1200, 7300, 11100]
  const posts = plays.map((p, i) => media(i, { plays: p, reach: 500, shares: 4, saved: 2 }))
  const fingerprints = posts.map((p, i) => fingerprint(p, { hook_type: (['question', 'direct_product', 'bold_claim', 'story', 'list', 'curiosity', 'question'] as const)[i], primary_theme: i < 5 ? 'product' : 'food_process', product_focus: i < 5 ? 'kebab' : 'falafel' }))
  const analytics = buildAnalytics(posts, fingerprints, NOW)
  return { posts, analytics, signals: buildCreativeSignals(analytics) }
}
/** A run produced by the v2 interpretation for the two-Reels evidence (representative natural output). */
export const TWO_REELS_V2_COPY = {
  brain_take: "There's one thing worth focusing on here: two Reels massively outperformed the normal Reel baseline. That's promising, but seven posts isn't enough to tell us which creative choice caused it. I'd spend the next test figuring out what those two videos have in common rather than chasing the caption labels.",
  headline: 'Two reels are doing the heavy lifting',
  take: "Both massively outperformed a normal Killer Kebab reel. That's interesting, but with only seven posts we still don't know what caused it. I wouldn't credit the caption hook yet — we haven't analysed the opening visuals.",
  next_move: 'Put the two reels side by side and identify what they share — opening shot, pacing, subject, length or editing. Copy one or two shared traits in the next reel and see if it happens again.',
}
export function twoReelsV2Output(signalIds: string[]) {
  return { brain_take: TWO_REELS_V2_COPY.brain_take, insights: [{ signal_ids: signalIds, headline: TWO_REELS_V2_COPY.headline, take: TWO_REELS_V2_COPY.take, next_move: TWO_REELS_V2_COPY.next_move, business_context: null }] }
}
export function currentRun(): CreativeRun {
  const { analytics, signals } = twoReelsSample()
  const ids = signals.filter(s => s.type === 'exceptional_post').map(s => s.id)
  return { id: 'v2-run', generated_at: NOW.toISOString(), analysis_start: analytics.window.start, analysis_end: analytics.window.end,
    model: 'synthetic-model', prompt_version: INTERPRETATION_PROMPT_VERSION, classification_version: CLASSIFICATION_VERSION,
    status: 'completed', analytics: { ...analytics, brain_take: TWO_REELS_V2_COPY.brain_take }, signals,
    observations: [{ signal_ids: ids, headline: TWO_REELS_V2_COPY.headline, take: TWO_REELS_V2_COPY.take, next_move: TWO_REELS_V2_COPY.next_move }],
    classification_counts: { eligible: 7, classified: 7, skipped: 0, failed: 0, deferred: 0 }, error: null }
}
