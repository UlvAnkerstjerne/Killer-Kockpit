import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import type { InsightActionContext, InsightActionOptionsResult } from '@/lib/ai/insight-actions'
import type { ImplementRoute } from '@/lib/marketing/insights/actions/eligibility'
import { COUNT_WITH_ROUTE, COUNT_WITHOUT_ROUTE, proposeActions } from '@/lib/marketing/insights/actions/propose'
import { actionRow, memoryActionStore, stamp } from '../../../../helpers/insight-actions'
import { insightView } from '../../../../helpers/insights'

const option = (n: number, kind: 'manual_task' | 'content_brief' = 'manual_task') => ({
  kind, title: `Option ${n} title`, why: 'Because the insight says so.', steps: ['Step one', 'Step two'], success_signal: 'Look at the next analysis.',
  brief: kind === 'content_brief' ? { concept: 'A concept here', hook: 'A hook', key_points: ['Point one', 'Point two'], evidence_basis: 'The evidence.' } : null,
})
const route: ImplementRoute = { runId: 'p1', index: 1, title: 'Try a second catering ad', successMetric: 'A second ad is live and compared', test: 'Create a second ad' }
function setup(result: InsightActionOptionsResult = { ok: true, model: 'synthetic-model', options: [option(1), option(2)] }, seed = [] as ReturnType<typeof actionRow>[]) {
  const m = memoryActionStore(seed)
  const call = vi.fn(async (_c: InsightActionContext, _g: string) => result)
  let n = 0
  const deps = { store: m.store, call, newId: () => `batch-${++n}`, now: () => new Date(stamp(5)) }
  return { m, call, deps }
}
const insight = (over = {}) => insightView({ id: 'ins-1', domain: 'organic', title: 'Process stories draw shares', statement: 'Posts explaining a hidden step were shared more.', evidence_text: 'P1 reached 90,000 views.', limitations: 'Eight videos only.', ...over })

describe('drafting options', () => {
  it('drafts only when asked, storing every option as "proposed" and creating nothing else', async () => {
    const { m, call, deps } = setup()
    const out = await proposeActions(deps, { insight: insight(), actorId: 'u1', route: null })
    expect(out).toMatchObject({ ok: true, reused: false })
    expect(call).toHaveBeenCalledTimes(1)
    expect(m.all()).toHaveLength(2)
    for (const a of m.all()) expect(a).toMatchObject({ status: 'proposed', linked_task_id: null, owner_user_id: null, chosen_at: null, proposed_by_user_id: 'u1', model: 'synthetic-model' })
  })
  it('asks the model for 2-3 options, or 1-2 when the deterministic Paid Strategy route is added (2-3 in total)', async () => {
    const a = setup(); await proposeActions(a.deps, { insight: insight(), actorId: 'u1', route: null })
    expect(a.call.mock.calls[0][0].count).toEqual(COUNT_WITHOUT_ROUTE)
    const b = setup({ ok: true, model: 'm', options: [option(1)] }); await proposeActions(b.deps, { insight: insight({ domain: 'paid' }), actorId: 'u1', route })
    expect(b.call.mock.calls[0][0].count).toEqual(COUNT_WITH_ROUTE)
    expect(b.m.all()).toHaveLength(2)
  })
  it('puts the direct route first, built by code from the recommendation, never attributed to the model', async () => {
    const { m, deps } = setup({ ok: true, model: 'm', options: [option(1)] })
    const out = await proposeActions(deps, { insight: insight({ domain: 'paid' }), actorId: 'u1', route })
    if (!out.ok) throw new Error('expected ok')
    const [first, second] = out.actions
    expect(first).toMatchObject({ kind: 'implement_recommendation', target_run_id: 'p1', target_index: 1, title: route.title, model: null, prompt_version: null, success_signal: route.successMetric })
    expect(first.why).toMatch(/Approve & implement flow\. You still preview and confirm there, and nothing runs until you do/)
    expect(second.kind).toBe('manual_task')
    expect(m.all().filter(a => a.kind === 'implement_recommendation')).toHaveLength(1)
  })
  it('offers content briefs only for organic and creative insights', async () => {
    for (const [domain, expected] of [['organic', ['manual_task', 'content_brief']], ['creative', ['manual_task', 'content_brief']], ['paid', ['manual_task']]] as const) {
      const { call, deps } = setup(); await proposeActions(deps, { insight: insight({ domain }), actorId: 'u1', route: null })
      expect(call.mock.calls[0][0].allowedKinds).toEqual(expected)
    }
  })
  it('grounds the request in the insight and tells the model what was already tried', async () => {
    const tried = actionRow({ id: 'old', status: 'completed', title: 'Review the process posts', outcome: { source: 'task', final_status: 'done', finished_at: stamp(3), insight: { strength: 'weak_signal', trend: 'new', times_observed: 1, last_supported_at: stamp(1) } } })
    const { call, deps } = setup(undefined, [tried])
    await proposeActions(deps, { insight: insight(), actorId: 'u1', route: null })
    const [context, grounding] = call.mock.calls[0]
    expect(context.alreadyTried).toEqual([{ what: 'Review the process posts', status: 'completed' }])
    expect(grounding).toContain('P1 reached 90,000 views.'); expect(grounding).toContain('Eight videos only.')
    expect(context.insight).toMatchObject({ title: 'Process stories draw shares', seen_in_runs: 1 })
  })
  it('reuses existing drafts without another model call, unless fresh options are asked for', async () => {
    const { m, call, deps } = setup(undefined, [actionRow({ id: 'a1' }), actionRow({ id: 'a2', batch_id: 'batch-1', title: 'Another' })])
    const out = await proposeActions(deps, { insight: insight(), actorId: 'u1', route: null })
    expect(out).toMatchObject({ ok: true, reused: true }); expect(call).not.toHaveBeenCalled(); expect(m.all()).toHaveLength(2)
  })
  it('a fresh draft replaces the old ones (kept as "superseded") only AFTER a successful draft', async () => {
    const { m, deps } = setup(undefined, [actionRow({ id: 'a1' })])
    await proposeActions(deps, { insight: insight(), actorId: 'u1', route: null, redraft: true })
    expect(m.rows.get('a1')!.status).toBe('superseded')
    expect(m.all().filter(a => a.status === 'proposed')).toHaveLength(2)
    const failing = setup({ ok: false, error: 'Options could not be drafted. Please try again.' }, [actionRow({ id: 'keep' })])
    expect(await proposeActions(failing.deps, { insight: insight(), actorId: 'u1', route: null, redraft: true })).toEqual({ ok: false, error: 'Options could not be drafted. Please try again.' })
    expect(failing.m.rows.get('keep')!.status).toBe('proposed') // a failed request leaves the earlier drafts alone
    expect(failing.m.all()).toHaveLength(1)
  })
  it('never replaces or hides what was chosen, tried or finished', async () => {
    const { m, deps } = setup(undefined, [actionRow({ id: 'c', status: 'chosen', chosen_at: stamp(2) })])
    await proposeActions(deps, { insight: insight(), actorId: 'u1', route: null })
    expect(m.rows.get('c')!.status).toBe('chosen')
  })
})
