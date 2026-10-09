/**
 * Which insights deserve a place on the Morning Brief. The Brief is a daily read, so an insight appears only when it is
 *   - behind a recommendation the CMO section is asking for a decision on right now AND it has recurred across analyses (a first-time
 *     insight behind a recommendation only restates that recommendation, which is already on the page), or
 *   - important: a strong repeated pattern that is new or gaining support, or an established insight that is losing support, or
 *   - new this week and at least a reasonable inference.
 * Weak signals and untested hypotheses never appear on their own. Stale insights never appear. At most three.
 * PURE: the caller supplies the data and the clock.
 */

import type { CmoBriefData } from '@/lib/marketing/paid-strategy/implementation/surface'
import type { InsightView } from './view'
import { STRENGTH_RANK } from './types'

export const MAX_BRIEF_INSIGHTS = 3
const NEW_WINDOW_DAYS = 7
const LOSING_SUPPORT_WINDOW_DAYS = 14
const DAY_MS = 86_400_000

export type BriefInsightReason = 'decision' | 'important' | 'new'
export interface BriefInsight { insight: InsightView; reason: BriefInsightReason; label: string }

const ageDays = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY_MS

export function selectBriefInsights(insights: InsightView[] | null | undefined, cmo: CmoBriefData | null | undefined, now: Date): BriefInsight[] {
  if (!insights?.length) return []
  const openIndex = new Map((cmo?.items ?? []).map(item => [item.index, item]))
  const picked: BriefInsight[] = []
  for (const insight of insights) {
    if (insight.status !== 'active') continue
    const behind = cmo ? insight.links.find(l => l.relation === 'derived_from' && l.target_type === 'paid_strategy_recommendation'
      && l.target_run_id === cmo.run.id && l.target_index !== null && openIndex.has(l.target_index)) : undefined
    if (behind && behind.target_index !== null && insight.times_observed >= 2) { picked.push({ insight, reason: 'decision', label: `Behind recommendation ${behind.target_index + 1}` }); continue }
    const rank = STRENGTH_RANK[insight.strength]
    if (insight.strength === 'strong_pattern' && (insight.trend === 'new' || insight.trend === 'strengthening') && ageDays(insight.last_seen_at, now) <= LOSING_SUPPORT_WINDOW_DAYS) {
      picked.push({ insight, reason: 'important', label: insight.trend === 'new' ? 'New strong pattern' : 'Gaining support' }); continue
    }
    if (insight.trend === 'weakening' && STRENGTH_RANK[insight.peak_strength] >= 2 && ageDays(insight.last_seen_at, now) <= LOSING_SUPPORT_WINDOW_DAYS) {
      picked.push({ insight, reason: 'important', label: 'Losing support' }); continue
    }
    if (insight.times_observed === 1 && rank >= 2 && ageDays(insight.first_seen_at, now) <= NEW_WINDOW_DAYS) {
      picked.push({ insight, reason: 'new', label: 'New this week' })
    }
  }
  const order: Record<BriefInsightReason, number> = { decision: 0, important: 1, new: 2 }
  return picked
    .sort((a, b) => order[a.reason] - order[b.reason] || STRENGTH_RANK[b.insight.strength] - STRENGTH_RANK[a.insight.strength]
      || Date.parse(b.insight.last_seen_at) - Date.parse(a.insight.last_seen_at))
    .slice(0, MAX_BRIEF_INSIGHTS)
}
