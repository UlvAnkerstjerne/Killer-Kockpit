/**
 * Turns what the specialist analyses already produced into insight candidates. PURE: no database, no model.
 *
 * Nothing here asks a model anything new. Each source already separates evidence, interpretation and suggestion; this only
 * keeps the parts that are conclusions, with their sources, and leaves the actions to the strategies that own them.
 *
 *   Creative Intelligence  -> findings (Insight.take), stable key = the signal ids the conclusion rests on
 *   Organic Strategy       -> findings (main_learnings) and content opportunities (content_opportunities)
 *   Paid Strategy          -> findings (interpretation) and retargeting hypotheses (hypothesis of a retargeting rec)
 *
 * NOT extracted, on purpose: Reel and carousel concepts (concrete things to make: recommendations, not conclusions),
 * deterministic signals (kept distinct: they are inputs), and Morning Brief observations (a daily operational read that
 * the brief itself owns; it reads insights, it does not create them).
 */

import { isInsight, type CreativePost, type CreativeRun, type CreativeSignal } from '@/lib/marketing/brain/types'
import type { EvidenceStrength, OrganicStrategyPostRef, OrganicStrategyStored } from '@/lib/marketing/organic-strategy/types'
import type { PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'
import { clip, headline } from './text'
import { STRENGTH_RANK, type InsightCandidate, type InsightStrength, type RunExtraction, type SourceRef } from './types'

const ORGANIC_STRENGTH: Record<EvidenceStrength, InsightStrength> = {
  proven_pattern: 'strong_pattern', reasonable_inference: 'reasonable_inference', weak_signal: 'weak_signal',
}
/** A creative signal needs 8 posts on both sides to be "supported"; that is an inference, never a proven pattern. */
const CREATIVE_STRENGTH: Record<CreativeSignal['evidence_level'], InsightStrength> = {
  supported: 'reasonable_inference', emerging: 'weak_signal', individual: 'weak_signal',
}
const MAX_POST_REFS = 6

function weakest(strengths: InsightStrength[]): InsightStrength {
  return strengths.reduce<InsightStrength>((low, s) => (STRENGTH_RANK[s] < STRENGTH_RANK[low] ? s : low), strengths[0] ?? 'weak_signal')
}

// ── Creative Intelligence (+ the Organic Strategy stored inside the same run) ───────────────────────────────

export function extractFromCreativeRun(run: CreativeRun): RunExtraction {
  const candidates: InsightCandidate[] = []
  const observedAt = run.generated_at
  const analytics = run.analytics
  const postsById = new Map((analytics?.posts ?? []).map(p => [p.id, p]))
  const signalsById = new Map(run.signals.map(s => [s.id, s]))

  let creativeCovered = false
  for (const observation of run.observations ?? []) {
    if (!isInsight(observation)) continue // legacy v1 one-signal observations are not conclusions about a pattern
    const signals = observation.signal_ids.map(id => signalsById.get(id)).filter((s): s is CreativeSignal => !!s)
    if (!signals.length) continue
    creativeCovered = true
    const ids = [...observation.signal_ids].sort()
    candidates.push({
      domain: 'creative', kind: 'finding', scope_key: 'creative:finding', stable_key: `creative:${ids.join('|')}`,
      title: clip(observation.headline, 300) ?? headline(observation.take),
      statement: clip(observation.take, 2000) ?? observation.headline,
      evidence_text: clip(signals.map(s => `${s.comparison} (${s.sample_size} posts vs ${s.comparison_sample_size})`).join(' · '), 2000),
      limitations: null,
      suggestion: clip(observation.next_move, 1500),
      strength: weakest(signals.map(s => CREATIVE_STRENGTH[s.evidence_level] ?? 'weak_signal')),
      refs: [
        ...signals.map<SourceRef>(s => ({ type: 'creative_signal', signal_id: s.id, sample_size: s.sample_size, evidence_level: s.evidence_level })),
        ...postRefs(signals.flatMap(s => s.supporting_media_ids), postsById),
      ],
      recommendation_index: null,
    })
  }
  // A completed run with no insight is a real "nothing reached the bar"; a partial run may simply have lost its interpretation.
  creativeCovered ||= run.status === 'completed'

  const organic = analytics?.organic_strategy
  const organicCandidates = organic ? extractFromOrganic(organic) : null
  if (organicCandidates) candidates.push(...organicCandidates)

  return {
    sourceKind: 'creative_run', runId: run.id, observedAt, candidates,
    coverage: { creative: creativeCovered, organic: !!organicCandidates },
  }
}

function postRefs(mediaIds: string[], postsById: Map<string, CreativePost>): SourceRef[] {
  const seen = new Set<string>()
  const refs: SourceRef[] = []
  for (const id of mediaIds) {
    const post = postsById.get(id)
    if (!post || seen.has(id)) continue
    seen.add(id)
    refs.push({ type: 'instagram_post', ref: null, permalink: post.permalink, published_at: post.published_at, media_type: post.format })
    if (refs.length >= MAX_POST_REFS) break
  }
  return refs
}

/** Null when Organic Strategy did not complete: its absence then says nothing about earlier insights. */
export function extractFromOrganic(stored: OrganicStrategyStored): InsightCandidate[] | null {
  if (stored.status !== 'completed' || !stored.output) return null
  const byRef = new Map(stored.posts.map(p => [p.ref, p]))
  const candidates: InsightCandidate[] = []
  for (const learning of stored.output.main_learnings) {
    candidates.push({
      domain: 'organic', kind: 'finding', scope_key: 'organic:finding', stable_key: null,
      title: clip(learning.title, 300) ?? headline(learning.interpretation),
      statement: clip(learning.interpretation, 2000) ?? learning.title,
      evidence_text: clip(learning.evidence, 2000), limitations: clip(learning.limitations, 1500), suggestion: null,
      strength: ORGANIC_STRENGTH[learning.evidence_strength], refs: citedPosts(`${learning.evidence} ${learning.interpretation}`, byRef),
      recommendation_index: null,
    })
  }
  for (const opportunity of stored.output.content_opportunities) {
    candidates.push({
      domain: 'organic', kind: 'content_opportunity', scope_key: 'organic:content_opportunity', stable_key: null,
      title: clip(opportunity.title, 300) ?? headline(opportunity.why_now),
      statement: clip(opportunity.why_now, 2000) ?? opportunity.title,
      evidence_text: clip(opportunity.evidence_basis, 2000), limitations: null, suggestion: clip(opportunity.suggested_angle, 1500),
      strength: ORGANIC_STRENGTH[opportunity.evidence_strength], refs: citedPosts(opportunity.evidence_basis, byRef),
      recommendation_index: null,
    })
  }
  return candidates
}

/** Resolve the P1/U2 refs a statement cites to the stored permalinks. B refs are company notes, not posts. */
function citedPosts(text: string, byRef: Map<string, OrganicStrategyPostRef>): SourceRef[] {
  const refs: SourceRef[] = []
  const seen = new Set<string>()
  for (const [, letter, n] of text.matchAll(/\b([PU])(\d{1,3})\b/g)) {
    const key = `${letter}${n}`
    const post = byRef.get(key)
    if (!post || seen.has(key)) continue
    seen.add(key)
    refs.push({ type: 'instagram_post', ref: key, permalink: post.permalink, published_at: post.published_at, media_type: post.media_type })
    if (refs.length >= MAX_POST_REFS) break
  }
  return refs
}

// ── Paid Strategy ───────────────────────────────────────────────────────────────────────────────────────────

export function extractFromPaidRun(run: PaidStrategyRun): RunExtraction {
  const candidates: InsightCandidate[] = []
  run.recommendations.forEach((rec, index) => {
    const retargeting = rec.recommendation_type === 'retargeting'
    // A retargeting recommendation carries a hypothesis worth remembering as one; every other recommendation carries an
    // interpretation (what the facts might mean). The action stays with the recommendation; only the conclusion is kept.
    const statement = clip(retargeting ? rec.hypothesis : rec.interpretation, 2000)
    if (!statement) return
    const kind = retargeting ? 'retargeting_hypothesis' : 'finding'
    candidates.push({
      domain: 'paid', kind, scope_key: `paid:${kind}:${rec.recommendation_type}`, stable_key: null,
      title: headline(statement), statement,
      evidence_text: clip(rec.evidence, 2000), limitations: clip(rec.evidence_limitations, 1500), suggestion: null,
      strength: 'hypothesis',
      refs: [{ type: 'paid_strategy_run', run_id: run.id, index, window_start: run.window_start, window_end: run.window_end }],
      recommendation_index: index,
    })
  })
  return {
    sourceKind: 'paid_strategy_run', runId: run.id, observedAt: run.generated_at, candidates,
    // A completed run with no recommendations found nothing worth recommending; that does not refute earlier conclusions.
    coverage: { paid: run.status === 'completed' && run.recommendations.length > 0 },
  }
}
