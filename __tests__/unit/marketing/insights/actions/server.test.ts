import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  user: vi.fn(), perms: vi.fn(), client: vi.fn(), service: vi.fn(), strategy: vi.fn(), impls: vi.fn(), ai: vi.fn(), insertTask: vi.fn(), revalidate: vi.fn(),
  prepare: vi.fn(), confirm: vi.fn(), resume: vi.fn(), activate: vi.fn(), cancel: vi.fn(), reject: vi.fn(), store: { current: null as unknown },
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: m.user }))
vi.mock('@/lib/actions/marketing/permissions', () => ({ getUserMarketingPermissions: m.perms }))
vi.mock('@/lib/supabase/server', () => ({ createClient: m.client, createServiceClient: m.service }))
vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: m.strategy }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  getStrategyImplementations: m.impls, prepareStrategyImplementation: m.prepare, confirmStrategyImplementation: m.confirm, resumeStrategyImplementation: m.resume,
  activateStrategyImplementation: m.activate, cancelStrategyImplementation: m.cancel, rejectStrategyImplementation: m.reject,
}))
vi.mock('@/lib/ai/insight-actions', async orig => ({ ...(await orig<typeof import('@/lib/ai/insight-actions')>()), callInsightActionOptions: m.ai }))
vi.mock('@/lib/domain/task-creation', async orig => ({ ...(await orig<typeof import('@/lib/domain/task-creation')>()), insertTaskWithAudit: m.insertTask }))
vi.mock('@/lib/marketing/insights/actions/repo', () => ({ createActionStore: () => m.store.current }))
import { chooseInsightAction, listInsightActionAssignees, proposeInsightActions } from '@/lib/actions/marketing/insight-actions'
import { actionRow, memoryActionStore } from '../../../../helpers/insight-actions'
import { day, insightRow, paidRunAt } from '../../../../helpers/insights'

const UUID_INSIGHT = '11111111-1111-4111-8111-111111111111'
const UUID_ACTION = '22222222-2222-4222-8222-222222222222'
const UUID_SIB = '33333333-3333-4333-8333-333333333333'
const admin = { id: 'u1', role: 'SUPER_ADMIN', marketing_access: true }
const member = { id: 'u2', role: 'UM', marketing_access: true }

/** A thenable chain standing in for a Supabase query. */
function chain(result: { data: unknown; error?: unknown }) {
  const q: Record<string, unknown> = {}
  for (const k of ['select', 'eq', 'order', 'in', 'limit']) q[k] = () => q
  q.maybeSingle = async () => ({ error: null, ...result })
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null, ...result }).then(res)
  return q
}
const userClient = (insight: unknown, links: unknown[] = []) => ({ from: (t: string) => chain({ data: t === 'marketing_insights' ? insight : links }) })
const serviceClient = (over: { users?: unknown; owner?: unknown } = {}) => ({ from: (t: string) => { if (t !== 'app_users') throw new Error(`unexpected table ${t}`); return chain({ data: over.users ?? over.owner ?? null }) } })
const strategy = () => ({ allowed: true, canGenerate: false, latest: paidRunAt('p1', day(9)), previous: [], latestAttempt: null, error: null })
const derivedLink = (index: number, run = 'p1') => ({ insight_id: UUID_INSIGHT, target_type: 'paid_strategy_recommendation', target_run_id: run, target_index: index, relation: 'derived_from' })
const noExecution = () => { for (const f of [m.prepare, m.confirm, m.resume, m.activate, m.cancel, m.reject]) expect(f).not.toHaveBeenCalled() }
const option = (n: number) => ({ kind: 'manual_task' as const, title: `Option ${n} title`, why: 'Grounded in the insight.', steps: ['Step one', 'Step two'], success_signal: 'Look at the next analysis.', brief: null })

beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {})
  m.user.mockResolvedValue(admin); m.perms.mockResolvedValue([])
  m.client.mockResolvedValue(userClient(insightRow({ id: UUID_INSIGHT, domain: 'organic' }), []))
  m.service.mockReturnValue(serviceClient({ owner: { id: 'u1' } }))
  m.strategy.mockResolvedValue(strategy()); m.impls.mockResolvedValue({ canApprove: true, views: [], error: null })
  m.ai.mockResolvedValue({ ok: true, model: 'synthetic-model', options: [option(1), option(2)] })
  m.insertTask.mockResolvedValue({ id: 'task-9' })
  m.store.current = memoryActionStore().store
})

