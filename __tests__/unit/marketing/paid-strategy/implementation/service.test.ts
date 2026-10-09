import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { MetaApiError } from '@/lib/meta/client'
import { activateImplementation, cancelImplementation, confirmImplementation, prepareImplementation, resumeImplementation } from '@/lib/marketing/paid-strategy/implementation/service'
import { loadImplementationViews } from '@/lib/marketing/paid-strategy/implementation/read'
import { goodPackage } from '../../../../helpers/creative-package'
import { ACCOUNT, budget, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import { client, implementationDatabase, RUN_NEW, RUN_OLD, seedRun, uid } from '../../../../helpers/paid-strategy-implementation-db'
import { prodCapabilities, runnerFixture } from '../../../../helpers/fake-meta'
import { SRC } from '../../../../helpers/meta-source-config'

// Real PostgreSQL (all three migrations), the real claim function, real task and draft writes, the real trusted executor.
// The only double is the Meta account itself (an in-memory fake that reflects every create and read).
let db: PGlite
let sb: ReturnType<typeof client>
let fx: ReturnType<typeof runnerFixture>
const NOW = new Date('2026-10-10T09:00:00Z')
const rows = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, unknown>[]
const impl = async (index: number, run = RUN_NEW) => (await rows('SELECT * FROM marketing_paid_strategy_implementations WHERE strategy_run_id=$1 AND recommendation_index=$2', [run, index]))[0]
const reserved = async () => Number((await rows('SELECT paid_strategy_reserved_dkk() AS r'))[0].r)
const tasks = () => rows('SELECT * FROM tasks')
const injected = () => ({ capabilities: prodCapabilities(), deps: fx.deps })
const confirm = (index: number, inputs: unknown = {}, actor = 2) => confirmImplementation(sb as never, uid(actor), RUN_NEW, index, inputs, NOW, injected())
const prepare = (index: number, inputs: unknown = {}, run = RUN_NEW) => prepareImplementation(sb as never, uid(2), run, index, inputs, NOW, injected())
const resume = (index: number, inputs: unknown = {}) => resumeImplementation(sb as never, uid(2), RUN_NEW, index, inputs, NOW, injected())
const activate = (index: number) => activateImplementation(sb as never, uid(2), RUN_NEW, index, NOW, injected())
const cancel = (index: number) => cancelImplementation(sb as never, uid(2), RUN_NEW, index)
const metaOps = () => fx.meta.calls.map(c => c.op)
const creates = () => fx.meta.calls.filter(c => c.op.startsWith('create_') && !c.validateOnly)

beforeAll(() => { process.env.META_AD_ACCOUNT_ID = ACCOUNT })
beforeEach(async () => {
  db = await implementationDatabase(); sb = client(db); fx = runnerFixture({ now: () => NOW })
  // Align the synced tables with the fake Meta account's real-shaped source structure.
  await db.exec('DELETE FROM meta_ad_sets; DELETE FROM meta_ad_campaigns')
  await db.query("INSERT INTO meta_ad_campaigns VALUES ($1,$2,'Killer Katering - Copenhagen Leads (V1)','ACTIVE',NULL), ($3,$2,'Malmö Brand - Foodies Always On (V2)','ACTIVE',NULL)", [SRC.campaign, ACCOUNT, SRC.malmoCampaign])
  await db.query("INSERT INTO meta_ad_sets VALUES ($1,$2,'Katering Leads - Greater Copenhagen Broad','ACTIVE','8000')", [SRC.adSet, SRC.campaign])
  await seedRun(db, RUN_OLD, '2026-10-01T10:00:00Z')
  await seedRun(db, RUN_NEW, '2026-10-08T10:00:00Z', { headroom: 2721.36, recommendations: [tracking, creative, newCampaign] })
}, 120_000)
afterEach(async () => { await db.close() })

describe('prepare never has a side effect', () => {
  it('stores a prepared row and an audit event; nothing is created, reserved or contacted', async () => {
    const out = await prepare(2)
    expect(out).toMatchObject({ ok: true, alreadyStarted: false, preview: { mode: 'campaign_creation', market: 'Malmö' } })
    expect(await impl(2)).toMatchObject({ status: 'prepared', implementation_mode: 'campaign_creation', budget_reserved_dkk: '0.00' })
    expect(await reserved()).toBe(0); expect(await tasks()).toHaveLength(0); expect(fx.meta.calls).toEqual([])
    expect((await rows("SELECT action FROM audit_events WHERE entity_type='paid_strategy_implementation'")).map(r => r.action)).toEqual(['marketing.paid_strategy_implementation.prepared'])
  })
  it('hands the browser no platform plan, ids or account', async () => {
    const out = await prepare(2)
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`${SRC.campaign}|act_7001|"plan"`))
  })
  it('only the latest run can be prepared or confirmed', async () => {
    expect(await prepare(0, {}, RUN_OLD)).toMatchObject({ ok: false, error: expect.stringContaining('Superseded by a newer strategy') })
    expect(await confirmImplementation(sb as never, uid(2), RUN_OLD, 0, {}, NOW, injected())).toMatchObject({ ok: false })
    expect(await rows('SELECT * FROM marketing_paid_strategy_implementations')).toHaveLength(0)
  })
})

