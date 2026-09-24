import { createHash } from 'node:crypto'
import { CLASSIFICATION_VERSION, CLASSIFIER_PROMPT_VERSION, ClassificationOutputSchema, type Fingerprint, type FingerprintRow } from './taxonomy'
import { mediaFormat, primaryExposure } from './analytics'
import type { ClassificationCounts, Media } from './types'

export const BATCH_SIZE = 10
export const MAX_CLASSIFICATIONS_PER_REFRESH = 200
export const MAX_CAPTION_LENGTH = 1500
export interface ClassificationInput { media_id: string; media_type: string; caption: string }

/** No comments, customer records, handles, contact details, URLs or metrics go
 * to the classifier. Captions remain untrusted even after contact redaction. */
export function captionSource(caption: string | null): string {
  return (caption ?? '').slice(0, 6000)
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/@[\w.]+/g, '[mention]')
    .replace(/\+?\d[\d ()-]{6,}\d/g, '[number]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim().slice(0, MAX_CAPTION_LENGTH)
}
export function classifierInput(media: Media): ClassificationInput {
  return { media_id: media.id, media_type: mediaFormat(media.media_type), caption: captionSource(media.caption) }
}
export function sourceHash(media: Media): string {
  return createHash('sha256').update(JSON.stringify(classifierInput(media))).digest('hex')
}
export function isCurrentFingerprint(media: Media, row: FingerprintRow): boolean {
  return row.classification_version === CLASSIFICATION_VERSION && row.prompt_version === CLASSIFIER_PROMPT_VERSION && row.source_hash === sourceHash(media)
}
export function eligibleMedia(media: Media[], now: Date): Media[] {
  return [...new Map(media.map(p => [p.id, p])).values()]
    .filter(p => primaryExposure(p).value !== null && captionSource(p.caption).replace(/\[(link|email|mention|number)\]/g, '').trim().length >= 8 &&
      p.published_at && Number.isFinite(Date.parse(p.published_at)) && Date.parse(p.published_at) < now.getTime())
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!) || a.id.localeCompare(b.id))
}
export function validateClassification(output: unknown, inputs: ClassificationInput[]): Fingerprint[] {
  const parsed = ClassificationOutputSchema.parse(output)
  const expected = new Map(inputs.map(p => [p.media_id, p]))
  if (parsed.items.length !== inputs.length || new Set(parsed.items.map(p => p.media_id)).size !== inputs.length) {
    throw new Error('Classification must contain each requested media ID exactly once')
  }
  return parsed.items.map(item => {
    const input = expected.get(item.media_id)
    if (!input) throw new Error('Unrequested media ID')
    if (item.creative_format !== input.media_type) throw new Error('Format must match media metadata')
    if (new Set(item.secondary_themes).size !== item.secondary_themes.length || item.secondary_themes.includes(item.primary_theme)) throw new Error('Duplicate themes')
    // V1 has no visual or audio source. Do not hallucinate scene/presenter data,
    // even when the model believes a caption implies it.
    if (item.presentation_style !== 'unknown' || item.human_presence !== 'unknown') throw new Error('Visual source unavailable')
    if (!input.caption) return { ...item, hook_type: 'unknown', hook_source: 'unknown', hook_text: null }
    if (item.hook_type === 'unknown') {
      if (item.hook_source !== 'unknown' || item.hook_text !== null) throw new Error('Unknown hook must have unknown source')
    } else if (item.hook_type === 'no_clear_hook') {
      if (item.hook_source !== 'caption' || item.hook_text !== null) throw new Error('No-clear-hook must identify caption source')
    } else if (item.hook_source !== 'caption' || !item.hook_text?.trim() || !input.caption.slice(0, 400).includes(item.hook_text)) {
      throw new Error('Hook must quote available opening caption copy')
    }
    return item
  })
}

export type ClassifierResult = { ok: true; items: Fingerprint[]; model: string } | { ok: false; error: string }
export async function classifyLibrary(options: {
  media: Media[]; existing: FingerprintRow[]; now: Date; force?: boolean
  classify: (inputs: ClassificationInput[]) => Promise<ClassifierResult>
  save: (rows: FingerprintRow[]) => Promise<void>
  heartbeat?: () => Promise<void>
}): Promise<{ counts: ClassificationCounts; fingerprints: FingerprintRow[] }> {
  const existing = new Map(options.existing.map(f => [f.media_id, f]))
  const eligible = eligibleMedia(options.media, options.now)
  const pending = eligible.filter(m => options.force || !existing.has(m.id) || !isCurrentFingerprint(m, existing.get(m.id)!))
  const selected = pending.slice(0, MAX_CLASSIFICATIONS_PER_REFRESH)
  const counts = { eligible: eligible.length, classified: 0, skipped: eligible.length - pending.length, failed: 0, deferred: pending.length - selected.length }
  for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
    // Ownership check is outside the batch catch: a lost refresh lease must stop
    // the run, while a failed provider batch must not discard successful work.
    await options.heartbeat?.()
    const batch = selected.slice(offset, offset + BATCH_SIZE)
    try {
      const inputs = batch.map(classifierInput)
      const result = await options.classify(inputs)
      if (!result.ok) { counts.failed += batch.length; continue }
      const items = validateClassification({ items: result.items }, inputs)
      const rows: FingerprintRow[] = items.map(item => ({ ...item, platform: 'instagram',
        source_hash: sourceHash(batch.find(p => p.id === item.media_id)!), classification_version: CLASSIFICATION_VERSION,
        classified_at: options.now.toISOString(), ai_model: result.model, prompt_version: CLASSIFIER_PROMPT_VERSION }))
      await options.heartbeat?.()
      await options.save(rows) // One atomic upsert per validated batch.
      for (const row of rows) existing.set(row.media_id, row)
      counts.classified += rows.length
    } catch {
      counts.failed += batch.length
    }
  }
  const fingerprints = options.media.flatMap(m => {
    const f = existing.get(m.id)
    return f && isCurrentFingerprint(m, f) ? [f] : []
  })
  return { counts, fingerprints }
}
