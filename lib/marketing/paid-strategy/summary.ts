/**
 * Deterministic compact summary of a stored Paid Strategy recommendation, for the collapsed card.
 *
 * No model call and no new stored field: it only picks sentences out of text that already exists
 * (what to do from exact_test_or_action, why from evidence, falling back to interpretation).
 * The full text is always available behind "Read more" and is never altered.
 */

import type { PaidStrategyRecommendation } from './types'

type Source = Pick<PaidStrategyRecommendation, 'title' | 'evidence' | 'interpretation' | 'exact_test_or_action'>

const MAX_SENTENCE = 230
const MIN_USEFUL = 30
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'by', 'at', 'is', 'are', 'be', 'that', 'this', 'it', 'as', 'new', 'test', 'create', 'launch', 'run'])

/** Sentence boundaries: end punctuation, whitespace, then something that starts a sentence. Decimals and "(V2)." style tokens stay intact. */
export function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').replace(/\s*\(small_sample=\w+\)/g, '').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/).map(s => s.trim()).filter(Boolean)
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !STOP.has(w))

/** Share of the smaller word set that the two texts have in common. */
function overlap(a: string, b: string): number {
  const x = new Set(words(a)); const y = new Set(words(b))
  if (!x.size || !y.size) return 0
  let hit = 0
  for (const w of x) if (y.has(w)) hit++
  return hit / Math.min(x.size, y.size)
}

/** Shorten at a clause or word boundary, never mid-word. Only used when a single sentence is unusually long. */
function clip(sentence: string): string {
  if (sentence.length <= MAX_SENTENCE) return sentence
  const head = sentence.slice(0, MAX_SENTENCE)
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' – '), head.lastIndexOf(' - '))
  const cut = clause > MAX_SENTENCE * 0.5 ? head.slice(0, clause) : head.slice(0, head.lastIndexOf(' '))
  return `${cut.replace(/[\s,;:–-]+$/, '')}…`
}

const withStop = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`)

/** First useful sentence of a text: skips fragments, and anything that only repeats `avoid`. */
function firstUseful(text: string, avoid: string[] = [], fallback = true): string | null {
  const sentences = splitSentences(text)
  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i]
    if (s.length < MIN_USEFUL && sentences[i + 1]) { s = `${s} ${sentences[i + 1]}`; i++ }
    if (avoid.some(a => overlap(s, a) >= 0.75)) continue
    return withStop(clip(s))
  }
  return fallback && sentences[0] ? withStop(clip(sentences[0])) : null
}

export interface CompactSummary { action: string | null; reason: string | null }

/** What to do (without repeating the title) and the strongest stated reason (a fact from our data before an inference). */
export function compactSummary(rec: Source): CompactSummary {
  const action = firstUseful(rec.exact_test_or_action, [rec.title])
  const avoid = action ? [action, rec.title] : [rec.title]
  const reason = firstUseful(rec.evidence, avoid, false) ?? firstUseful(rec.interpretation, avoid, false) ?? firstUseful(rec.evidence)
  return { action, reason }
}
