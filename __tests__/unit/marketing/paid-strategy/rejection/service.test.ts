import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { activateImplementation, cancelImplementation, confirmImplementation, prepareImplementation, rejectImplementation } from '@/lib/marketing/paid-strategy/implementation/service'
import { loadImplementationViews } from '@/lib/marketing/paid-strategy/implementation/read'
import { ACCOUNT, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import { client, implementationDatabase, RUN_NEW, RUN_OLD, seedRun, uid } from '../../../../helpers/paid-strategy-implementation-db'
import { prodCapabilities, runnerFixture } from '../../../../helpers/fake-meta'
import { SRC } from '../../../../helpers/meta-source-config'

// Real PostgreSQL (all four migrations), the real claim and reject functions, the real runner over an in-memory Meta account.
let db: PGlite
let sb: ReturnType<typeof client>
let fx: ReturnType<typeof runnerFixture>
const NOW = new Date('2026-10-10T09:00:00Z')
const REASON = 'We do not want to advertise catering in Malmö.'
const rows = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, unknown>[]
const impl = async (index: number, run = RUN_NEW) => (await rows('SELECT * FROM marketing_paid_strategy_implementations WHERE strategy_run_id=$1 AND recommendation_index=$2', [run, index]))[0]
const reserved = async () => Number((await rows('SELECT paid_strategy_reserved_dkk() AS r'))[0].r)
const injected = () => ({ capabilities: prodCapabilities(), deps: fx.deps })
const confirm = (index: number, actor = 2) => confirmImplementation(sb as never, uid(actor), RUN_NEW, index, {}, NOW, injected())
const prepare = (index: number) => prepareImplementation(sb as never, uid(2), RUN_NEW, index, {}, NOW, injected())
const reject = (index: number, reason?: unknown, run = RUN_NEW, actor = 2) => rejectImplementation(sb as never, uid(actor), run, index, reason)
const auditActions = async () => (await rows("SELECT action FROM audit_events WHERE entity_type='paid_strategy_implementation' ORDER BY created_at, id")).map(r => String(r.action).split('.').pop())

beforeAll(() => { process.env.META_AD_ACCOUNT_ID = ACCOUNT })
beforeEach(async () => {
  db = await implementationDatabase(); sb = client(db); fx = runnerFixture({ now: () => NOW })
  await db.exec('DELETE FROM meta_ad_sets; DELETE FROM meta_ad_campaigns')
  await db.query("INSERT INTO meta_ad_campaigns VALUES ($1,$2,'Killer Katering - Copenhagen Leads (V1)','ACTIVE',NULL), ($3,$2,'Malmö Brand - Foodies Always On (V2)','ACTIVE',NULL)", [SRC.campaign, ACCOUNT, SRC.malmoCampaign])
  await db.query("INSERT INTO meta_ad_sets VALUES ($1,$2,'Katering Leads - Greater Copenhagen Broad','ACTIVE','8000')", [SRC.adSet, SRC.campaign])
  await seedRun(db, RUN_OLD, '2026-10-01T10:00:00Z')
  await seedRun(db, RUN_NEW, '2026-10-08T10:00:00Z', { headroom: 2721.36, recommendations: [tracking, creative, newCampaign] })
}, 120_000)
afterEach(async () => { await db.close() })

describe('rejecting a recommendation that has no implementation row yet', () => {
  it('persists the decision on the minimal row the unique key allows, with the reason, actor and time', async () => {
    expect(await impl(2)).toBeUndefined()
    expect(await reject(2, REASON)).toMatchObject({ ok: true, duplicate: false, status: 'rejected', budgetReleasedDkk: 0, metaObjectsExist: false })
    expect(await impl(2)).toMatchObject({ status: 'rejected', rejection_reason: REASON, rejected_by_user_id: uid(2), budget_reserved_dkk: '0.00', approved_at: null, linked_task_id: null })
    expect((await impl(2)).rejected_at).toBeTruthy()
    expect((await impl(2)).recommendation_snapshot).toMatchObject({ title: newCampaign.title })
  })
  it('a rejection with no reason is valid', async () => {
    expect(await reject(0)).toMatchObject({ ok: true, status: 'rejected' })
    expect(await impl(0)).toMatchObject({ status: 'rejected', rejection_reason: null })
    expect(await reject(1, '   ')).toMatchObject({ ok: true }); expect(await impl(1)).toMatchObject({ rejection_reason: null })
  })
  it('the reason is stored trimmed and cleaned, and a reason over the limit is refused', async () => {
    await reject(0, `  Wrong priority\u0000 right now  `)
    expect(await impl(0)).toMatchObject({ rejection_reason: 'Wrong priority right now' })
    expect(await reject(1, 'x'.repeat(501))).toMatchObject({ ok: false, error: expect.stringContaining('too long') })
    expect(await impl(1)).toBeUndefined()
  })
  it('only the latest run, and only a recommendation that exists, can be rejected', async () => {
    expect(await reject(0, 'x', RUN_OLD)).toMatchObject({ ok: false, error: expect.stringContaining('Superseded') })
    expect(await reject(5)).toMatchObject({ ok: false }); expect(await reject(-1)).toMatchObject({ ok: false })
    await seedRun(db, '58000000-0000-4000-8000-000000000009', '2026-10-09T10:00:00Z', { recommendations: [tracking] })
    expect(await reject(2)).toMatchObject({ ok: false, error: expect.stringContaining('Superseded') }) // RUN_NEW is no longer the latest
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations')).toHaveLength(0)
  })
  it('an inactive actor cannot reject', async () => {
    expect(await reject(0, 'x', RUN_NEW, 5)).toMatchObject({ ok: false, error: expect.stringContaining('not active') })
  })
})

describe('rejecting a prepared or blocked implementation', () => {
  it('prepared -> rejected, in place, keeping the unique row', async () => {
    await prepare(2)
    expect(await reject(2, REASON)).toMatchObject({ ok: true })
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations WHERE recommendation_index = 2')).toHaveLength(1)
    expect(await impl(2)).toMatchObject({ status: 'rejected', rejection_reason: REASON })
  })
  it('waiting_for_access, waiting_for_input, needs_attention, failed and cancelled can all be rejected, and release what they held', async () => {
    for (const [i, status] of (['waiting_for_access', 'waiting_for_input', 'needs_attention', 'failed', 'cancelled'] as const).entries()) {
      const idx = i % 3
      await db.query("DELETE FROM marketing_paid_strategy_implementations")
      await db.query(`INSERT INTO marketing_paid_strategy_implementations(strategy_run_id,recommendation_index,recommendation_snapshot,implementation_mode,status,budget_reserved_dkk,approved_at,approved_by_user_id)
        VALUES ($1,$2,'{}','tracking_execution',$3,$4,now(),$5)`, [RUN_NEW, idx, status, status === 'failed' || status === 'cancelled' ? 0 : 300, uid(2)])
      expect(await reject(idx, status)).toMatchObject({ ok: true, status: 'rejected' })
      expect(await impl(idx)).toMatchObject({ status: 'rejected', budget_reserved_dkk: '0.00' })
      expect(await reserved()).toBe(0)
    }
  })
  it('is refused while Kockpit is working, and once live or finished', async () => {
    for (const status of ['approved', 'planning', 'executing', 'verifying', 'in_motion', 'completed', 'started'] as const) {
      await db.query("DELETE FROM marketing_paid_strategy_implementations")
      await db.query(`INSERT INTO marketing_paid_strategy_implementations(strategy_run_id,recommendation_index,recommendation_snapshot,implementation_mode,status,budget_reserved_dkk,approved_at,approved_by_user_id)
        VALUES ($1,0,'{}','platform_action',$2,0,now(),$3)`, [RUN_NEW, status, uid(2)])
      const out = await reject(0, 'no')
      expect(out, status).toMatchObject({ ok: false })
      expect(await impl(0), status).toMatchObject({ status, rejection_reason: null })
    }
    expect(await auditActions()).toEqual([])
  })
})

describe('the current Malmö case: ready_to_activate -> rejected', () => {
  beforeEach(async () => { await confirm(2) })
  const metaSnapshot = () => JSON.stringify({ c: [...fx.meta.state.campaigns.values()], s: [...fx.meta.state.adSets.values()], a: [...fx.meta.state.ads.values()], k: [...fx.meta.state.creatives.values()] })

  it('starts as ready to activate with 2,100 DKK reserved', async () => {
    expect(await impl(2)).toMatchObject({ status: 'ready_to_activate', budget_reserved_dkk: '2100.00' })
    expect(await reserved()).toBe(2100)
  })
  it('rejects it: status rejected, reason recorded, 2,100 DKK released, the shared headroom frees up', async () => {
    const out = await reject(2, REASON)
    expect(out).toMatchObject({ ok: true, duplicate: false, status: 'rejected', budgetReleasedDkk: 2100, metaObjectsExist: true })
    expect((out as { message: string }).message).toContain('paused objects already created in Meta remain and cannot spend')
    expect(await impl(2)).toMatchObject({ status: 'rejected', rejection_reason: REASON, budget_reserved_dkk: '0.00', rejected_by_user_id: uid(2) })
    expect(await reserved()).toBe(0)
  })
  it('does not activate anything, and does not touch, delete or change a single Meta object', async () => {
    const before = metaSnapshot(); const callsBefore = fx.meta.calls.length
    await reject(2, REASON)
    expect(fx.meta.calls.length).toBe(callsBefore)
    expect(metaSnapshot()).toBe(before)
    expect(fx.meta.calls.map(c => c.op).filter(o => o.startsWith('meta_resume') || o === 'set_end_time')).toEqual([])
    for (const store of [fx.meta.state.campaigns, fx.meta.state.adSets, fx.meta.state.ads]) for (const o of store.values()) if (String((o as { name?: string }).name).includes('[KK-')) expect((o as { status: string }).status).toBe('PAUSED')
  })
  it('the paused ledger and Meta ids are kept for the later cleanup, and no task exists', async () => {
    await reject(2, REASON)
    const ledger = (await impl(2)).execution as { evidence: { created: Record<string, string> } }
    expect(Object.keys(ledger.evidence.created)).toEqual(expect.arrayContaining(['campaignId', 'adSetId', 'creativeId', 'adId']))
    expect(await rows('SELECT * FROM tasks')).toHaveLength(0)
  })
  it('writes one audit event: actor, run, index, previous status, reason, released budget and whether paused objects existed', async () => {
    await reject(2, REASON)
    const ev = (await rows("SELECT * FROM audit_events WHERE action='marketing.paid_strategy_implementation.rejected'"))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actor_user_id: uid(2), actor_type: 'human', entity_type: 'paid_strategy_implementation', entity_id: (await impl(2)).id })
    expect(ev[0].before_json).toEqual({ status: 'ready_to_activate' })
    expect(ev[0].after_json).toEqual({ strategy_run_id: RUN_NEW, recommendation_index: 2, previous_status: 'ready_to_activate', reason: REASON, budget_released_dkk: 2100, meta_objects_existed: true })
    expect(JSON.stringify(ev[0].after_json)).not.toMatch(/token|secret|act_/i)
  })
  it('a double click is a no-op: one audit event, nothing released twice, no duplicate row, the reason is not overwritten', async () => {
    const [a, b] = await Promise.all([reject(2, REASON), reject(2, 'something else')])
    expect([a, b].filter(r => r.ok && !r.duplicate)).toHaveLength(1)
    expect([a, b].every(r => r.ok)).toBe(true)
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations WHERE recommendation_index = 2')).toHaveLength(1)
    expect((await auditActions()).filter(x => x === 'rejected')).toHaveLength(1)
    expect(['We do not want to advertise catering in Malmö.', 'something else']).toContain((await impl(2)).rejection_reason)
    expect(await reject(2, 'third')).toMatchObject({ ok: true, duplicate: true, budgetReleasedDkk: 0 })
    expect(await reserved()).toBe(0)
  })
  it('a rejected recommendation cannot be approved, re-prepared, cancelled into another state or activated afterwards', async () => {
    await reject(2, REASON)
    expect(await confirm(2)).toMatchObject({ ok: false, error: expect.stringContaining('rejected') })
    expect(await prepare(2)).toMatchObject({ ok: true, alreadyStarted: true, status: 'rejected' })
    expect(await cancelImplementation(sb as never, uid(2), RUN_NEW, 2)).toMatchObject({ ok: true, duplicate: true, status: 'rejected' })
    expect(await activateImplementation(sb as never, uid(2), RUN_NEW, 2, NOW, injected())).toMatchObject({ ok: false })
    expect(await impl(2)).toMatchObject({ status: 'rejected', budget_reserved_dkk: '0.00' })
    expect(fx.meta.calls.map(c => c.op).filter(o => o.startsWith('meta_resume'))).toEqual([])
  })
  it('the card state a reader sees: rejected, reason, no reservation, and that paused Meta objects remain', async () => {
    await reject(2, REASON)
    const { views } = await loadImplementationViews(sb as never, [RUN_NEW])
    expect(views.find(v => v.recommendationIndex === 2)).toMatchObject({ status: 'rejected', rejectionReason: REASON, budgetReservedDkk: 0, metaObjectsExist: true, review: null })
  })
})