describe('Malmö campaign: Kockpit builds it, then waits for activation approval', () => {
  it('confirm -> reserves the budget, creates the PAUSED structure, verifies it, and stops at READY TO ACTIVATE with no task', async () => {
    const out = await confirm(2)
    expect(out).toMatchObject({ ok: true, duplicate: false, status: 'ready_to_activate' })
    expect(await impl(2)).toMatchObject({ status: 'ready_to_activate', implementation_mode: 'campaign_creation', budget_reserved_dkk: '2100.00', approved_by_user_id: uid(2), linked_task_id: null })
    expect(await reserved()).toBe(2100)
    expect(creates().map(c => c.op)).toEqual(['create_campaign', 'create_adset', 'create_creative', 'create_ad'])
    expect(await tasks()).toHaveLength(0)
    const ledger = (await impl(2)).execution as { evidence: { created: Record<string, string> }; steps: { key: string }[] }
    expect(Object.keys(ledger.evidence.created)).toEqual(expect.arrayContaining(['campaignId', 'adSetId', 'creativeId', 'adId']))
    expect(metaOps().filter(o => o.startsWith('meta_resume'))).toEqual([]) // creation never activates
  })
  it('persists a ledger Kockpit can resume from, and an audit trail with actor, mode, budget and steps', async () => {
    await confirm(2)
    const events = await rows("SELECT action, actor_user_id, after_json FROM audit_events WHERE entity_type='paid_strategy_implementation' ORDER BY created_at")
    expect(events.map(e => e.action)).toEqual(expect.arrayContaining(['marketing.paid_strategy_implementation.approved', 'marketing.paid_strategy_implementation.ready_to_activate']))
    const ready = events.find(e => String(e.action).endsWith('.ready_to_activate'))!
    expect(ready.actor_user_id).toBe(uid(2)); expect(ready.after_json).toMatchObject({ mode: 'campaign_creation', budget_reserved_dkk: 2100, status: 'ready_to_activate' })
    expect((ready.after_json as { steps: { key: string; status: string }[] }).steps.map(s => s.key)).toEqual(expect.arrayContaining(['preflight', 'create_campaign', 'create_ad', 'final_verify']))
    expect(JSON.stringify(events)).not.toMatch(/token|secret|password|api[_-]?key/i)
  })
  it('a double click builds one structure, reserves once, and never creates a second', async () => {
    const [a, b] = await Promise.all([confirm(2), confirm(2)])
    expect([a, b].filter(r => r.ok && !r.duplicate)).toHaveLength(1); expect([a, b].filter(r => r.ok && r.duplicate)).toHaveLength(1)
    expect(await reserved()).toBe(2100); expect(creates().filter(c => c.op === 'create_campaign')).toHaveLength(1)
    expect([...fx.meta.state.campaigns.values()].filter(c => String(c.name).includes('Malmö Leads') || String(c.name).includes('[KK-'))).toHaveLength(1)
    expect(await rows("SELECT * FROM audit_events WHERE action='marketing.paid_strategy_implementation.approved'")).toHaveLength(1)
  })
  it('an interruption part-way is recorded, and resume completes only what is missing', async () => {
    fx.meta.behave.failCreate.ad = new MetaApiError('Invalid creative', 100)
    const first = await confirm(2)
    expect(first).toMatchObject({ ok: true, status: 'needs_attention' })
    expect(await impl(2)).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('Meta rejected the ad') })
    expect(await reserved()).toBe(2100) // still held while it is unresolved
    delete fx.meta.behave.failCreate.ad
    const second = await resume(2)
    expect(second).toMatchObject({ ok: true, status: 'ready_to_activate' })
    expect([...fx.meta.state.campaigns.values()].filter(c => String(c.name).includes('[KK-'))).toHaveLength(1)
    expect([...fx.meta.state.adSets.values()].filter(c => String(c.name).includes('[KK-'))).toHaveLength(1)
  })
  it('resume is a no-op while Kockpit is actively working, and only takes over an interrupted run', async () => {
    await db.query("INSERT INTO marketing_paid_strategy_implementations(strategy_run_id,recommendation_index,recommendation_snapshot,implementation_mode,status,approved_at,budget_reserved_dkk,updated_at) VALUES ($1,1,'{}','creative_execution','executing',now(),0,'2026-10-10T08:59:00Z')", [RUN_NEW])
    expect(await resume(1)).toMatchObject({ ok: true, duplicate: true, message: expect.stringContaining('already being worked on') })
    expect(creates()).toHaveLength(0)
    await db.query("UPDATE marketing_paid_strategy_implementations SET updated_at='2026-10-10T08:00:00Z' WHERE recommendation_index=1") // interrupted an hour ago
    expect(await resume(1)).toMatchObject({ ok: true, duplicate: false, status: 'ready_to_activate' })
    expect(creates().map(c => c.op)).toEqual(['create_creative', 'create_ad'])
  })
  it('activation is a separate approval: it verifies, activates ad -> ad set -> campaign, and a second click does nothing', async () => {
    await confirm(2)
    expect(await activate(1)).toMatchObject({ ok: false }) // nothing ready for the creative rec
    const out = await activate(2)
    expect(out).toMatchObject({ ok: true, status: 'in_motion' })
    expect(metaOps().filter(o => o.startsWith('meta_resume') || o === 'set_end_time')).toEqual(['set_end_time', 'meta_resume_ad', 'meta_resume_adset', 'meta_resume_campaign'])
    expect(await impl(2)).toMatchObject({ status: 'in_motion' }); expect(await reserved()).toBe(2100)
    const again = await activate(2)
    expect(again).toMatchObject({ ok: true, duplicate: true }); expect(metaOps().filter(o => o === 'meta_resume_campaign')).toHaveLength(1)
    expect((await rows("SELECT action FROM audit_events WHERE action LIKE '%.activated'"))).toHaveLength(1)
  })
  it('activation refuses a structure that changed in Meta, and activates nothing', async () => {
    await confirm(2)
    const ledger = (await impl(2)).execution as { evidence: { created: { campaignId: string } } }
    fx.meta.state.campaigns.get(ledger.evidence.created.campaignId)!.status = 'ACTIVE'
    expect(await activate(2)).toMatchObject({ ok: false, error: expect.stringContaining('changed in Meta') })
    expect(metaOps().filter(o => o.startsWith('meta_resume'))).toEqual([])
  })
  it('cancel releases the reservation; what was created stays paused in Meta and cannot spend', async () => {
    await confirm(2)
    const out = await cancel(2)
    expect(out).toMatchObject({ ok: true, status: 'cancelled', message: expect.stringContaining('stay paused') })
    expect(await reserved()).toBe(0)
    expect([...fx.meta.state.campaigns.values()].filter(c => String(c.name).includes('[KK-')).every(c => c.status === 'PAUSED')).toBe(true)
    expect(await activate(2)).toMatchObject({ ok: false })
  })
  it('shared headroom: approved work reduces what the next campaign can use, and what does not fit is a question, not a task', async () => {
    await confirm(2) // 2,100 of 2,721.36 reserved
    expect(await reserved()).toBe(2100)
    const lund = { ...newCampaign, title: 'Launch a Lund catering leads campaign mirroring C2', exact_test_or_action: 'Create a new leads campaign in Lund mirroring C2. Set a daily budget of 100 DKK and run for 21 days, spending at most 2,100 DKK incremental.' }
    await db.query('UPDATE marketing_paid_strategy_runs SET recommendations=$1 WHERE id=$2', [JSON.stringify([tracking, lund, newCampaign]), RUN_NEW])
    const before = creates().length
    const preview = await prepare(1)
    expect(preview).toMatchObject({ ok: true, preview: { mode: 'needs_input', intendedMode: 'campaign_creation', budget: { availableDkk: 621.36, reservedByOthersDkk: 2100 } } })
    expect((preview as { preview: { missing: { detail: string }[] } }).preview.missing[0].detail).toContain('Only 621.36 DKK of the shared headroom is still available')
    const out = await confirm(1)
    expect(out).toMatchObject({ ok: false, needsInput: [{ key: 'reserve_budget' }] })
    expect(creates()).toHaveLength(before); expect(await reserved()).toBe(2100); expect(await tasks()).toHaveLength(0)
  })
  it('unreliable or null headroom refuses extra budget, and creates nothing', async () => {
    await db.query("UPDATE marketing_paid_strategy_runs SET evidence = jsonb_set(evidence, '{budget,projection,reliable}', 'false') WHERE id=$1", [RUN_NEW])
    const out = await confirm(2)
    expect(out).toMatchObject({ ok: false, needsInput: [{ key: 'reserve_budget' }] })
    expect(fx.meta.calls).toEqual([]); expect(await reserved()).toBe(0)
  })
  it('a missing creation permission is a precise access state after approval, not a task', async () => {
    const f = runnerFixture({ now: () => NOW, capabilities: prodCapabilities() })
    f.meta.behave.failValidate = new MetaApiError('(#200) Requires pages_manage_ads permission to manage the object', 200)
    const out = await confirmImplementation(sb as never, uid(2), RUN_NEW, 2, {}, NOW, { capabilities: prodCapabilities(), deps: f.deps })
    expect(out).toMatchObject({ ok: true, status: 'waiting_for_access', blockers: [{ kind: 'access', code: 'meta_permission' }] })
    expect(await tasks()).toHaveLength(0); expect(await impl(2)).toMatchObject({ status: 'waiting_for_access' })
    const { views } = await loadImplementationViews(sb as never, [RUN_NEW])
    expect(views[0]).toMatchObject({ status: 'waiting_for_access', blockers: [{ code: 'meta_permission', unblock: expect.stringContaining('Business Manager') }] })
  })
})