describe('proposeInsightActions', () => {
  it('authorizes before anything else: no user, no marketing access, or no paid_manage reaches neither the model nor the database', async () => {
    m.user.mockResolvedValue(null); expect(await proposeInsightActions(UUID_INSIGHT)).toEqual({ ok: false, error: 'Not authenticated' })
    m.user.mockResolvedValue({ id: 'u3', role: 'MEMBER', marketing_access: false }); expect(await proposeInsightActions(UUID_INSIGHT)).toEqual({ ok: false, error: 'No marketing access' })
    m.user.mockResolvedValue(member); m.perms.mockResolvedValue(['paid_approve']); expect(await proposeInsightActions(UUID_INSIGHT)).toEqual({ ok: false, error: 'paid_manage permission required' })
    expect(m.client).not.toHaveBeenCalled(); expect(m.service).not.toHaveBeenCalled(); expect(m.ai).not.toHaveBeenCalled()
  })
  it('lets a UM with paid_manage, and a SUPER_ADMIN, draft', async () => {
    m.user.mockResolvedValue(member); m.perms.mockResolvedValue(['paid_manage'])
    expect((await proposeInsightActions(UUID_INSIGHT)).ok).toBe(true)
    m.user.mockResolvedValue(admin); m.perms.mockResolvedValue([]); expect((await proposeInsightActions(UUID_INSIGHT)).ok).toBe(true)
  })
  it('reads the insight under the user’s own RLS: an id they cannot see, or a malformed one, gets nothing and no model call', async () => {
    m.client.mockResolvedValue(userClient(null))
    expect(await proposeInsightActions(UUID_INSIGHT)).toEqual({ ok: false, error: 'Insight not found.' })
    expect(await proposeInsightActions('not-a-uuid')).toEqual({ ok: false, error: 'Insight not found.' })
    expect(await proposeInsightActions(`${UUID_INSIGHT}; drop table`)).toEqual({ ok: false, error: 'Insight not found.' })
    expect(m.ai).not.toHaveBeenCalled(); expect(m.store.current && (m.store.current as { listForInsight: unknown }).listForInsight).toBeDefined()
  })
  it('drafts once, stores the options as proposals, and creates NO task and runs NOTHING', async () => {
    const mem = memoryActionStore(); m.store.current = mem.store
    const out = await proposeInsightActions(UUID_INSIGHT)
    expect(out).toMatchObject({ ok: true, reused: false }); expect(m.ai).toHaveBeenCalledTimes(1)
    expect(mem.all()).toHaveLength(2); for (const a of mem.all()) expect(a).toMatchObject({ status: 'proposed', linked_task_id: null, proposed_by_user_id: 'u1' })
    expect(m.insertTask).not.toHaveBeenCalled(); noExecution(); expect(m.revalidate).not.toHaveBeenCalled()
  })
  it('adds the direct Paid Strategy route, decided from the stored link and the live strategy, never from the model', async () => {
    m.client.mockResolvedValue(userClient(insightRow({ id: UUID_INSIGHT, domain: 'paid' }), [derivedLink(1)]))
    m.ai.mockResolvedValue({ ok: true, model: 'm', options: [option(1)] })
    const mem = memoryActionStore(); m.store.current = mem.store
    const out = await proposeInsightActions(UUID_INSIGHT)
    expect(out.ok && out.actions.map(a => a.kind)).toEqual(['implement_recommendation', 'manual_task'])
    expect(m.ai.mock.calls[0][0].count).toEqual({ min: 1, max: 2 }); noExecution()
    // a link to an earlier analysis offers no direct route
    m.client.mockResolvedValue(userClient(insightRow({ id: UUID_INSIGHT, domain: 'paid' }), [derivedLink(1, 'p0')])); m.ai.mockClear(); m.store.current = memoryActionStore().store
    await proposeInsightActions(UUID_INSIGHT)
    expect(m.ai.mock.calls[0][0].count).toEqual({ min: 2, max: 3 })
  })
  it('reports a model failure and a storage failure plainly, storing nothing on the first', async () => {
    m.ai.mockResolvedValue({ ok: false, error: 'Options could not be drafted. Please try again.' })
    const mem = memoryActionStore(); m.store.current = mem.store
    expect(await proposeInsightActions(UUID_INSIGHT)).toEqual({ ok: false, error: 'Options could not be drafted. Please try again.' }); expect(mem.all()).toHaveLength(0)
    m.ai.mockResolvedValue({ ok: true, model: 'm', options: [option(1), option(2)] }); mem.failOn.add('insertBatch')
    expect(await proposeInsightActions(UUID_INSIGHT)).toMatchObject({ ok: false, error: expect.stringContaining('migration') })
  })
})

