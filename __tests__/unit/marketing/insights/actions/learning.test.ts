import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { ORGANIC_RULES, ORGANIC_STRATEGY_PROMPT_VERSION } from '@/lib/ai/organic-strategy'
import { KOCKPIT_RULES, PAID_STRATEGY_PROMPT_VERSION } from '@/lib/ai/paid-strategy'
import { loadPriorInsights, MAX_PRIOR_ACTIONS_PER_INSIGHT, priorInsightsEvidence, type PriorInsightInput } from '@/lib/marketing/insights/prior'
import { stamp } from '../../../../helpers/insight-actions'

const done = { source: 'task' as const, final_status: 'done', finished_at: stamp(7), insight: { strength: 'reasonable_inference', trend: 'steady', times_observed: 2, last_supported_at: stamp(4) } }
const prior = (over: Partial<PriorInsightInput> = {}): PriorInsightInput => ({ id: 'i1', kind: 'finding', statement: 'Process stories draw shares', strength: 'reasonable_inference', trend: 'steady', times_observed: 2, first_seen_at: stamp(1), last_supported_at: stamp(4), ...over })
const text = (v: string, max: number) => `DATA:${v.slice(0, max)}`
const action = (over = {}) => ({ title: 'Review the process posts P2', kind: 'manual_task' as const, status: 'completed' as const, chosen_at: stamp(5), completed_at: stamp(7), outcome: done, ...over })

describe('what people did is in front of the next analysis', () => {
  it('adds actions_taken only when there are some, so everything else is exactly as before', () => {
    expect(priorInsightsEvidence([prior()], text)!.items[0]).not.toHaveProperty('actions_taken')
    expect(priorInsightsEvidence([prior({ actions: [] })], text)!.items[0]).not.toHaveProperty('actions_taken')
  })
  it('says what was done, in plain states, with dates, neutralised refs and untrusted labelling', () => {
    const [item] = priorInsightsEvidence([prior({ actions: [action(), action({ title: 'Brief a reel', kind: 'content_brief', status: 'chosen', completed_at: null, outcome: null }), action({ title: 'Stopped idea', status: 'abandoned' })].slice(0, 3) })], text)!.items
    const taken = (item as { actions_taken: { what: string; state: string; started_on: string | null; finished_on: string | null }[] }).actions_taken
    expect(taken).toHaveLength(3)
    expect(taken[0]).toMatchObject({ what: 'DATA:Review the process posts a post', kind: 'manual_task', state: 'completed', started_on: stamp(5).slice(0, 10), finished_on: stamp(7).slice(0, 10) })
    expect(taken.map(t => t.state)).toEqual(['completed', 'in_progress', 'stopped'])
  })
  it('compares the insight now with how it looked when the action finished, as observation only', () => {
    const since = (current: Partial<PriorInsightInput>) => (priorInsightsEvidence([prior({ ...current, actions: [action()] })], text)!.items[0] as { actions_taken: { insight_since: string | null }[] }).actions_taken[0].insight_since
    expect(since({ strength: 'strong_pattern', times_observed: 3 })).toBe('strengthened')
    expect(since({ strength: 'weak_signal', times_observed: 3 })).toBe('weakened')
    expect(since({ strength: 'reasonable_inference', times_observed: 4 })).toBe('unchanged')
    expect(since({ strength: 'strong_pattern', times_observed: 2 })).toBe('not_yet_reobserved')
  })
  it('an unfinished action has no result yet, and no identifiers or task details ever leave', () => {
    const json = JSON.stringify(priorInsightsEvidence([prior({ actions: [action({ status: 'chosen', completed_at: null, outcome: null })] })], text))
    expect(json).toContain('"insight_since":null'); expect(json).not.toMatch(/linked_task|task_id|"id"|uuid|"outcome"|owner|final_status/i)
  })
  it('loads the most recent actions for the insights it picked, a few each, and a failure only costs that context', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ insight_id: 'i1', title: `Action ${i}`, kind: 'manual_task', status: 'completed', chosen_at: stamp(5 - i), completed_at: stamp(6), outcome: done }))
    const mk = (actionsResult: { data: unknown; error: unknown } | 'throw') => ({ from: (t: string) => {
      const q: Record<string, unknown> = {}
      for (const k of ['select', 'in', 'eq', 'order']) q[k] = () => q
      q.limit = async () => (t === 'marketing_insights' ? { data: [prior()], error: null } : actionsResult === 'throw' ? Promise.reject(new Error('x')) : actionsResult)
      return q
    } })
    const [one] = await loadPriorInsights(mk({ data: rows, error: null }) as never, ['paid'])
    expect(one.actions).toHaveLength(MAX_PRIOR_ACTIONS_PER_INSIGHT); expect(one.actions![0].title).toBe('Action 0')
    expect((await loadPriorInsights(mk({ data: null, error: { code: 'x' } }) as never, ['paid']))[0].actions).toBeUndefined()
    expect((await loadPriorInsights(mk('throw') as never, ['paid']))[0]).toMatchObject({ id: 'i1' })
  })
})

describe('the models are told how to treat it', () => {
  it('both prompts say a completed action is not proof, that insight_since is observation, and not to repeat what was done', () => {
    for (const rules of [KOCKPIT_RULES, ORGANIC_RULES]) {
      expect(rules).toContain('actions_taken'); expect(rules).toMatch(/NOT proof that it worked/); expect(rules).toMatch(/observation, never cause/)
      expect(rules).toMatch(/Do not credit an action for a change/)
    }
    expect(KOCKPIT_RULES).toMatch(/do not recommend again something already completed/)
    expect(ORGANIC_RULES).toMatch(/do not propose again what was already done/)
  })
  it('bumps both prompt versions', () => {
    expect(PAID_STRATEGY_PROMPT_VERSION).toBe('2026-10-14-v11'); expect(ORGANIC_STRATEGY_PROMPT_VERSION).toBe('2026-10-14-v5')
  })
})
