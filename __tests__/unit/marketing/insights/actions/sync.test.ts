import { describe, expect, it, vi } from 'vitest'
import { syncActionResults, type SyncDeps } from '@/lib/marketing/insights/actions/sync'
import { insightSinceAction } from '@/lib/marketing/insights/actions/result'
import { actionRow, memoryActionStore, stamp } from '../../../../helpers/insight-actions'

const chosen = (over = {}) => actionRow({ status: 'chosen', chosen_at: stamp(2), linked_task_id: 't1', ...over })
function setup(seed: ReturnType<typeof actionRow>[], state: { tasks?: any[]; impls?: any[]; insights?: any[] } = {}) {
  const m = memoryActionStore(seed)
  const deps: SyncDeps = {
    store: m.store,
    readTasks: vi.fn(async () => state.tasks ?? []), readImplementations: vi.fn(async () => state.impls ?? []),
    readInsights: vi.fn(async () => state.insights ?? [{ id: 'ins-1', strength: 'reasonable_inference', trend: 'steady', times_observed: 3, last_supported_at: stamp(4) }]),
  }
  return { m, deps }
}
const task = (status: string, over = {}) => ({ id: 't1', status, completed_at: null, approved_at: null, updated_at: stamp(6), ...over })

describe('recording how chosen actions ended', () => {
  it('records a finished task as completed, with when it finished and what the insight looked like then', async () => {
    const { m, deps } = setup([chosen()], { tasks: [task('done', { completed_at: stamp(7) })] })
    expect(await syncActionResults(deps)).toEqual({ completed: 1, abandoned: 0 })
    expect(m.rows.get('act-1')).toMatchObject({ status: 'completed', completed_at: stamp(7), outcome: { source: 'task', final_status: 'done', finished_at: stamp(7), insight: { strength: 'reasonable_inference', trend: 'steady', times_observed: 3, last_supported_at: stamp(4) } } })
  })
  it('records a cancelled task as stopped', async () => {
    const { m, deps } = setup([chosen()], { tasks: [task('cancelled')] })
    expect(await syncActionResults(deps)).toEqual({ completed: 0, abandoned: 1 })
    expect(m.rows.get('act-1')).toMatchObject({ status: 'abandoned', outcome: { final_status: 'cancelled' } })
  })
  it('leaves work that is not over alone: open, in progress, blocked, waiting for review', async () => {
    for (const status of ['proposed', 'open', 'in_progress', 'blocked', 'pending_review']) {
      const { m, deps } = setup([chosen()], { tasks: [task(status)] })
      expect(await syncActionResults(deps)).toEqual({ completed: 0, abandoned: 0 }); expect(m.rows.get('act-1')!.status).toBe('chosen')
    }
  })
  it('leaves an action alone when its task cannot be found', async () => {
    const { m, deps } = setup([chosen()], { tasks: [] })
    expect(await syncActionResults(deps)).toEqual({ completed: 0, abandoned: 0 }); expect(m.rows.get('act-1')!.status).toBe('chosen')
  })
  const direct = (over = {}) => actionRow({ id: 'r1', status: 'chosen', chosen_at: stamp(2), kind: 'implement_recommendation', target_run_id: 'p1', target_index: 1, linked_task_id: null, ...over })
  const impl = (status: string) => ({ strategy_run_id: 'p1', recommendation_index: 1, status, completed_at: stamp(8), updated_at: stamp(8) })
  it('reads the Paid Strategy route from the existing implementation: completed is done; rejected, cancelled and failed are stopped', async () => {
    const done = setup([direct()], { impls: [impl('completed')] }); await syncActionResults(done.deps)
    expect(done.m.rows.get('r1')).toMatchObject({ status: 'completed', outcome: { source: 'implementation', final_status: 'completed' } })
    for (const status of ['rejected', 'cancelled', 'failed']) { const s = setup([direct()], { impls: [impl(status)] }); await syncActionResults(s.deps); expect(s.m.rows.get('r1')!.status).toBe('abandoned') }
  })
  it('does not call a live implementation finished: in motion is still being monitored, and nothing past a blocker is final', async () => {
    for (const status of ['in_motion', 'started', 'ready_to_activate', 'waiting_for_access', 'executing', 'needs_attention', 'prepared']) {
      const s = setup([direct()], { impls: [impl(status)] }); await syncActionResults(s.deps); expect(s.m.rows.get('r1')!.status).toBe('chosen')
    }
  })
  it('is idempotent: a finished action is never rewritten', async () => {
    const { m, deps } = setup([chosen()], { tasks: [task('done', { completed_at: stamp(7) })] })
    await syncActionResults(deps)
    const snapshot = JSON.stringify(m.rows.get('act-1'))
    expect(await syncActionResults(deps)).toEqual({ completed: 0, abandoned: 0 }); expect(JSON.stringify(m.rows.get('act-1'))).toBe(snapshot)
  })
  it('never touches drafts, or actions that already ended, and reads nothing when there is nothing open', async () => {
    const { deps } = setup([actionRow({ status: 'proposed' }), actionRow({ id: 'x', status: 'completed', outcome: {} as never })])
    expect(await syncActionResults(deps)).toEqual({ completed: 0, abandoned: 0 }); expect(deps.readTasks).not.toHaveBeenCalled()
  })
})

describe('what the insight did after the action', () => {
  const outcome = { source: 'task' as const, final_status: 'done', finished_at: stamp(7), insight: { strength: 'reasonable_inference', trend: 'steady', times_observed: 3, last_supported_at: stamp(4) } }
  it('is null until the action has finished', () => { expect(insightSinceAction(null, { strength: 'weak_signal', times_observed: 5 })).toBeNull() })
  it('says "not yet re-observed" until a later analysis has looked at the insight again', () => {
    expect(insightSinceAction(outcome, { strength: 'strong_pattern', times_observed: 3 })).toBe('not_yet_reobserved')
  })
  it('compares strength once it has: stronger, weaker or the same', () => {
    expect(insightSinceAction(outcome, { strength: 'strong_pattern', times_observed: 4 })).toBe('strengthened')
    expect(insightSinceAction(outcome, { strength: 'weak_signal', times_observed: 4 })).toBe('weakened')
    expect(insightSinceAction(outcome, { strength: 'reasonable_inference', times_observed: 6 })).toBe('unchanged')
  })
})
