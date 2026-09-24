import { describe, expect, it } from 'vitest'
import { buildAnalytics, median, primaryExposure, rate } from '@/lib/marketing/brain/analytics'
import { fingerprint, media, NOW, strongSample } from '../../../helpers/creative-brain'

describe('Creative Brain analytics', () => {
  it('uses the median format baseline and resists one viral outlier', () => {
    const posts = [100, 100, 100, 100, 300000].map((plays, i) => media(i, { plays }))
    const result = buildAnalytics(posts, posts.map(p => fingerprint(p)), NOW)
    expect(median([10, 30, 20, 40])).toBe(25)
    expect(result.posts.map(p => p.baseline)).toEqual([100, 100, 100, 100, 100])
    expect(result.posts[4].normalized_exposure).toBe(3000)
    expect(result.patterns.find(p => p.dimension === 'hook_type')?.normalized_exposure.value).toBe(1)
    expect(result.exceptional.map(p => p.id)).toEqual(['post-4'])
  })
  it('never substitutes static reach for Reel views; baselines are per format and account', () => {
    const videos = Array.from({ length: 5 }, (_, i) => media(i, { plays: 1000 }))
    const images = Array.from({ length: 5 }, (_, i) => media(i + 10, { media_type: 'IMAGE', reach: 100 }))
    const result = buildAnalytics([...videos, ...images, media(99, { ig_account_id: 'other', plays: 9000 })], [], NOW)
    expect(result.posts[0].baseline).toBe(1000)
    expect(result.posts[5].baseline).toBe(100)
    expect(result.posts.at(-1)?.baseline).toBeNull()
    expect(primaryExposure(media(50, { plays: null, reach: 500000 })).value).toBeNull()
    expect(primaryExposure(media(51, { plays: null, other_metrics_json: { views: 100 } }))).toMatchObject({ value: 100, kind: 'views' })
    expect(primaryExposure(media(52, { media_type: 'STORY' })).value).toBeNull()
  })
  it('preserves missing metrics and uses exposure-specific share/save/comment rates', () => {
    expect(rate(10, 2000)).toBe(5)
    expect(rate(null, 2000)).toBeNull()
    expect(rate(0, 2000)).toBe(0)
    expect(rate(10, 0)).toBeNull()
    const result = buildAnalytics([media(1, { plays: 2000, shares: 20, saved: 10, comments_count: null })], [], NOW)
    expect(result.posts[0]).toMatchObject({ share_rate: 10, save_rate: 5, comment_rate: null, baseline: null })
  })
  it('enforces sample sizes, rejects old versions and keeps low confidence out of patterns', () => {
    const posts = [media(1), media(2), media(3)]
    const result = buildAnalytics(posts, [fingerprint(posts[0]), fingerprint(posts[1], { confidence: 'low' }), fingerprint(posts[2], { classification_version: 'old' })], NOW)
    expect(result.patterns.find(p => p.dimension === 'hook_type')).toMatchObject({ count: 1, evidence_level: 'insufficient' })
    expect(result.posts.every(p => p.normalized_exposure === null)).toBe(true)
  })
  it('aggregates each dimension with exact IDs and the best post', () => {
    const { analytics } = strongSample()
    const group = analytics.patterns.find(p => p.dimension === 'product_focus' && p.value === 'falafel')!
    expect(group.count).toBe(4)
    expect(group.share_rate).toEqual({ value: 30, count: 4 })
    expect(group.supporting_media_ids).toEqual(['post-0', 'post-1', 'post-2', 'post-3'])
    expect(group.top_media_id).toBe('post-0')
    expect(analytics.patterns.some(p => p.dimension === 'presentation_style')).toBe(true)
  })
  it('uses completed UTC publication days and excludes older, future and undated posts', () => {
    const result = buildAnalytics([media(1), media(2, { published_at: '2026-06-23T12:00:00Z' }), media(3, { published_at: NOW.toISOString() }), media(4, { published_at: null })], [], NOW)
    expect(result.posts.map(p => p.id)).toEqual(['post-1'])
    expect(result.coverage.total).toBe(1)
  })
})
