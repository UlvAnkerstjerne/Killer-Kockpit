import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { ACCOUNT, budget, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import { client, implementationDatabase, RUN_NEW, RUN_OLD, seedRun, uid } from '../../../../helpers/paid-strategy-implementation-db'
import { IDS, rec } from '../../../../helpers/paid-strategy'

// The only doubles: the Meta HTTP adapter (a controllable fake Meta). The executor, guardrails, compiler,
// service, SQL functions and constraints are all real.
const meta = vi.hoisted(() => ({ live: { status: 'ACTIVE', dailyBudget: 100 } as { status: string; dailyBudget: number }, mutate: vi.fn(), reads: vi.fn(), throwOnMutate: false, applyDespiteError: false, ignoreMutation: false, factory: vi.fn() }))
vi.mock('@/lib/marketing/paid-recs/platform-adapters', () => ({
  metaMutationAdapter: (currency: string) => {
    meta.factory(currency)
    return {
      async read() { meta.reads(); return { platform: 'meta', accountId: ACCOUNT, status: meta.live.status, dailyBudget: meta.live.dailyBudget, currency } },
      async mutate(plan: { action_type: string; target_daily_budget?: number }) {
        meta.mutate(plan)
        if (!meta.ignoreMutation && (!meta.throwOnMutate || meta.applyDespiteError)) {
          if (plan.action_type.includes('pause')) meta.live.status = 'PAUSED'
          else if (plan.action_type.includes('resume')) meta.live.status = 'ACTIVE'
          else if (plan.target_daily_budget) meta.live.dailyBudget = plan.target_daily_budget
        }
        if (meta.throwOnMutate) throw new Error('socket hang up')
        return {}
      },
    }
  },
  googleMutationAdapter: () => { throw new Error('google must not be used') },
}))
import { confirmImplementation, prepareImplementation } from '@/lib/marketing/paid-strategy/implementation/service'

let db: PGlite
let sb: ReturnType<typeof client>
const NOW = new Date('2026-10-09T08:00:00Z')
const rows = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, unknown>[]
const impl = async (index: number, run = RUN_NEW) => (await rows('SELECT * FROM marketing_paid_strategy_implementations WHERE strategy_run_id=$1 AND recommendation_index=$2', [run, index]))[0]
const tasks = () => rows('SELECT * FROM tasks ORDER BY title')
const confirm = (index: number, inputs: unknown = {}, actor = 2) => confirmImplementation(sb as never, uid(actor), RUN_NEW, index, inputs, NOW)
const prepare = (index: number, inputs: unknown = {}, run = RUN_NEW) => prepareImplementation(sb as never, uid(2), run, index, inputs, NOW)

beforeAll(() => { process.env.META_AD_ACCOUNT_ID = ACCOUNT })
beforeEach(async () => {
  db = await implementationDatabase(); sb = client(db)
  await seedRun(db, RUN_OLD, '2026-10-01T10:00:00Z')
  await seedRun(db, RUN_NEW, '2026-10-08T10:00:00Z', { recommendations: [tracking, creative, newCampaign] })
  Object.assign(meta, { throwOnMutate: false, applyDespiteError: false, ignoreMutation: false }); meta.live = { status: 'ACTIVE', dailyBudget: 100 }
  meta.mutate.mockClear(); meta.reads.mockClear(); meta.factory.mockClear()
}, 120_000)
afterEach(async () => { await db.close() })

describe('prepare never has a side effect', () => {
  it('stores a prepared row and an audit event, and creates no task and reserves nothing', async () => {
    const out = await prepare(0)
    expect(out).toMatchObject({ ok: true, alreadyStarted: false, preview: { mode: 'implementation_task' } })
    expect(await tasks()).toHaveLength(0)
    expect(await impl(0)).toMatchObject({ status: 'prepared', implementation_mode: 'implementation_task', budget_reserved_dkk: '0.00', linked_task_id: null, prepared_by_user_id: uid(2) })
    expect((await rows("SELECT action FROM audit_events WHERE entity_type='paid_strategy_implementation'")).map(r => r.action)).toEqual(['marketing.paid_strategy_implementation.prepared'])
    expect(meta.mutate).not.toHaveBeenCalled()
  })
  it('can be repeated freely (re-prepare with new inputs) without duplicating', async () => {
    await prepare(2); await prepare(2, { reserveBudgetDkk: 500 })
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations')).toHaveLength(1)
    expect((await impl(2)).compiled).toMatchObject({ budget: { requestedDkk: 500 } })
  })
  it('hands the browser no platform plan or IDs', async () => {
    const out = await prepare(2)
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`${IDS.c2}|act_`))
  })
})

