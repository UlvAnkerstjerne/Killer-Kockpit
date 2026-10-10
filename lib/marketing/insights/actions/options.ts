/**
 * Checks drafted options before anything is stored or shown. PURE. Conservative, not proof of correctness: it rejects what is
 * clearly ungrounded (invented figures, promises, audience claims, links, claims that Kockpit will film or publish).
 */

import type { ActionBrief, DraftedKind } from './types'

export class ActionOptionsValidationError extends Error {}

export interface OptionContext {
  allowedKinds: DraftedKind[]
  min: number
  max: number
  /** Everything the model was shown about the insight. A figure in an option must appear here. */
  sourceText: string
}
export interface ValidatedOption { kind: DraftedKind; title: string; why: string; steps: string[]; success_signal: string; brief: ActionBrief | null }

const URL_OR_HANDLE = /(https?:\/\/|www\.|\b[\w.-]+\.(com|dk|io|org|net)\b|@\w{2,})/i
const LONG_ID = /\b\d{9,}\b/
const PROMISE = /\b(will|would|going to|guarantee[sd]?|ensure[sd]?)\b[^.]{0,40}\b(increase|boost|improve|double|triple|grow|drive|raise|lift|win|work|convert|sell|succeed)\b|\bguarantee/i
const KOCKPIT_DOES_IT = /\bkockpit\b[^.]{0,60}\b(will|can|could|to|then|automatically)\b[^.]{0,40}\b(film|shoot|record|produce|make|publish|post|schedule|upload|launch|send|run|create|build|buy|change)\b/i
const DEMOGRAPHICS = /\b(women|men|female|male|ages?|aged|millennials?|gen ?z|boomers?|teenagers?|students?|parents)\b/i
const FIGURE = /\b(\d[\d,]*(?:\.\d+)?)\s?(k|m|%)?/gi

function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(FIGURE)) {
    const raw = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(raw)) continue
    out.push(m[2]?.toLowerCase() === 'k' ? raw * 1e3 : m[2]?.toLowerCase() === 'm' ? raw * 1e6 : raw)
  }
  return out
}
/** Small numbers (counts of steps, "2 or 3") and years are ordinary language; anything bigger must come from the insight. */
function ungroundedFigures(text: string, known: number[]): string[] {
  const bad: string[] = []
  for (const m of text.matchAll(FIGURE)) {
    const raw = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(raw)) continue
    const value = m[2]?.toLowerCase() === 'k' ? raw * 1e3 : m[2]?.toLowerCase() === 'm' ? raw * 1e6 : raw
    if (!m[2] && (value <= 12 || (value >= 2020 && value <= 2030))) continue
    if (!known.some(n => Math.abs(n - value) <= Math.max(0.06, 0.01 * Math.abs(n)))) bad.push(m[0].trim())
  }
  return bad
}

function textFields(o: { title: string; why: string; steps: string[]; success_signal: string; brief: ActionBrief | null }): { where: string; text: string }[] {
  return [
    { where: 'title', text: o.title }, { where: 'why', text: o.why }, { where: 'success_signal', text: o.success_signal },
    ...o.steps.map((s, i) => ({ where: `steps[${i}]`, text: s })),
    ...(o.brief ? [
      { where: 'brief.concept', text: o.brief.concept }, { where: 'brief.hook', text: o.brief.hook }, { where: 'brief.evidence_basis', text: o.brief.evidence_basis },
      ...o.brief.key_points.map((p, i) => ({ where: `brief.key_points[${i}]`, text: p })),
    ] : []),
  ]
}

export function validateActionOptions(raw: unknown, ctx: OptionContext): ValidatedOption[] {
  const options = (raw as { options?: ValidatedOption[] } | null)?.options
  if (!Array.isArray(options)) throw new ActionOptionsValidationError('No options returned.')
  if (options.length < ctx.min || options.length > ctx.max) throw new ActionOptionsValidationError(`Expected ${ctx.min}-${ctx.max} options, got ${options.length}.`)
  const known = numbersIn(ctx.sourceText)
  const titles = new Set<string>()
  options.forEach((o, i) => {
    if (!ctx.allowedKinds.includes(o.kind)) throw new ActionOptionsValidationError(`options[${i}]: kind ${o.kind} is not allowed for this insight.`)
    if (o.kind === 'content_brief' && !o.brief) throw new ActionOptionsValidationError(`options[${i}]: a content brief needs its brief.`)
    if (o.kind === 'manual_task' && o.brief) throw new ActionOptionsValidationError(`options[${i}]: only a content brief carries a brief.`)
    const key = o.title.trim().toLowerCase()
    if (titles.has(key)) throw new ActionOptionsValidationError(`options[${i}]: duplicate title.`)
    titles.add(key)
    for (const { where, text } of textFields(o)) {
      const at = `options[${i}].${where}`
      if (URL_OR_HANDLE.test(text)) throw new ActionOptionsValidationError(`${at}: link or handle.`)
      if (LONG_ID.test(text)) throw new ActionOptionsValidationError(`${at}: identifier.`)
      if (PROMISE.test(text)) throw new ActionOptionsValidationError(`${at}: promises a result.`)
      if (KOCKPIT_DOES_IT.test(text)) throw new ActionOptionsValidationError(`${at}: implies Kockpit does the work itself.`)
      if (DEMOGRAPHICS.test(text)) throw new ActionOptionsValidationError(`${at}: audience or demographic claim; no such data exists.`)
      const bad = ungroundedFigures(text, known)
      if (bad.length) throw new ActionOptionsValidationError(`${at}: figure not in the insight (${bad.join(', ')}).`)
    }
  })
  return options
}
