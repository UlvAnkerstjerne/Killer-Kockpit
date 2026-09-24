import { describe, expect, it, vi } from 'vitest'
import { BATCH_SIZE, MAX_CLASSIFICATIONS_PER_REFRESH, captionSource, classifierInput, classifyLibrary, sourceHash, validateClassification } from '@/lib/marketing/brain/classification'
import { FingerprintSchema } from '@/lib/marketing/brain/taxonomy'
import { fingerprint, media, NOW } from '../../../helpers/creative-brain'

const item = (p = media(1)) => FingerprintSchema.parse(Object.fromEntries(Object.entries(fingerprint(p)).filter(([k]) => k in FingerprintSchema.shape)))
const classify = vi.fn(async (inputs: ReturnType<typeof classifierInput>[]) => ({ ok: true as const, model: 'synthetic', items: inputs.map(i => item(media(1, { id: i.media_id }))) }))

describe('Creative Brain classification', () => {
  it('accepts only the controlled taxonomy and rejects extra fields', () => {
    expect(FingerprintSchema.safeParse({ ...item(), primary_theme: 'viral_magic' }).success).toBe(false)
    expect(FingerprintSchema.safeParse({ ...item(), execute: 'publish' }).success).toBe(false)
    expect(FingerprintSchema.safeParse({ ...item(), secondary_themes: ['product', 'humour', 'community'] }).success).toBe(false)
  })
  it('maps exact media IDs independent of response order, rejecting duplicates and missing IDs', () => {
    const inputs = [media(1), media(2)].map(classifierInput)
    expect(validateClassification({ items: [item(media(2)), item(media(1))] }, inputs).map(i => i.media_id)).toEqual(['post-2', 'post-1'])
    expect(() => validateClassification({ items: [item(), item()] }, inputs)).toThrow()
    expect(() => validateClassification({ items: [item()] }, inputs)).toThrow()
    expect(() => validateClassification({ items: [item(media(9)), item(media(2))] }, inputs)).toThrow()
  })
  it('requires a caption opening quote, never a video or thumbnail hook', () => {
    const inputs = [classifierInput(media(1))]
    expect(() => validateClassification({ items: [{ ...item(), hook_source: 'video_transcript' }] }, inputs)).toThrow()
    expect(() => validateClassification({ items: [{ ...item(), hook_text: 'Invented opening shot' }] }, inputs)).toThrow()
    expect(() => validateClassification({ items: [{ ...item(), presentation_style: 'food_closeup' }] }, inputs)).toThrow()
    expect(() => validateClassification({ items: [{ ...item(), human_presence: 'present' }] }, inputs)).toThrow()
    const absent = validateClassification({ items: [item()] }, [classifierInput(media(1, { caption: null }))])[0]
    expect(absent).toMatchObject({ hook_type: 'unknown', hook_source: 'unknown', hook_text: null })
  })
  it('redacts contact material and bounds captions; metrics cannot influence classifications', () => {
    const caption = 'Call +45 1234 5678 or hi@example.com @customer https://example.com. '.repeat(100)
    const input = classifierInput(media(1, { caption, plays: 999999 }))
    expect(input.caption.length).toBeLessThanOrEqual(1500)
    expect(input.caption).not.toMatch(/hi@example|@customer|1234|https:/)
    expect(Object.keys(input)).toEqual(['media_id', 'media_type', 'caption'])
    expect(sourceHash(media(1))).toBe(sourceHash(media(1, { plays: 999999, synced_at: '2026-09-25' })))
    expect(captionSource(null)).toBe('')
  })
  it('batches, saves each batch independently and skips unchanged current classifications', async () => {
    classify.mockClear()
    const posts = Array.from({ length: 23 }, (_, i) => media(i))
    const save = vi.fn(async () => {})
    const result = await classifyLibrary({ media: posts, existing: [fingerprint(posts[0])], now: NOW, classify, save })
    expect(classify.mock.calls.map(([items]) => items.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 2])
    expect(result.counts).toMatchObject({ classified: 22, skipped: 1, failed: 0 })
    classify.mockClear()
    const again = await classifyLibrary({ media: posts, existing: result.fingerprints, now: NOW, classify, save })
    expect(classify).not.toHaveBeenCalled()
    expect(again.counts.skipped).toBe(23)
  })
  it('reclassifies changed sources, old versions and forced current fingerprints', async () => {
    for (const existing of [fingerprint(media(1), { classification_version: 'old' }), fingerprint(media(1), { prompt_version: 'old' }), fingerprint(media(1), { source_hash: 'old' })]) {
      const result = await classifyLibrary({ media: [media(1)], existing: [existing], now: NOW, classify, save: async () => {} })
      expect(result.counts.classified).toBe(1)
    }
    expect((await classifyLibrary({ media: [media(1)], existing: [fingerprint(media(1))], force: true, now: NOW, classify, save: async () => {} })).counts.classified).toBe(1)
  })
  it('retains successful batches across a failure and excludes meaningless rows', async () => {
    const posts = Array.from({ length: 22 }, (_, i) => media(i))
    const batched = vi.fn().mockImplementationOnce(classify).mockResolvedValueOnce({ ok: false, error: 'failure' }).mockImplementationOnce(classify)
    const save = vi.fn(async () => {})
    const result = await classifyLibrary({ media: [...posts, media(90, { caption: '' }), media(91, { plays: null })], existing: [], now: NOW, classify: batched, save })
    expect(result.counts).toMatchObject({ eligible: 22, classified: 12, failed: 10 })
    expect(save).toHaveBeenCalledTimes(2)
    expect(result.fingerprints).toHaveLength(12)
  })
  it('does not treat failed persistence as a successful classification', async () => {
    const result = await classifyLibrary({ media: [media(1)], existing: [], now: NOW, classify, save: async () => { throw new Error('DB unavailable') } })
    expect(result.counts).toMatchObject({ classified: 0, failed: 1 })
    expect(result.fingerprints).toHaveLength(0)
  })
  it('bounds backfill spend and reports deferred items exactly', async () => {
    const posts = Array.from({ length: MAX_CLASSIFICATIONS_PER_REFRESH + 1 }, (_, i) => media(i))
    const result = await classifyLibrary({ media: posts, existing: [], now: NOW, classify, save: async () => {} })
    expect(result.counts).toMatchObject({ eligible: 201, classified: 200, deferred: 1 })
  })
  it('does not analyze a stale caption fingerprint when replacement classification fails', async () => {
    const result = await classifyLibrary({ media: [media(1, { caption: 'A completely different product and opening.' })], existing: [fingerprint(media(1))], now: NOW,
      classify: async () => ({ ok: false, error: 'provider down' }), save: async () => {} })
    expect(result.fingerprints).toHaveLength(0)
    expect(result.counts.failed).toBe(1)
  })
})