describe('current strategy only', () => {
  it('cannot prepare or confirm a superseded run', async () => {
    expect(await prepare(0, {}, RUN_OLD)).toMatchObject({ ok: false, error: expect.stringContaining('Superseded by a newer strategy') })
    expect(await confirmImplementation(sb as never, uid(2), RUN_OLD, 0, {}, NOW)).toMatchObject({ ok: false })
    expect(await tasks()).toHaveLength(0)
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations')).toHaveLength(0)
  })
  it('rejects a recommendation that does not exist, malformed ids and unknown input fields', async () => {
    expect((await prepare(2 + 1)).ok).toBe(false)
    expect((await confirmImplementation(sb as never, uid(2), 'not-a-uuid', 0, {}, NOW)).ok).toBe(false)
    expect((await confirm(0, { platform: { action: 'delete_campaign', targetType: 'campaign', targetId: '1' } })).ok).toBe(false)
    expect((await confirm(0, { campaignId: IDS.c1 })).ok).toBe(false) // strict: no smuggled fields
  })
})

describe('tasks and packages', () => {
  it('tracking -> one implementation Task with the chosen owner and due date, link persisted, nothing else touched', async () => {
    const out = await confirm(0, { ownerUserId: uid(6), dueDate: '2026-10-20' })
    expect(out).toMatchObject({ ok: true, duplicate: false, status: 'started' })
    const [task] = await tasks()
    expect(task).toMatchObject({ title: 'Implement: Add a measurable conversion event to the catering lead funnel', owner_user_id: uid(6), created_by_user_id: uid(2), status: 'open' })
    expect(new Date(task.due_at as string).toISOString().slice(0, 10)).toBe('2026-10-20')
    expect(String(task.description)).toContain('Source: Paid Strategy')
    expect(await impl(0)).toMatchObject({ status: 'started', linked_task_id: task.id, approved_by_user_id: uid(2) })
    expect(meta.factory).not.toHaveBeenCalled()
  })
  it('creative -> a Killer Kreative Task', async () => {
    await confirm(1)
    expect((await tasks())[0].title).toMatch(/^Killer Kreative: /)
  })
  it('new campaign -> persists the package, creates one Task and reserves the budget, with no Meta call', async () => {
    const out = await confirm(2)
    expect(out).toMatchObject({ ok: true, status: 'started', message: expect.stringContaining('Nothing was created in Meta') })
    const row = await impl(2)
    expect(row).toMatchObject({ implementation_mode: 'implementation_package', status: 'started', budget_reserved_dkk: '2000.00' })
    expect((row.compiled as { package: { kind: string; source_campaign_to_mirror: { id: string } } }).package).toMatchObject({ kind: 'new_campaign', source_campaign_to_mirror: { id: IDS.c2 } })
    expect((await tasks())[0].title).toMatch(/^Launch package: /)
    expect(row.linked_task_id).toBe((await tasks())[0].id)
    expect(meta.factory).not.toHaveBeenCalled()
    expect(meta.mutate).not.toHaveBeenCalled()
  })
  it('records the audit trail: actor, run, mode, budget, linked task', async () => {
    await confirm(2)
    const events = await rows("SELECT action, actor_user_id, after_json FROM audit_events WHERE entity_type='paid_strategy_implementation' ORDER BY created_at, action")
    expect(events.map(e => e.action)).toEqual(expect.arrayContaining(['marketing.paid_strategy_implementation.approved', 'marketing.paid_strategy_implementation.started']))
    const started = events.find(e => String(e.action).endsWith('.started'))!
    expect(started.actor_user_id).toBe(uid(2))
    expect(started.after_json).toMatchObject({ strategy_run_id: RUN_NEW, recommendation_index: 2, mode: 'implementation_package', budget_reserved_dkk: 2000, linked_task_id: (await tasks())[0].id, package_saved: true })
    expect(JSON.stringify(events)).not.toMatch(/token|secret|password|api[_-]?key/i)
  })
  it('refuses an owner who is not an active user, and a due date in the past', async () => {
    expect((await confirm(0, { ownerUserId: uid(5) })).ok).toBe(false)
    expect((await confirm(0, { dueDate: '2026-10-01' })).ok).toBe(false)
    expect(await tasks()).toHaveLength(0)
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations')).toHaveLength(0)
  })
})