describe('tracking: investigate, implement if possible, otherwise exact blockers', () => {
  it('confirm diagnoses the real stack and stops at the precise missing access, with no task and no reservation', async () => {
    const out = await confirm(0)
    expect(out).toMatchObject({ ok: true, status: 'waiting_for_access', blockers: [{ code: 'lead_source_missing' }, { code: 'enquiry_contact_unreadable' }] })
    expect(await impl(0)).toMatchObject({ status: 'waiting_for_access', implementation_mode: 'tracking_execution', budget_reserved_dkk: '0.00', linked_task_id: null })
    expect(await tasks()).toHaveLength(0)
    const ledger = (await impl(0)).execution as { evidence: { diagnosis: { site: { platform: string } } } }
    expect(ledger.evidence.diagnosis.site.platform).toBe('webflow')
    expect(creates()).toHaveLength(0)
  })
  it('"Check again" re-runs the diagnosis without side effects, and still never creates a task', async () => {
    await confirm(0)
    const again = await resume(0)
    expect(again).toMatchObject({ ok: true, status: 'waiting_for_access' }); expect(await tasks()).toHaveLength(0)
    expect(await cancel(0)).toMatchObject({ ok: true, status: 'cancelled' })
  })
})

describe('creative: Kockpit writes it and prepares a paused ad', () => {
  it('confirm saves the creative draft and a PAUSED ad in the existing ad set, ready for review', async () => {
    const out = await confirm(1)
    expect(out).toMatchObject({ ok: true, status: 'ready_to_activate' })
    const draft = (await rows('SELECT * FROM marketing_paid_strategy_creative_drafts'))[0]
    expect(draft).toMatchObject({ headline: 'Team lunch, 149 DKK per person', cta: 'GET_QUOTE', asset_state: 'existing_images', approval_state: 'pending_review' })
    expect(draft.hook_options).toHaveLength(3)
    expect((draft.test_design as { changed: string[] }).changed).toEqual(['primary text', 'headline', 'call to action'])
    const { views } = await loadImplementationViews(sb as never, [RUN_NEW])
    const view = views.find(v => v.recommendationIndex === 1)!
    expect(view.review).toMatchObject({ kind: 'creative' }); expect(view.review!.lines.map(l => l.label)).toEqual(expect.arrayContaining(['Headline', 'Primary text', 'Variable tested', 'Success metric']))
    expect(await tasks()).toHaveLength(0); expect(creates().map(c => c.op)).toEqual(['create_creative', 'create_ad'])
  })
  it('activating approves the draft and switches on only the new ad', async () => {
    await confirm(1)
    expect(await activate(1)).toMatchObject({ ok: true, status: 'in_motion' })
    expect(metaOps().filter(o => o.startsWith('meta_resume'))).toEqual(['meta_resume_ad'])
    expect((await rows('SELECT approval_state FROM marketing_paid_strategy_creative_drafts'))[0].approval_state).toBe('approved')
  })
  it('only genuinely new footage creates a task, linked to the implementation, and no Meta ad is made', async () => {
    const f = runnerFixture({ now: () => NOW, creative: vi.fn(async () => ({ ok: true as const, model: 'm', package: goodPackage({ requires_new_footage: true, video_script: 'Your team lunch, sorted. 149 DKK per person, minimum 10 people.', shot_list: ['Falafel platter close-up', 'Hands tearing flatbread', 'Team at a table'] }) })) })
    const out = await confirmImplementation(sb as never, uid(2), RUN_NEW, 1, { ownerUserId: uid(6), dueDate: '2026-10-17' }, NOW, { capabilities: prodCapabilities(), deps: f.deps })
    expect(out).toMatchObject({ ok: true, status: 'waiting_for_input', blockers: [{ kind: 'physical', code: 'film_shots' }] })
    const [task] = await tasks()
    expect(task).toMatchObject({ title: 'Film 3 shots for the approved catering ad', owner_user_id: uid(6) }); expect(String(task.description)).not.toMatch(/investigate|strategy|hypothesis/i)
    expect((await impl(1)).linked_task_id).toBe(task.id)
    expect(f.meta.calls.filter(c => c.op.startsWith('create_') && !c.validateOnly)).toHaveLength(0)
  })
})

