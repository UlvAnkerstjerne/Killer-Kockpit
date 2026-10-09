import type { CreativeRun } from '@/lib/marketing/brain/types'
import type { InsightStore } from '@/lib/marketing/insights/capture'
import type {
  InsightCandidate, InsightInsert, InsightPatch, InsightRow, InsightSourceKind, LinkRow, ObservationRow, RunExtraction,
} from '@/lib/marketing/insights/types'
import type { InsightView } from '@/lib/marketing/insights/view'
import type { OrganicStrategyOutput } from '@/lib/marketing/organic-strategy/types'
import type { PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'
import { currentRun } from './creative-brain'
import { storedStrategy, validOutput } from './organic-strategy'
import { run as paidRun } from './paid-strategy'
import { NEW_RECS } from './paid-strategy-real-recs'

export const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9, 0, 0)).toISOString()

export function candidate(over: Partial<InsightCandidate> = {}): InsightCandidate {
  return {
    domain: 'organic', kind: 'finding', scope_key: 'organic:finding', stable_key: null,
    title: 'Process stories draw shares', statement: 'Posts that explain a hidden preparation step were shared more than product-only posts.',
    evidence_text: 'P1 and P2 were shared more often than the median video.', limitations: 'Eight measured videos only.', suggestion: null,
    strength: 'reasonable_inference', refs: [], recommendation_index: null, ...over,
  }
}

export function extraction(over: Partial<RunExtraction> & { candidates?: InsightCandidate[] } = {}): RunExtraction {
  return { sourceKind: 'creative_run', runId: 'run-1', observedAt: day(1), candidates: [candidate()], coverage: { organic: true }, ...over }
}

export function insightRow(over: Partial<InsightRow> = {}): InsightRow {
  return {
    id: 'ins-1', domain: 'organic', kind: 'finding', scope_key: 'organic:finding', stable_key: null,
    title: 'Process stories draw shares', statement: 'Posts that explain a hidden preparation step were shared more than product-only posts.',
    evidence_text: null, limitations: null, suggestion: null, strength: 'reasonable_inference', peak_strength: 'reasonable_inference',
    trend: 'new', status: 'active', times_observed: 1, runs_since_seen: 0, first_seen_at: day(1), last_seen_at: day(1), last_supported_at: day(1),
    last_source_run_id: 'run-0', refs: [], created_at: day(1), updated_at: day(1), ...over,
  }
}

export function insightView(over: Partial<InsightView> = {}): InsightView {
  return { ...insightRow(), history: [], links: [], ...over }
}

/** In-memory InsightStore with the same observable behaviour the Supabase repo has (ids, unique observations and links). */
export function memoryStore(seed: InsightRow[] = []) {
  const insights = new Map<string, InsightRow>(seed.map(r => [r.id, r]))
  const observations: ObservationRow[] = []
  const links: LinkRow[] = []
  let seq = 0
  const failOn = new Set<string>()
  const guard = (op: string) => { if (failOn.has(op)) { failOn.delete(op); throw new Error(`boom:${op}`) } }
  const store: InsightStore = {
    async listInsights(domains) { return [...insights.values()].filter(r => domains.includes(r.domain)).map(r => ({ ...r })) },
    async hasObservations(kind: InsightSourceKind, runId: string) { return observations.some(o => o.source_kind === kind && o.source_run_id === runId) },
    async insertInsight(row: InsightInsert) {
      guard('insertInsight')
      const id = `ins-${++seq}`
      insights.set(id, { ...row, id, created_at: row.first_seen_at, updated_at: row.first_seen_at })
      return id
    },
    async updateInsight(id: string, patch: InsightPatch) { guard('updateInsight'); insights.set(id, { ...insights.get(id)!, ...patch }) },
    async insertObservations(rows: ObservationRow[]) {
      guard('insertObservations')
      for (const r of rows) if (!observations.some(o => o.insight_id === r.insight_id && o.source_kind === r.source_kind && o.source_run_id === r.source_run_id)) observations.push(r)
    },
    async insertLinks(rows: LinkRow[]) {
      guard('insertLinks')
      for (const r of rows) if (!links.some(l => l.insight_id === r.insight_id && l.target_type === r.target_type && l.target_run_id === r.target_run_id && l.target_index === r.target_index && l.relation === r.relation)) links.push(r)
    },
  }
  return { store, insights, observations, links, failOn, all: () => [...insights.values()] }
}

export function creativeRunAt(id: string, at: string, organic: Partial<OrganicStrategyOutput> | null = {}): CreativeRun {
  const base = currentRun()
  const analytics = organic === null ? base.analytics! : { ...base.analytics!, organic_strategy: storedStrategy({ output: validOutput(organic) }) }
  return { ...base, id, generated_at: at, analytics }
}

export function paidRunAt(id: string, at: string, recs = NEW_RECS): PaidStrategyRun {
  const r = paidRun({ id, generated_at: at }); r.recommendations = recs as never
  return r
}
