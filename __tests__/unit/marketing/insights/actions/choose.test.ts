import { describe, expect, it, vi } from 'vitest'
import type { ImplementRoute } from '@/lib/marketing/insights/actions/eligibility'
import { chooseAction, DEFAULT_DUE_DAYS, type ChooseDeps } from '@/lib/marketing/insights/actions/choose'
import { buildTaskFromAction } from '@/lib/marketing/insights/actions/task-text'
import { actionRow, memoryActionStore, stamp } from '../../../../helpers/insight-actions'
import { insightView } from '../../../../helpers/insights'

const NOW = new Date('2026-10-10T08:00:00Z') // Copenhagen day: 2026-10-10
const route: ImplementRoute = { runId: 'p1', index: 1, title: 'Try a second catering ad', successMetric: 'x', test: 'y' }
const insight = insightView({ id: 'ins-1', domain: 'organic', title: 'Process stories draw shares', statement: 'Posts explaining a hidden step were shared more.', evidence_text: 'P1 reached 90,000 views.', limitations: 'Eight videos only.' })
function setup(seed = [actionRow({ id: 'a1' }), actionRow({ id: 'a2', title: 'A second option', batch_id: 'batch-1' })], over: Partial<ChooseDeps> = {}) {
  const m = memoryActionStore(seed)
  const createTask = vi.fn(async (_i: { title: string; description: string; ownerUserId: string; dueAt: string }) => 'task-1' as string | null)
  const isActiveUser = vi.fn(async (_id: string) => true)
  const routeStillValid = vi.fn(async (_r: string, _i: number) => route as ImplementRoute | null)
  const deps: ChooseDeps = { store: m.store, createTask, isActiveUser, routeStillValid, now: () => NOW, ...over }
  return { m, deps, createTask, isActiveUser, routeStillValid }
}
const choose = (deps: ChooseDeps, over = {}) => chooseAction(deps, { actionId: 'a1', actorId: 'u1', insight, ...over })

describe('choosing a manual option', () => {
  it('creates exactly one task through the existing task creation, linked to the action, owned by the actor by default, due in a week', async () => {
    const { m, deps, createTask } = setup()
    const out = await choose(deps)
    expect(out).toMatchObject({ ok: true, action: { id: 'a1', status: 'chosen', linked_task_id: 'task-1', owner_user_id: 'u1', due_on: '2026-10-17' } })
    expect(DEFAULT_DUE_DAYS).toBe(7)
    expect(createTask).toHaveBeenCalledTimes(1)
    expect(createTask.mock.calls[0][0]).toMatchObject({ ownerUserId: 'u1', title: 'Add two more ads to the catering ad set', dueAt: '2026-10-17T12:00:00.000Z' })
    expect(m.rows.get('a1')).toMatchObject({ status: 'chosen', chosen_by_user_id: 'u1', chosen_at: NOW.toISOString(), linked_task_id: 'task-1' })
  })
  it('the other drafts become "not chosen"', async () => {
    const { m, deps } = setup(); await choose(deps)
    expect(m.rows.get('a2')!.status).toBe('not_chosen')
  })
  it('assigns the task to the owner picked, who must be an active user', async () => {
    const { deps, createTask, isActiveUser } = setup()
    await choose(deps, { ownerUserId: 'u7', dueOn: '2026-10-12' })
    expect(isActiveUser).toHaveBeenCalledWith('u7'); expect(createTask.mock.calls[0][0]).toMatchObject({ ownerUserId: 'u7', dueAt: '2026-10-12T12:00:00.000Z' })
    const inactive = setup(undefined, { isActiveUser: vi.fn(async () => false) })
    expect(await choose(inactive.deps, { ownerUserId: 'gone' })).toEqual({ ok: false, error: 'The chosen owner is not an active user.' })
    expect(inactive.createTask).not.toHaveBeenCalled(); expect(inactive.m.rows.get('a1')!.status).toBe('proposed')
  })
  it('accepts a due date from today up to a year ahead, and nothing else', async () => {
    for (const bad of ['2026-10-09', '2027-10-12', 'tomorrow', '2026-13-40']) {
      const s = setup(); const out = await choose(s.deps, { dueOn: bad })
      expect(out).toEqual({ ok: false, error: 'Choose a due date from today up to a year ahead.' }); expect(s.createTask).not.toHaveBeenCalled(); expect(s.m.rows.get('a1')!.status).toBe('proposed')
    }
    expect((await choose(setup().deps, { dueOn: '2026-10-10' })).ok).toBe(true)
    expect((await choose(setup().deps, { dueOn: '2027-10-11' })).ok).toBe(true)
  })
  it('only one choice can win: a second choice, or a parallel one, creates no second task', async () => {
    const s = setup()
    const [one, two] = await Promise.all([choose(s.deps), choose(s.deps, { actionId: 'a2' })])
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1)
    expect(s.createTask).toHaveBeenCalledTimes(1)
    const again = await choose(s.deps)
    expect(again.ok).toBe(false); expect(s.createTask).toHaveBeenCalledTimes(1)
  })
  it('puts the option back when the task cannot be created, so it can be chosen again, leaving the siblings alone', async () => {
    const s = setup(undefined, { createTask: vi.fn().mockResolvedValueOnce(null).mockResolvedValue('task-2') })
    expect(await choose(s.deps)).toEqual({ ok: false, error: 'The task could not be created. Nothing was changed; you can choose again.' })
    expect(s.m.rows.get('a1')).toMatchObject({ status: 'proposed', chosen_at: null, chosen_by_user_id: null, linked_task_id: null }); expect(s.m.rows.get('a2')!.status).toBe('proposed')
    expect((await choose(s.deps)).ok).toBe(true)
  })
  it('also recovers when linking the task fails after it was created', async () => {
    const s = setup(); s.m.failOn.add('finishChoice')
    expect((await choose(s.deps)).ok).toBe(false)
    expect(s.m.rows.get('a1')!.status).toBe('proposed')
  })
  it('refuses an option that belongs to another insight, no longer exists, or is out of date', async () => {
    expect(await choose(setup().deps, { actionId: 'nope' })).toEqual({ ok: false, error: 'That option no longer exists.' })
    expect(await choose(setup().deps, { insight: insightView({ id: 'other' }) })).toEqual({ ok: false, error: 'That option no longer exists.' })
    const old = setup([actionRow({ id: 'a1', status: 'superseded' })])
    expect(await choose(old.deps)).toEqual({ ok: false, error: 'That option is out of date. Draft new options.' }); expect(old.createTask).not.toHaveBeenCalled()
    const done = setup([actionRow({ id: 'a1', status: 'completed' })])
    expect(await choose(done.deps)).toEqual({ ok: false, error: 'An option has already been chosen.' })
  })
})