describe('idempotency', () => {
  it('a double click creates one task, one reservation and one audit approval', async () => {
    const [a, b] = await Promise.all([confirm(2), confirm(2)])
    expect([a, b].filter(r => r.ok && !r.duplicate)).toHaveLength(1)
    expect([a, b].filter(r => r.ok && r.duplicate)).toHaveLength(1)
    expect(await tasks()).toHaveLength(1)
    expect(Number((await rows('SELECT paid_strategy_reserved_dkk() AS r'))[0].r)).toBe(2000)
    expect(await rows("SELECT * FROM audit_events WHERE action='marketing.paid_strategy_implementation.approved'")).toHaveLength(1)
  })
  it('a later click, or another approver, reports the existing state and changes nothing', async () => {
    await confirm(0)
    const again = await confirm(0, {}, 3)
    expect(again).toMatchObject({ ok: true, duplicate: true, status: 'started' })
    expect(await tasks()).toHaveLength(1)
    expect(await prepare(0)).toMatchObject({ ok: true, alreadyStarted: true, status: 'started' })
  })
})

describe('shared headroom across approvals', () => {
  it('approved work reduces what the next recommendation can use, and the total never exceeds the headroom', async () => {
    const big = rec(5, { recommendation_type: 'campaign_structure', title: 'Launch a Lund leads campaign mirroring C2', exact_test_or_action: 'Mirror C2 in Lund.', incremental_budget_dkk: 7000 })
    await db.query("UPDATE marketing_paid_strategy_runs SET recommendations=$1 WHERE id=$2", [JSON.stringify([tracking, big, newCampaign]), RUN_NEW])
    expect((await confirm(2)).ok).toBe(true) // 2,000 of 8,800
    const blocked = await confirm(1) // wants 7,000, only 6,800 left
    expect(blocked).toMatchObject({ ok: false, needsInput: [{ key: 'reserve_budget' }] })
    expect(await tasks()).toHaveLength(1)
    const lowered = await confirm(1, { reserveBudgetDkk: 6800 })
    expect(lowered).toMatchObject({ ok: true })
    expect(Number((await rows('SELECT paid_strategy_reserved_dkk() AS r'))[0].r)).toBe(8800)
  })
  it('rejects any incremental budget when headroom is unreliable, but still allows a 0 DKK start', async () => {
    await db.query("UPDATE marketing_paid_strategy_runs SET evidence = jsonb_set(evidence, '{budget,projection,reliable}', 'false') WHERE id=$1", [RUN_NEW])
    expect((await confirm(2)).ok).toBe(false)
    expect(await tasks()).toHaveLength(0)
    expect((await confirm(2, { reserveBudgetDkk: 0 })).ok).toBe(true)
    expect((await impl(2)).budget_reserved_dkk).toBe('0.00')
  })
  it('releases the reservation when the linked task is done, so settled spend is not counted twice', async () => {
    await confirm(2)
    await db.query("UPDATE tasks SET status='done'")
    expect(Number((await rows('SELECT paid_strategy_reserved_dkk() AS r'))[0].r)).toBe(0)
  })
})

