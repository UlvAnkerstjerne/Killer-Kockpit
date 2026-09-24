import { MIN_PATTERN_POSTS, SUPPORTED_POSTS, median } from './analytics'
import type { CreativeAnalytics, CreativePost, CreativeSignal, Dimension, SignalType } from './types'

export const MATERIAL_RATIO = 1.5
export const MAX_SIGNALS = 20
const EXPOSURE_SIGNALS: Partial<Record<Dimension, SignalType>> = {
  hook_type: 'hook_outperformance', primary_theme: 'theme_outperformance',
  product_focus: 'product_outperformance', presentation_style: 'presentation_outperformance',
}
export function patternValue(post: CreativePost, dimension: Dimension): string | undefined {
  return dimension === 'creative_format' ? post.format : post.fingerprint?.[dimension]
}
const useful = (value: string) => !['unknown', 'no_clear_hook', 'other', 'none'].includes(value)

/** Every comparator is disjoint and shares account, format and denominator.
 * Rates are medians of per-post rates; null is missing, never zero. */
export function buildCreativeSignals(analytics: CreativeAnalytics): CreativeSignal[] {
  const signals: CreativeSignal[] = []
  for (const group of analytics.patterns) {
    if (group.count < MIN_PATTERN_POSTS || group.dimension === 'creative_format' || !useful(group.value)) continue
    const members = new Set(group.supporting_media_ids)
    const eligible = analytics.posts.filter(p => p.account_id === group.account_id && p.format === group.format &&
      p.exposure_kind === group.exposure_kind && p.fingerprint && p.fingerprint.confidence !== 'low' &&
      useful(patternValue(p, group.dimension) ?? 'unknown'))
    for (const metric of ['normalized_exposure', 'share_rate', 'save_rate'] as const) {
      const currentPosts = eligible.filter(p => members.has(p.id) && p[metric] !== null)
      const others = eligible.filter(p => !members.has(p.id) && p[metric] !== null)
      if (currentPosts.length < MIN_PATTERN_POSTS || others.length < MIN_PATTERN_POSTS) continue
      const current = median(currentPosts.map(p => p[metric]!))!
      const baseline = median(others.map(p => p[metric]!))!
      // Zero comparators need a material absolute gap; never report infinity.
      const delta = metric === 'normalized_exposure' ? 0.5 : 1
      if (current - baseline < delta || (baseline > 0 && current < baseline * MATERIAL_RATIO)) continue
      const type = metric === 'share_rate' ? 'share_heavy_pattern' : metric === 'save_rate' ? 'save_heavy_pattern' : EXPOSURE_SIGNALS[group.dimension]!
      signals.push({ id: `${group.id}:${metric}`, type, dimension: group.dimension, value: group.value,
        account_id: group.account_id, format: group.format, exposure_kind: group.exposure_kind,
        metric, current, baseline, sample_size: currentPosts.length, comparison_sample_size: others.length,
        comparison: 'Other classified posts in the same account, format and exposure metric',
        supporting_media_ids: currentPosts.map(p => p.id), comparison_media_ids: others.map(p => p.id),
        evidence_level: Math.min(currentPosts.length, others.length) >= SUPPORTED_POSTS ? 'supported' : 'emerging' })
    }
  }
  // The only cross-format raw exposure comparison allowed in v1: carousel vs
  // single image reach. Video views can never enter this comparison.
  for (const format of analytics.formats) {
    if (format.exposure_kind !== 'reach' || format.count < MIN_PATTERN_POSTS) continue
    const group = analytics.posts.filter(p => p.account_id === format.account_id && p.format === format.format && p.exposure_kind === 'reach')
    const others = analytics.posts.filter(p => p.account_id === format.account_id && p.format !== format.format && p.exposure_kind === 'reach')
    if (others.length < MIN_PATTERN_POSTS) continue
    const current = median(group.map(p => p.exposure))!
    const baseline = median(others.map(p => p.exposure))!
    if (current < baseline * MATERIAL_RATIO) continue
    signals.push({ id: `${format.account_id}:${format.format}:format_outperformance`, type: 'format_outperformance',
      dimension: 'creative_format', value: format.format, account_id: format.account_id, format: format.format,
      exposure_kind: 'reach', sample_size: group.length, comparison_sample_size: others.length,
      metric: 'exposure', current, baseline, comparison: 'Other static format in the same account, using reach only',
      supporting_media_ids: group.map(p => p.id), comparison_media_ids: others.map(p => p.id),
      evidence_level: Math.min(group.length, others.length) >= SUPPORTED_POSTS ? 'supported' : 'emerging' })
  }
  for (const post of analytics.exceptional) {
    const peers = analytics.posts.filter(p => p.account_id === post.account_id && p.format === post.format && p.exposure_kind === post.exposure_kind)
    signals.push({ id: `${post.id}:exceptional_post`, type: 'exceptional_post', dimension: 'creative_format', value: post.format,
      account_id: post.account_id, format: post.format, exposure_kind: post.exposure_kind, sample_size: 1,
      metric: 'normalized_exposure', current: post.normalized_exposure!, baseline: 1,
      comparison: 'Format median (includes this individual post); not evidence of a repeatable pattern',
      comparison_sample_size: peers.length, supporting_media_ids: [post.id], comparison_media_ids: peers.map(p => p.id), evidence_level: 'individual' })
  }
  return signals.sort((a, b) => {
    const rank = { supported: 2, emerging: 1, individual: 0 }
    return rank[b.evidence_level] - rank[a.evidence_level] || b.sample_size - a.sample_size ||
      (b.current / Math.max(b.baseline, 1)) - (a.current / Math.max(a.baseline, 1)) || a.id.localeCompare(b.id)
  }).slice(0, MAX_SIGNALS)
}

export function label(value: string): string {
  if (value === 'reel_video') return 'Reel / video'
  return value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}
export function signalFinding(signal: CreativeSignal): string {
  if (signal.type === 'exceptional_post') return 'An individual post stands above its format median'
  const metric = signal.metric === 'share_rate' ? 'shares' : signal.metric === 'save_rate' ? 'saves' : 'exposure'
  const subject = signal.dimension === 'hook_type' ? 'caption hooks' : signal.dimension === 'primary_theme' ? 'content' : 'posts'
  return `${label(signal.value)} ${subject}: higher median ${metric} in this sample`
}
export function signalEvidence(signal: CreativeSignal): string {
  const unit = signal.metric === 'normalized_exposure' ? '× format median' : signal.metric === 'exposure' ? signal.exposure_kind : `/ 1,000 ${signal.exposure_kind}`
  return `${signal.sample_size} ${label(signal.format)} post${signal.sample_size === 1 ? '' : 's'}: ${signal.current.toFixed(2)} ${unit} vs ${signal.baseline.toFixed(2)} ${unit}; comparison n=${signal.comparison_sample_size}. ${signal.comparison}.`
}