describe('shared headroom', () => {
  it('a rejected reservation no longer counts, so the budget can be used by another recommendation', async () => {
    await confirm(2)
    expect(await confirmImplementation(sb as never, uid(2), RUN_NEW, 1, { campaign: { dailyBudgetDkk: 100, durationDays: 20 } }, NOW, injected())).toBeTruthy()
    await reject(2, REASON)
    expect(await reserved()).toBe(0)
    expect(Number((await rows("SELECT COALESCE(SUM(budget_reserved_dkk),0) s FROM marketing_paid_strategy_implementations WHERE status='rejected'"))[0].s)).toBe(0)
  })
})

describe('database privileges and shape', () => {
  it('the reject function is callable by service_role only, and the table stays unwritable through the user JWT', async () => {
    const priv = (await rows("SELECT has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s FROM pg_proc p WHERE proname = 'reject_paid_strategy_implementation'"))[0]
    expect(priv).toEqual({ a: false, u: false, s: true })
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(2)]); await db.exec('SET ROLE authenticated')
    try {
      await expect(db.query("UPDATE marketing_paid_strategy_implementations SET status='rejected'")).rejects.toThrow()
      await expect(db.query("SELECT reject_paid_strategy_implementation($1,0::smallint,$2,'x')", [RUN_NEW, uid(2)])).rejects.toThrow()
    } finally { await db.exec('RESET ROLE') }
  })
  it('a rejected row must carry the decision, must reserve nothing, and only a rejected row may carry one', async () => {
    await reject(0, 'x')
    const bad = (set: string) => db.query(`UPDATE marketing_paid_strategy_implementations SET ${set} WHERE recommendation_index = 0`)
    await expect(bad('budget_reserved_dkk = 5')).rejects.toThrow()
    await expect(bad('rejected_at = NULL')).rejects.toThrow()
    await expect(bad("status = 'prepared'")).rejects.toThrow() // would keep rejection fields on a non-rejected row
    await expect(bad(`rejection_reason = '${'x'.repeat(501)}'`)).rejects.toThrow()
  })
})
