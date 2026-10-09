/** Small, deterministic text helpers for matching and display. No model calls, no randomness. */

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'it', 'its',
  'this', 'that', 'as', 'at', 'by', 'from', 'than', 'then', 'but', 'not', 'no', 'we', 'our', 'you', 'your', 'can', 'could', 'may', 'might',
  'one', 'more', 'most', 'has', 'have', 'had', 'so', 'if', 'which', 'who', 'what', 'when', 'how', 'also', 'do', 'does', 'did', 'their', 'them'])

/** Light stemming: enough that "tracking"/"tracked"/"tracks" meet, not enough to merge unrelated words. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1')
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/[^a-z0-9æøå\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue
    out.add(stem(raw))
  }
  return out
}

/** 0..1. Blends Jaccard with containment so a short restatement of a long statement still matches. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  const jaccard = shared / (ta.size + tb.size - shared)
  const containment = shared / Math.min(ta.size, tb.size)
  return Math.round((0.6 * jaccard + 0.4 * containment) * 1000) / 1000
}

/** First sentence, capped. Used where a source gives a statement but no headline. */
export function headline(text: string, max = 110): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const end = clean.search(/[.!?](\s|$)/)
  const first = end > 0 ? clean.slice(0, end) : clean
  if (first.length <= max) return first
  const cut = first.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`
}

export function clip(text: string | null | undefined, max: number): string | null {
  if (text == null) return null
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}
