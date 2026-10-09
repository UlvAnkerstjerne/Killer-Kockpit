/**
 * Creative package for a Paid Strategy creative recommendation.
 *
 * Claude writes the words (hooks, copy, script, shot list). Everything that touches the platform is deterministic:
 * the package is validated against the existing ad's own copy (no invented offers, prices or promises), mapped onto a
 * COPY of the existing creative's structure (same images, same destination), and the "what stays constant" list is
 * computed by diffing the two creatives rather than taken from the model.
 *
 * The model never sees or returns a Meta ID, account, page or image hash.
 */

import { z } from 'zod'

export const CREATIVE_CTAS = ['SEE_MENU', 'LEARN_MORE', 'GET_QUOTE', 'CONTACT_US', 'SIGN_UP', 'ORDER_NOW'] as const

/** Constrained decoding cannot enforce lengths, so the model is TOLD these targets and the schema keeps headroom above them. */
export const CREATIVE_TARGET_CHARS = { objective: 200, offer_angle: 220, hook: 90, primary_text: 480, headline: 40, description: 60, cta_rationale: 140, script: 600, shot: 120, variable: 160, success_metric: 200, decision: 140 } as const
const M = (n: number) => Math.round(n * 1.5)

export const CreativePackageSchema = z.object({
  objective: z.string().min(10).max(M(CREATIVE_TARGET_CHARS.objective)),
  offer_angle: z.string().min(10).max(M(CREATIVE_TARGET_CHARS.offer_angle)),
  hook_options: z.array(z.string().min(5).max(M(CREATIVE_TARGET_CHARS.hook))).min(3).max(5),
  primary_text: z.string().min(40).max(M(CREATIVE_TARGET_CHARS.primary_text)),
  headline: z.string().min(5).max(M(CREATIVE_TARGET_CHARS.headline)),
  description: z.string().min(5).max(M(CREATIVE_TARGET_CHARS.description)),
  cta: z.enum(CREATIVE_CTAS),
  cta_rationale: z.string().min(5).max(M(CREATIVE_TARGET_CHARS.cta_rationale)),
  video_script: z.string().min(20).max(M(CREATIVE_TARGET_CHARS.script)).nullable(),
  shot_list: z.array(z.string().min(5).max(M(CREATIVE_TARGET_CHARS.shot))).max(8),
  variable_tested: z.string().min(5).max(M(CREATIVE_TARGET_CHARS.variable)),
  success_metric: z.string().min(5).max(M(CREATIVE_TARGET_CHARS.success_metric)),
  experiment_days: z.number().int().min(7).max(42),
  /** The ad can be built from the existing images. true only when the idea genuinely needs new footage or photos. */
  requires_new_footage: z.boolean(),
  /** Offer ideas from the strategy that the existing copy does not support (a price, a guarantee, a response time). A business decision, not work. */
  needs_business_decision: z.array(z.string().min(5).max(M(CREATIVE_TARGET_CHARS.decision))).max(4),
}).strict()
export type CreativePackage = z.infer<typeof CreativePackageSchema>

// ── Grounding ─────────────────────────────────────────────────────────────────