describe('failure safety', () => {
  it('a failed task creation is "failed", not completed; it keeps no reservation and can be approved again', async () => {
    sb.failures.create_task_and_audit = 1
    const out = await confirm(2)
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('Nothing was changed') })
    expect(await impl(2)).toMatchObject({ status: 'failed', linked_task_id: null, error: 'The task could not be created.' })
    expect(await tasks()).toHaveLength(0)
    expect(Number((await rows('SELECT paid_strategy_reserved_dkk() AS r'))[0].r)).toBe(0)
    expect((await rows("SELECT action FROM audit_events WHERE action LIKE '%.failed'"))).toHaveLength(1)
    expect(await confirm(2)).toMatchObject({ ok: true, status: 'started' })
    expect(await tasks()).toHaveLength(1)
  })
  it('compilation failure leaves the strategy and everything else untouched', async () => {
    await db.query('DELETE FROM meta_ad_campaigns')
    const out = await confirm(2)
    expect(out.ok).toBe(true) // task modes do not need synced campaigns
    await db.query('DROP TABLE meta_ad_sets')
    expect(await confirm(0)).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') })
    expect((await rows('SELECT recommendations FROM marketing_paid_strategy_runs WHERE id=$1', [RUN_NEW]))[0].recommendations).toHaveLength(3)
  })
})