describe('existing-object changes still go through the unchanged trusted executor', () => {
  async function budgetRun() {
    const runId = '58000000-0000-4000-8000-0000000000aa'
    await seedRun(db, runId, '2026-10-09T09:00:00Z', { headroom: 2721.36, recommendations: [{ ...budget, exact_test_or_action: 'Lower the daily budget on C3.' }, tracking, creative] })
    await db.query("UPDATE meta_ad_campaigns SET daily_budget='10000' WHERE id=$1", [SRC.malmoCampaign])
    fx.meta.state.campaigns.get(SRC.malmoCampaign)!.status = 'ACTIVE'
    return runId
  }
  it('a pause is executed once, verified by read-back, and completed; a double click mutates once', async () => {
    const runId = await budgetRun()
    const go = () => confirmImplementation(sb as never, uid(2), runId, 0, { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: SRC.malmoCampaign } }, NOW, injected())
    const [a, b] = await Promise.all([go(), go()])
    expect([a, b].filter(r => r.ok && !r.duplicate)).toHaveLength(1)
    expect(metaOps().filter(o => o === 'meta_pause_campaign')).toHaveLength(1)
    expect(fx.meta.state.campaigns.get(SRC.malmoCampaign)!.status).toBe('PAUSED')
    expect((await rows('SELECT status, result FROM marketing_paid_strategy_implementations WHERE strategy_run_id=$1', [runId]))[0]).toMatchObject({ status: 'completed', result: { action_type: 'meta_pause_campaign', before: { status: 'ACTIVE' }, after: { status: 'PAUSED' } } })
  })
  it('keeps the 20% guardrail: a 30% change never reaches Meta', async () => {
    const runId = await budgetRun()
    const out = await confirmImplementation(sb as never, uid(2), runId, 0, { platform: { action: 'set_daily_budget', targetType: 'campaign', targetId: SRC.malmoCampaign, targetDailyBudget: 70 } }, NOW, injected())
    expect(out.ok).toBe(false); expect(metaOps().filter(o => o.startsWith('meta_'))).toEqual([])
  })
  it('an uncertain outcome is never retried, even by a later resume', async () => {
    const runId = await budgetRun()
    fx.meta.state.campaigns.get(SRC.malmoCampaign)!.status = 'ARCHIVED'
    const out = await confirmImplementation(sb as never, uid(2), runId, 0, { platform: { action: 'pause_campaign', targetType: 'campaign', targetId: SRC.malmoCampaign } }, NOW, injected())
    expect(out.ok).toBe(false)
    expect(await resumeImplementation(sb as never, uid(2), runId, 0, {}, NOW, injected())).toMatchObject({ ok: false, error: expect.stringContaining('never retried automatically') })
  })
})