describe('chooseInsightAction', () => {
  const seed = () => { const mem = memoryActionStore([actionRow({ id: UUID_ACTION, insight_id: UUID_INSIGHT, batch_id: 'b' }), actionRow({ id: UUID_SIB, insight_id: UUID_INSIGHT, batch_id: 'b', title: 'Sibling' })]); m.store.current = mem.store; return mem }
  it('authorizes first, and only touches a valid id of an insight the user can see', async () => {
    m.user.mockResolvedValue(null); expect(await chooseInsightAction(UUID_ACTION)).toEqual({ ok: false, error: 'Not authenticated' })
    m.user.mockResolvedValue(member); m.perms.mockResolvedValue([]); expect(await chooseInsightAction(UUID_ACTION)).toEqual({ ok: false, error: 'paid_manage permission required' })
    expect(m.insertTask).not.toHaveBeenCalled()
    m.user.mockResolvedValue(admin); seed()
    expect(await chooseInsightAction('nope')).toEqual({ ok: false, error: 'That option no longer exists.' })
    m.client.mockResolvedValue(userClient(null)) // the insight is not visible to this user
    expect(await chooseInsightAction(UUID_ACTION)).toEqual({ ok: false, error: 'That option no longer exists.' })
    expect(m.insertTask).not.toHaveBeenCalled()
  })
  it('creates the task through the existing audited creation, as the signed-in user, and refreshes every place it shows', async () => {
    const mem = seed()
    const out = await chooseInsightAction(UUID_ACTION, { dueOn: '2099-01-01' })
    expect(out.ok).toBe(false) // beyond a year ahead
    const ok = await chooseInsightAction(UUID_ACTION)
    expect(ok).toMatchObject({ ok: true, action: { status: 'chosen', linked_task_id: 'task-9', owner_user_id: 'u1' } })
    expect(m.insertTask).toHaveBeenCalledTimes(1)
    const [client, actorId, input] = m.insertTask.mock.calls[0]
    expect(actorId).toBe('u1'); expect(client).toBeDefined()
    expect(input).toMatchObject({ title: 'Add two more ads to the catering ad set', owner_user_id: 'u1', priority: 2, status: 'open' })
    expect(input.description).toContain('Created from a CMO insight')
    expect(mem.rows.get(UUID_SIB)!.status).toBe('not_chosen')
    for (const path of ['/marketing/brain', '/marketing', '/tasks', '/today']) expect(m.revalidate).toHaveBeenCalledWith(path)
    noExecution()
  })
  it('refuses an inactive owner without creating anything', async () => {
    seed(); m.service.mockReturnValue(serviceClient({ owner: null }))
    expect(await chooseInsightAction(UUID_ACTION, { ownerUserId: '44444444-4444-4444-8444-444444444444' })).toEqual({ ok: false, error: 'The chosen owner is not an active user.' })
    expect(m.insertTask).not.toHaveBeenCalled()
  })
  it('reports a task failure without leaving the option stuck', async () => {
    const mem = seed(); m.insertTask.mockResolvedValue({ error: new Error('rpc') })
    expect(await chooseInsightAction(UUID_ACTION)).toMatchObject({ ok: false })
    expect(mem.rows.get(UUID_ACTION)!.status).toBe('proposed')
  })
  it('for the direct route only records the choice: no task is created and none of the implementation actions is called', async () => {
    const mem = memoryActionStore([actionRow({ id: UUID_ACTION, insight_id: UUID_INSIGHT, batch_id: 'b', kind: 'implement_recommendation', target_run_id: 'p1', target_index: 1, model: null })]); m.store.current = mem.store
    const out = await chooseInsightAction(UUID_ACTION)
    expect(out).toMatchObject({ ok: true, action: { status: 'chosen', linked_task_id: null } })
    expect(m.insertTask).not.toHaveBeenCalled(); noExecution()
    expect(m.revalidate).toHaveBeenCalledWith('/marketing/brain')
  })
  it('refuses the direct route when the recommendation is no longer the latest unsettled one', async () => {
    const mem = memoryActionStore([actionRow({ id: UUID_ACTION, insight_id: UUID_INSIGHT, batch_id: 'b', kind: 'implement_recommendation', target_run_id: 'p0', target_index: 1, model: null })]); m.store.current = mem.store
    expect(await chooseInsightAction(UUID_ACTION)).toEqual({ ok: false, error: 'This recommendation has been superseded or already settled. Draft new options.' })
    expect(mem.rows.get(UUID_ACTION)!.status).toBe('proposed'); noExecution()
  })
})

describe('listInsightActionAssignees', () => {
  it('lists active people with marketing access or SUPER_ADMIN, behind the same authorization', async () => {
    m.service.mockReturnValue(serviceClient({ users: [
      { id: 'a', display_name: 'Ada', role: 'MEMBER', marketing_access: true }, { id: 'b', display_name: 'Bo', role: 'MEMBER', marketing_access: false },
      { id: 'c', display_name: null, role: 'SUPER_ADMIN', marketing_access: false }] }))
    expect(await listInsightActionAssignees()).toEqual({ ok: true, people: [{ id: 'a', name: 'Ada' }, { id: 'c', name: 'Unnamed user' }] })
    m.user.mockResolvedValue({ id: 'u3', role: 'MEMBER', marketing_access: false }); m.service.mockClear()
    expect(await listInsightActionAssignees()).toEqual({ ok: false, error: 'No marketing access' }); expect(m.service).not.toHaveBeenCalled()
  })
})