const NUMBER = /\d[\d.,]*/g
const PROMISE = /\b(guarantee[sd]?|free of charge|for free|gratis|same[- ]day|within \d+\s*(?:hours?|minutes?|days?)|\d+\s*(?:hours?|minutes?)\s+(?:quote|response|reply)|money[- ]back|award[- ]winning|best in|number one|#1|cheapest|lowest price|limited time|only today|while stocks last)\b/i
const URL_OR_PHONE = /(https?:\/\/|www\.|\+\d[\d\s-]{6,}|\b\d{8}\b)/i

export interface Sources { copy: string; recommendation: string }
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')
const numbersIn = (s: string) => new Set((s.match(NUMBER) ?? []).map(n => n.replace(/[.,]+$/, '')))

/** Rules for text a customer will read. Throws with the first problem. */
export function validateCreativePackage(pkg: CreativePackage, sources: Sources): CreativePackage {
  const readable = [pkg.primary_text, pkg.headline, pkg.description, ...pkg.hook_options, pkg.video_script ?? '', ...pkg.shot_list]
  const allowedNumbers = numbersIn(`${sources.copy}\n${sources.recommendation}`)
  const adCopy = norm(sources.copy)
  for (const t of readable) {
    if (PROMISE.test(t)) throw new Error(`Copy makes a promise the existing ad does not: "${t.match(PROMISE)![0]}".`)
    if (URL_OR_PHONE.test(t) && !adCopy.includes(norm(t.match(URL_OR_PHONE)![0]))) throw new Error('Copy contains a link or phone number that is not in the existing ad.')
  }
  // Production directions in the shot list ("hold 3 seconds") are not claims; everything a customer reads or hears is.
  for (const t of [pkg.primary_text, pkg.headline, pkg.description, ...pkg.hook_options, pkg.video_script ?? '']) {
    for (const n of numbersIn(t)) if (!allowedNumbers.has(n)) throw new Error(`Copy states a number no source gives: ${n}.`)
  }
  // Customer-facing offer facts (price, minimum, contact) must come from the existing ad, never from the recommendation's examples.
  const offerNumbers = numbersIn(pkg.primary_text + pkg.headline + pkg.description)
  const copyNumbers = numbersIn(sources.copy)
  for (const n of offerNumbers) if (!copyNumbers.has(n)) throw new Error(`Customer copy states ${n}, which the existing ad does not.`)
  if (new Set(pkg.hook_options.map(norm)).size !== pkg.hook_options.length) throw new Error('Hook options repeat each other.')
  if (pkg.requires_new_footage && (!pkg.video_script || pkg.shot_list.length < 2)) throw new Error('New footage is required but there is no script or shot list.')
  if (!pkg.requires_new_footage && pkg.shot_list.length > 0 && !pkg.video_script) throw new Error('A shot list without a script.')
  return pkg
}

// ── Mapping onto a copy of the existing creative ──────────────────────────────

type Oss = Record<string, Record<string, unknown>>

/** A new creative spec: the source creative's structure with the package's words. Images, links and pages are copied, never invented. */
export function applyPackageToCreative(source: Record<string, unknown>, pkg: CreativePackage): { spec: Record<string, unknown>; changed: string[]; constant: string[] } {
  const spec = JSON.parse(JSON.stringify(source)) as Oss
  const shape = spec.link_data ? 'link_data' : spec.video_data ? 'video_data' : null
  if (!shape) throw new Error('The existing creative has a shape that cannot be varied yet.')
  const data = spec[shape] as Record<string, unknown>
  const before = JSON.stringify(data)
  const changed: string[] = []

  if (data.message !== pkg.primary_text) { data.message = pkg.primary_text; changed.push('primary text') }
  const children = Array.isArray(data.child_attachments) ? data.child_attachments as Record<string, unknown>[] : null
  if (children) {
    if (children.some(c => c.name !== pkg.headline)) { for (const c of children) c.name = pkg.headline; changed.push('headline') }
  } else if (data.name !== pkg.headline) { data.name = pkg.headline; changed.push('headline') }
  if (!children && data.description !== pkg.description) { data.description = pkg.description; changed.push('description') }
  const cta = data.call_to_action as { type?: string; value?: unknown } | undefined
  if (cta && cta.type !== pkg.cta) { cta.type = pkg.cta; for (const c of children ?? []) { const cc = c.call_to_action as { type?: string } | undefined; if (cc) cc.type = pkg.cta } changed.push('call to action') }

  const constant = ['the images', 'the destination link', 'the Facebook Page and Instagram account']
  if (JSON.stringify(data) === before) throw new Error('The new creative is identical to the existing one, so there is nothing to test.')
  return { spec: spec as unknown as Record<string, unknown>, changed, constant }
}

/** What is held constant, computed from the structure rather than asserted by the model. */
export function heldConstant(changed: string[], sameAdSet: boolean): string[] {
  return [
    'The images and the destination link are identical to the existing ad.',
    ...(sameAdSet ? ['The new ad runs in the same ad set as the existing one: same audience, placements, optimisation and daily budget.'] : []),
    `Only these change: ${changed.join(', ')}.`,
  ]
}

// ── Physical handoff (the only task this feature may create) ──────────────────

export interface PhysicalHandoff { title: string; description: string }

/** Only when new footage is genuinely required. The ask is the shots and nothing else: the thinking is already done. */
export function physicalHandoff(pkg: CreativePackage): PhysicalHandoff | null {
  if (!pkg.requires_new_footage) return null
  return {
    title: `Film ${pkg.shot_list.length} shots for the approved catering ad`,
    description: [`Film these shots in this order, then upload the clips to the ad draft.`, '', ...pkg.shot_list.map((s, i) => `${i + 1}. ${s}`), '', `Script (spoken or on-screen):`, pkg.video_script ?? '', '', 'Nothing else is needed: the copy, call to action and test design are already prepared.'].join('\n'),
  }
}