describe('SAFE PLATFORM ACTION through the existing executor', () => {
  const run4 = async () => { await db.query('UPDATE marketing_paid_strategy_runs SET recommendations=$1 WHERE id=$2', [JSON.stringify([budget, tracking, creative]), RUN_NEW]) }
  const set = (targetDailyBudget: number, targetId = IDS.c1) => ({ platform: { action: 'set_daily_budget', targetType: 'campaign', targetId, targetDailyBudget } })

  it('executes exactly once, with live re-read, verified read-back and before/after recorded', async () => {
    await run4()
    expect((await prepare(0)).ok).toBe(true)
    const out = await confirm(0, set(80))
    expect(out).toMatchObject({ ok: true, status: 'in_motion', message: expect.stringContaining('reading it back from Meta') })
    expect(meta.mutate).toHaveBeenCalledTimes(1)
    expect(meta.mutate.mock.calls[0][0]).toMatchObject({ action_type: 'meta_set_campaign_budget', target_id: IDS.c1, ad_account_id: ACCOUNT, current_daily_budget: 100, target_daily_budget: 80 })
    expect(meta.reads.mock.calls.length).toBeGreaterThanOrEqual(2) // before, then read-back
    const row = await impl(0)
    expect(row).toMatchObject({ status: 'in_motion', implementation_mode: 'platform_action', linked_task_id: null })
    expect(row.result).toMatchObject({ before: { dailyBudget: 100, status: 'ACTIVE' }, after: { dailyBudget: 80 }, action_type: 'meta_set_campaign_budget' })
    const ev = (await rows("SELECT after_json FROM audit_events WHERE action='marketing.paid_strategy_implementation.executed'"))[0].after_json as Record<string, unknown>
    expect(ev).toMatchObject({ platform: 'meta', action_type: 'meta_set_campaign_budget', before: { dailyBudget: 100 }, after: { dailyBudget: 80 } })
    expect(await tasks()).toHaveLength(0)
  })
  it('a pause is completed after verified read-back; a double click mutates once', async () => {
    await run4()
    const [a, b] = await Promise.all([confirm(0, { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c1 } }), confirm(0, { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c1 } })])
    expect([a, b].filter(r => r.ok && !r.duplicate)).toHaveLength(1)
    expect(meta.mutate).toHaveBeenCalledTimes(1)
    expect(await impl(0)).toMatchObject({ status: 'completed' })
  })
  it('keeps the 20% guardrail: a 30% change never reaches Meta', async () => {
    await run4()
    const out = await confirm(0, set(70))
    expect(out).toMatchObject({ ok: false, needsInput: expect.anything() })
    expect(meta.factory).not.toHaveBeenCalled(); expect(meta.mutate).not.toHaveBeenCalled()
    expect(await impl(0)).toMatchObject({ status: 'needs_input' })
  })
  it('keeps account ownership: another account\'s campaign never reaches Meta', async () => {
    await run4()
    await confirm(0, { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: IDS.c4 } })
    expect(meta.mutate).not.toHaveBeenCalled()
  })
  it('never executes an unsupported action (ad-set pause) or an unmapped target', async () => {
    await run4()
    await confirm(0, { platform: { action: 'pause_campaign', targetType: 'adset', targetId: IDS.s1 } })
    await confirm(0, { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: '99999' } })
    expect(meta.factory).not.toHaveBeenCalled(); expect(meta.mutate).not.toHaveBeenCalled()
    expect(await tasks()).toHaveLength(0)
  })
  it('stops when the live budget changed since it was prepared (executor guardrail), and mutates nothing', async () => {
    await run4()
    meta.live.dailyBudget = 130
    const out = await confirm(0, set(80))
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('Budget changed since approval was proposed') })
    expect(meta.mutate).not.toHaveBeenCalled()
    expect(await impl(0)).toMatchObject({ status: 'needs_attention' })
  })
  it('flags an uncertain outcome instead of retrying: one mutation only, and a later click does not mutate again', async () => {
    await run4()
    meta.throwOnMutate = true; meta.applyDespiteError = false
    const out = await confirm(0, set(80))
    expect(out.ok).toBe(false)
    expect(meta.mutate).toHaveBeenCalledTimes(1)
    const row = await impl(0)
    expect(row.status).toBe('needs_attention')
    expect(row.result).toMatchObject({ recovery: { mutation_may_have_succeeded: true, verify_before_retry: true } })
    expect(await confirm(0, set(80))).toMatchObject({ ok: true, duplicate: true })
    expect(meta.mutate).toHaveBeenCalledTimes(1)
  })
  it('treats a timeout that actually committed as verified, without a second mutation', async () => {
    await run4()
    meta.throwOnMutate = true; meta.applyDespiteError = true
    expect((await confirm(0, set(80))).ok).toBe(true)
    expect(meta.mutate).toHaveBeenCalledTimes(1)
    expect(await impl(0)).toMatchObject({ status: 'in_motion' })
  })
  it('flags a read-back that does not match what was requested', async () => {
    await run4()
    meta.ignoreMutation = true
    const out = await confirm(0, set(80))
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('read-back did not match') })
    expect(await impl(0)).toMatchObject({ status: 'needs_attention' })
  })
  it('reserves the month-end cost of an increase against the shared headroom and refuses it when it does not fit', async () => {
    await run4()
    await db.query("UPDATE marketing_paid_strategy_runs SET evidence = jsonb_set(evidence, '{budget,projection,projected_incremental_headroom}', '200') WHERE id=$1", [RUN_NEW])
    expect(await confirm(0, set(110))).toMatchObject({ ok: false }) // +10/day x 23 days = 230 > 200
    expect(meta.mutate).not.toHaveBeenCalled()
    await db.query("UPDATE marketing_paid_strategy_runs SET evidence = jsonb_set(evidence, '{budget,projection,projected_incremental_headroom}', '300') WHERE id=$1", [RUN_NEW])
    expect(await confirm(0, set(110))).toMatchObject({ ok: true })
    expect((await impl(0)).budget_reserved_dkk).toBe('230.00')
  })
})
