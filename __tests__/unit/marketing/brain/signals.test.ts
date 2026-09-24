import { describe, expect, it } from 'vitest'
import { buildAnalytics } from '@/lib/marketing/brain/analytics'
import { buildCreativeSignals } from '@/lib/marketing/brain/signals'
import { fingerprint, media, NOW, strongSample } from '../../../helpers/creative-brain'

describe('Creative signals', () => {
  it('detects a strong repeated pattern with disjoint supporting and comparator IDs', () => {
    const { signals } = strongSample()
    expect(signals.map(s => s.type)).toEqual(expect.arrayContaining(['hook_outperformance', 'theme_outperformance', 'product_outperformance', 'share_heavy_pattern', 'save_heavy_pattern']))
    const signal = signals.find(s => s.type === 'hook_outperformance')!
    expect(signal).toMatchObject({ sample_size: 4, current: 1.5, baseline: 0.5, evidence_level: 'emerging' })
    expect(signal.supporting_media_ids).toEqual(['post-0', 'post-1', 'post-2', 'post-3'])
    expect(signal.comparison_media_ids).toEqual(['post-4', 'post-5', 'post-6', 'post-7'])
    expect(JSON.stringify(signals)).not.toMatch(/demograph|age|gender|audience|because/)
  })
  it('produces no pattern signal from two posts or missing per-metric evidence', () => {
    const { posts, fingerprints } = strongSample()
    expect(buildCreativeSignals(buildAnalytics(posts.slice(0, 2), fingerprints, NOW))).toHaveLength(0)
    const missing = posts.map((p, i) => ({ ...p, shares: i < 2 ? p.shares : null }))
    expect(buildCreativeSignals(buildAnalytics(missing, fingerprints, NOW)).some(s => s.type === 'share_heavy_pattern')).toBe(false)
  })
  it('does not generalize one viral post; labels it individual evidence', () => {
    const posts = [100, 100, 100, 100, 10000].map((plays, i) => media(i, { plays }))
    const signals = buildCreativeSignals(buildAnalytics(posts, posts.map(p => fingerprint(p)), NOW))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'exceptional_post', sample_size: 1, evidence_level: 'individual', supporting_media_ids: ['post-4'] })
  })
  it('only compares static formats using reach, not video views against static reach', () => {
    const posts = Array.from({ length: 9 }, (_, i) => media(i, {
      media_type: i < 3 ? 'CAROUSEL_ALBUM' : i < 6 ? 'IMAGE' : 'VIDEO', reach: i < 3 ? 300 : 100, plays: 999999,
    }))
    const signals = buildCreativeSignals(buildAnalytics(posts, [], NOW))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'format_outperformance', value: 'carousel', current: 300, baseline: 100, exposure_kind: 'reach' })
  })
  it('requires eight measured posts on both sides for supported evidence', () => {
    const posts = Array.from({ length: 16 }, (_, i) => media(i, { plays: i < 8 ? 3000 : 1000 }))
    const signals = buildCreativeSignals(buildAnalytics(posts, posts.map((p, i) => fingerprint(p, { hook_type: i < 8 ? 'question' : 'direct_product' })), NOW))
    expect(signals.find(s => s.type === 'hook_outperformance')?.evidence_level).toBe('supported')
  })
})