describe('the task a chosen option becomes', () => {
  it('carries why, steps, what to look at afterwards, and the insight behind it, with its limits', () => {
    const { title, description } = buildTaskFromAction(actionRow(), insight)
    expect(title).toBe('Add two more ads to the catering ad set')
    for (const part of ['**Why**', '1. Open the ad set in Ads Manager', '2. Add two ads with different openings', '**What to look at afterwards**', 'Whether the next analysis still flags the ad set.',
      'Insight: Process stories draw shares', 'Evidence: P1 reached 90,000 views.', 'What we do not know: Eight videos only.', 'Created from a CMO insight']) expect(description).toContain(part)
  })
  it('turns a content brief into a task whose description IS the brief, and says plainly that a person produces it', async () => {
    const brief = actionRow({ id: 'b1', kind: 'content_brief', title: 'Brief a reel', brief: { concept: 'One hidden step, explained', hook: 'Most places skip this', key_points: ['Name it', 'Show it'], evidence_basis: 'P1 reached 90,000 views.' } })
    const s = setup([brief]); await choose(s.deps, { actionId: 'b1' })
    const description = s.createTask.mock.calls[0][0].description
    for (const part of ['**Content brief**', 'Concept: One hidden step, explained', 'Opening hook: Most places skip this', '- Name it', 'Evidence basis: P1 reached 90,000 views.', 'Kockpit does not film, publish or schedule content']) expect(description).toContain(part)
    expect(description).not.toMatch(/Kockpit (will|can) (film|publish|post|schedule)/i)
  })
  it('keeps the title within the task title limit', () => {
    expect(buildTaskFromAction(actionRow({ title: 'x'.repeat(400) }), insight).title).toHaveLength(160)
  })
})

describe('choosing the direct Paid Strategy route', () => {
  const impl = () => actionRow({ id: 'r1', kind: 'implement_recommendation', title: route.title, target_run_id: 'p1', target_index: 1, batch_id: 'batch-1', model: null, prompt_version: null })
  it('only records the choice: no task, no preparation, no execution; the existing flow does the work', async () => {
    const s = setup([impl(), actionRow({ id: 'a2', batch_id: 'batch-1' })])
    const out = await choose(s.deps, { actionId: 'r1' })
    expect(out).toMatchObject({ ok: true, action: { id: 'r1', status: 'chosen', linked_task_id: null } })
    expect(s.createTask).not.toHaveBeenCalled(); expect(s.isActiveUser).not.toHaveBeenCalled()
    expect(s.m.rows.get('a2')!.status).toBe('not_chosen')
  })
  it('re-checks at the moment of choice that the recommendation is still the latest and unsettled', async () => {
    const s = setup([impl()], { routeStillValid: vi.fn(async () => null) })
    expect(await choose(s.deps, { actionId: 'r1' })).toEqual({ ok: false, error: 'This recommendation has been superseded or already settled. Draft new options.' })
    expect(s.m.rows.get('r1')!.status).toBe('proposed')
    expect(s.routeStillValid).toBeDefined()
    const ok = setup([impl()]); await choose(ok.deps, { actionId: 'r1' })
    expect(ok.routeStillValid).toHaveBeenCalledWith('p1', 1)
  })
  it('ignores any owner or due date sent with it: those belong to the existing implementation form', async () => {
    const s = setup([impl()]); const out = await choose(s.deps, { actionId: 'r1', ownerUserId: 'u9', dueOn: '1999-01-01' })
    expect(out.ok).toBe(true); expect(out.ok && out.action).toMatchObject({ owner_user_id: null, due_on: null })
  })
})
