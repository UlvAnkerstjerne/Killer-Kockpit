import { describe, expect, it, vi } from 'vitest'
import { MetaApiError } from '@/lib/meta/client'
import { runActivation, runCampaignCreation, runCreativeExecution, runTrackingExecution, UNCERTAIN_WAIT_MS } from '@/lib/marketing/paid-strategy/autonomous/runner'
import { stepId } from '@/lib/marketing/paid-strategy/autonomous/types'
import { discoverCapabilities, inputsFromEnv } from '@/lib/marketing/paid-strategy/autonomous/capabilities'
import { goodPackage } from '../../../../helpers/creative-package'
import { PROD_ENV, prodCapabilities, runnerFixture } from '../../../../helpers/fake-meta'
import { SRC } from '../../../../helpers/meta-source-config'

const ops = (f: ReturnType<typeof runnerFixture>) => f.meta.calls.map(c => c.op)
const creates = (f: ReturnType<typeof runnerFixture>) => f.meta.calls.filter(c => c.op.startsWith('create_') && !c.validateOnly)
const count = (f: ReturnType<typeof runnerFixture>, op: string) => ops(f).filter(o => o === op).length
const allPaused = (f: ReturnType<typeof runnerFixture>) => [...f.meta.state.campaigns.values(), ...f.meta.state.adSets.values(), ...f.meta.state.ads.values()].filter(o => String(o.name).includes('[KK-ab12cd34]')).every(o => o.status === 'PAUSED')

describe('Malmö campaign creation (the real C2 structure)', () => {
  it('creates the whole structure PAUSED, verifies it, and stops at READY TO ACTIVATE', async () => {
    const f = runnerFixture(); const c = f.ctx()
    const r = await runCampaignCreation(c, f.deps)
    expect(r.status).toBe('ready_to_activate')
    expect(r.blockers).toEqual([])
    expect(creates(f).map(x => x.op)).toEqual(['create_campaign', 'create_adset', 'create_creative', 'create_ad'])
    expect(allPaused(f)).toBe(true)
    expect(count(f, 'meta_resume_ad') + count(f, 'meta_resume_adset') + count(f, 'meta_resume_campaign')).toBe(0) // creation never activates
    expect(r.ledger.evidence.created).toMatchObject({ allPaused: true })
    expect(f.handoffs).toEqual([]) // no task for work Kockpit did itself
  })
  it('validates with Meta before creating anything', async () => {
    const f = runnerFixture(); await runCampaignCreation(f.ctx(), f.deps)
    const firstCreate = f.meta.calls.findIndex(c => c.op.startsWith('create_') && !c.validateOnly)
    const validations = f.meta.calls.slice(0, firstCreate).filter(c => c.validateOnly)
    expect(validations.map(v => v.op)).toEqual(['create_campaign', 'create_adset', 'create_creative'])
  })
  it('wires the new objects together with server-read ids, never ids from advice text', async () => {
    const f = runnerFixture(); const r = await runCampaignCreation(f.ctx(), f.deps)
    const { campaignId, adSetId, creativeId, adId } = r.ledger.evidence.created as Record<string, string>
    expect(f.meta.state.adSets.get(adSetId)).toMatchObject({ campaign_id: campaignId, daily_budget: '10000' })
    expect(f.meta.state.ads.get(adId)).toMatchObject({ adset_id: adSetId, creative: { id: creativeId } })
    for (const id of [campaignId, adSetId, creativeId, adId]) expect(id).not.toBe(SRC.campaign)
    const adSetCall = (f.meta.port.createAdSet as ReturnType<typeof vi.fn>).mock.calls.find(c => c[2] === false)![1]
    expect(adSetCall.campaignId).toBe(campaignId)
  })
  it('targets Malmö with the geography the account already uses, and keeps the source optimisation', async () => {
    const f = runnerFixture(); const r = await runCampaignCreation(f.ctx(), f.deps)
    const set = f.meta.state.adSets.get((r.ledger.evidence.created as { adSetId: string }).adSetId)!
    expect(JSON.stringify(set.targeting)).toContain('Malmö'); expect(JSON.stringify(set.targeting)).not.toContain('Copenhagen')
    expect(set.promoted_object).toMatchObject({ pixel_id: '942936014341416', custom_event_type: 'LEAD' }); expect(set.optimization_goal).toBe('OFFSITE_CONVERSIONS')
  })
  it('records every step in the ledger and saves state through planning, executing, verifying', async () => {
    const f = runnerFixture(); const c = f.ctx(); const r = await runCampaignCreation(c, f.deps)
    expect(r.ledger.steps.map(s => s.key)).toEqual(expect.arrayContaining(['preflight', 'create_campaign', 'create_adset', 'create_creative', 'create_ad', 'final_verify']))
    const seen = new Set(f.saved.map(s => s.status))
    for (const s of ['planning', 'executing', 'verifying', 'ready_to_activate']) expect(seen.has(s as never), s).toBe(true)
  })

  it('PARTIAL FAILURE: an ad that Meta rejects leaves the earlier objects, recorded, and a retry creates only what is missing', async () => {
    const f = runnerFixture(); const c = f.ctx()
    f.meta.behave.failCreate.ad = new MetaApiError('Invalid creative', 100)
    const first = await runCampaignCreation(c, f.deps)
    expect(first.status).toBe('needs_attention'); expect(first.message).toContain('Meta rejected the ad')
    expect(stepId(first.ledger, 'create_campaign')).toBeTruthy(); expect(stepId(first.ledger, 'create_adset')).toBeTruthy(); expect(stepId(first.ledger, 'create_creative')).toBeTruthy()
    expect(allPaused(f)).toBe(true)

    delete f.meta.behave.failCreate.ad
    const second = await runCampaignCreation(f.ctx({ ledger: first.ledger }), f.deps)
    expect(second.status).toBe('ready_to_activate')
    const tagged = (m: Map<string, { name: unknown }>) => [...m.values()].filter(o => String(o.name).includes('[KK-ab12cd34]')).length
    expect([tagged(f.meta.state.campaigns), tagged(f.meta.state.adSets), tagged(f.meta.state.creatives), tagged(f.meta.state.ads)]).toEqual([1, 1, 1, 1]) // nothing duplicated
    expect(creates(f).filter(x => x.op === 'create_campaign')).toHaveLength(1); expect(creates(f).filter(x => x.op === 'create_adset')).toHaveLength(1) // not even attempted again
  })
  it('a fresh run with no ledger still never duplicates: it finds the objects by their name token and adopts them', async () => {
    const f = runnerFixture()
    f.meta.behave.failCreate.ad = new MetaApiError('Invalid creative', 100)
    await runCampaignCreation(f.ctx(), f.deps)
    delete f.meta.behave.failCreate.ad
    const r = await runCampaignCreation(f.ctx(), f.deps) // ledger lost
    expect(r.status).toBe('ready_to_activate')
    expect(f.meta.state.campaigns.size).toBe(3) // C2, Malmö brand, and exactly one new campaign
    expect(r.ledger.steps.find(s => s.key === 'create_campaign')?.detail).toMatchObject({ adopted: true })
  })
  it('UNCERTAIN create that did succeed: the retry adopts it, never creates a second', async () => {
    const f = runnerFixture(); f.meta.behave.uncertain.adset = { created: true }
    const first = await runCampaignCreation(f.ctx(), f.deps)
    expect(first.status).toBe('needs_attention'); expect(first.message).toContain('may exist')
    const second = await runCampaignCreation(f.ctx({ ledger: first.ledger }), f.deps)
    expect(second.status).toBe('ready_to_activate')
    expect(creates(f).filter(x => x.op === 'create_adset')).toHaveLength(1)
  })
  it('UNCERTAIN create that did NOT succeed: waits, then creates exactly once', async () => {
    const f = runnerFixture(); f.meta.behave.uncertain.adset = { created: false }
    const first = await runCampaignCreation(f.ctx(), f.deps)
    expect(first.status).toBe('needs_attention')
    const tooSoon = await runCampaignCreation(f.ctx({ ledger: first.ledger }), f.deps)
    expect(tooSoon.status).toBe('needs_attention'); expect(tooSoon.message).toContain('look it up again after a short wait')
    expect(creates(f).filter(x => x.op === 'create_adset')).toHaveLength(1) // the one uncertain attempt; no immediate blind retry
    f.advance(UNCERTAIN_WAIT_MS + 1000)
    const later = await runCampaignCreation(f.ctx({ ledger: first.ledger }), f.deps)
    expect(later.status).toBe('ready_to_activate')
    expect(f.meta.state.adSets.size).toBe(3) // source ad set, Malmö brand ad set, one new
  })
  it('two objects with the same token and name are never resolved by guessing', async () => {
    const f = runnerFixture(); const dup = { name: 'Killer Katering - Malmö Leads [KK-ab12cd34]', status: 'PAUSED' }
    const plan = await runCampaignCreation(f.ctx(), f.deps)
    const c0 = f.meta.state.campaigns.get((plan.ledger.evidence.created as { campaignId: string }).campaignId)!
    f.meta.state.campaigns.set('777', { ...c0, id: '777', ...dup, name: c0.name })
    const f2Ledger = { ...plan.ledger, steps: plan.ledger.steps.filter(s => s.key !== 'create_campaign') }
    const r = await runCampaignCreation(f.ctx({ ledger: f2Ledger }), f.deps)
    expect(r.status).toBe('needs_attention'); expect(r.message).toContain('More than one campaign')
  })
  it('Meta read-back that disagrees (an ad that came back ACTIVE) stops everything', async () => {
    const f = runnerFixture(); f.meta.behave.ignoreStatus = true
    const r = await runCampaignCreation(f.ctx(), f.deps)
    expect(r.status).toBe('needs_attention'); expect(r.message).toContain('did not read back as expected')
    expect(r.ledger.evidence.created).toBeUndefined()
  })
  it('a validation rejection creates nothing at all', async () => {
    const f = runnerFixture(); f.meta.behave.failValidate = new MetaApiError('Invalid targeting spec', 100)
    const r = await runCampaignCreation(f.ctx(), f.deps)
    expect(r.status).toBe('needs_attention'); expect(r.message).toContain('validation only, nothing was created')
    expect(creates(f)).toHaveLength(0)
  })
  it('a Meta permission refusal becomes an exact access blocker, not a task', async () => {
    const f = runnerFixture(); f.meta.behave.failValidate = new MetaApiError('(#200) Requires pages_manage_ads permission to manage the object', 200)
    const r = await runCampaignCreation(f.ctx(), f.deps)
    expect(r.status).toBe('waiting_for_access')
    expect(r.blockers[0]).toMatchObject({ kind: 'access', code: 'meta_permission', capability: 'meta_creative_creation' })
    expect(r.blockers[0].unblock).toContain('Business Manager'); expect(f.handoffs).toEqual([]); expect(creates(f)).toHaveLength(0)
  })

  it('account ownership: a source in another account, or no configured account, creates nothing', async () => {
    const f = runnerFixture()
    const r = await runCampaignCreation(f.ctx({ source: { campaignId: SRC.campaign, accountId: 'act_other', name: 'x', currency: 'DKK' } }), f.deps)
    expect(r.status).toBe('waiting_for_access'); expect(r.blockers[0].code).toBe('account_mismatch'); expect(creates(f)).toHaveLength(0)
    expect((await runCampaignCreation(f.ctx({ configuredAccountId: undefined }), f.deps)).blockers[0].code).toBe('account_unconfigured')
  })
  it('budget ceiling: a plan above the approved amount, or with no stated budget, is a question and creates nothing', async () => {
    const f = runnerFixture()
    const over = await runCampaignCreation(f.ctx({ dailyBudgetDkk: 150 }), f.deps)
    expect(over).toMatchObject({ status: 'waiting_for_input', blockers: [{ code: 'budget_over_approval' }] })
    const none = await runCampaignCreation(f.ctx({ dailyBudgetDkk: null, durationDays: null }), f.deps)
    expect(none.blockers[0]).toMatchObject({ kind: 'input', code: 'budget' })
    expect(creates(f)).toHaveLength(0)
  })
  it('missing creation capability is an exact access blocker', async () => {
    const f = runnerFixture({ capabilities: prodCapabilities(PROD_ENV, ['ads_read']) })
    const r = await runCampaignCreation(f.ctx(), f.deps)
    expect(r.status).toBe('waiting_for_access'); expect(r.blockers.map(b => b.capability)).toContain('meta_campaign_creation'); expect(creates(f)).toHaveLength(0)
  })
})

describe('activation is separate, verified and idempotent', () => {
  async function created() {
    const f = runnerFixture(); const r = await runCampaignCreation(f.ctx(), f.deps)
    return { f, ledger: r.ledger, ids: r.ledger.evidence.created as { campaignId: string; adSetId: string; adId: string } }
  }
  const act = (f: ReturnType<typeof runnerFixture>, ledger: never) => ({ ledger, configuredAccountId: SRC.act, durationDays: 21, mode: 'campaign_creation' as const, save: vi.fn(async () => {}) })

  it('sets the end date, then activates ad -> ad set -> campaign through the trusted executor, reading each back', async () => {
    const { f, ledger, ids } = await created()
    const r = await runActivation(act(f, ledger as never), f.deps)
    expect(r.status).toBe('in_motion')
    expect(ops(f).filter(o => o.startsWith('meta_resume') || o === 'set_end_time')).toEqual(['set_end_time', 'meta_resume_ad', 'meta_resume_adset', 'meta_resume_campaign'])
    expect([f.meta.state.ads.get(ids.adId)!.status, f.meta.state.adSets.get(ids.adSetId)!.status, f.meta.state.campaigns.get(ids.campaignId)!.status]).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE'])
    const end = Date.parse(String(f.meta.state.adSets.get(ids.adSetId)!.end_time)); expect(end - f.deps.now().getTime()).toBe(21 * 86_400_000)
  })
  it('refuses when the structure changed since it was created, and activates nothing', async () => {
    const { f, ledger, ids } = await created()
    f.meta.state.campaigns.get(ids.campaignId)!.status = 'ACTIVE'
    expect((await runActivation(act(f, ledger as never), f.deps)).status).toBe('needs_attention')
    f.meta.state.campaigns.get(ids.campaignId)!.status = 'PAUSED'; f.meta.state.adSets.get(ids.adSetId)!.daily_budget = '99999'
    const r = await runActivation(act(f, ledger as never), f.deps)
    expect(r).toMatchObject({ status: 'needs_attention', message: expect.stringContaining('no longer matches the approved budget') })
    expect(count(f, 'meta_resume_ad')).toBe(0)
  })
  it('a failure part-way is recorded; the retry does not repeat what already succeeded', async () => {
    const { f, ledger } = await created()
    const real = f.deps.executePlan; let failing = true
    f.deps.executePlan = async plan => failing && plan.action_type === 'meta_resume_adset' ? { ok: false, status: 'needs_attention', reason: 'Meta did not confirm the change' } : real(plan)
    const first = await runActivation(act(f, ledger as never), f.deps)
    expect(first.status).toBe('needs_attention'); expect(count(f, 'meta_resume_ad')).toBe(1); expect(count(f, 'meta_resume_campaign')).toBe(0) // the campaign is never activated over a failed ad set
    failing = false
    const second = await runActivation(act(f, first.ledger as never), f.deps)
    expect(second.status).toBe('in_motion'); expect(count(f, 'meta_resume_ad')).toBe(1); expect(count(f, 'meta_resume_adset')).toBe(1); expect(count(f, 'meta_resume_campaign')).toBe(1)
  })
  it('a repeated activation after success does nothing more', async () => {
    const { f, ledger } = await created()
    const first = await runActivation(act(f, ledger as never), f.deps)
    const again = await runActivation(act(f, first.ledger as never), f.deps)
    expect(again.status).toBe('in_motion'); expect(count(f, 'meta_resume_campaign')).toBe(1); expect(count(f, 'set_end_time')).toBe(1)
  })
})

describe('creative execution', () => {
  const rec = { title: 'Test a direct-response offer creative in the catering lead campaign', hypothesis: 'A second creative using an explicit offer hook will lift the lead rate.', exact_test_or_action: 'Within C2, introduce one new ad alongside the existing one with an offer-first hook for 14 days.', success_metric: 'Higher link-to-lead rate than the existing ad.', incremental_budget_dkk: 0 }
  it('writes the creative, saves the draft, and creates a PAUSED ad in the existing ad set, then waits for activation', async () => {
    const f = runnerFixture(); const r = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    expect(r.status).toBe('ready_to_activate')
    expect(f.deps.generateCreative).toHaveBeenCalledTimes(1)
    expect(f.drafts).toHaveLength(1); expect(f.drafts[0]).toMatchObject({ assetState: 'existing_images', pkg: { cta: 'GET_QUOTE' } })
    const { adId, adSetId } = r.ledger.evidence.created as { adId: string; adSetId: string }
    expect(adSetId).toBe(SRC.adSet) // the control's ad set, resolved by the server
    expect(f.meta.state.ads.get(adId)).toMatchObject({ status: 'PAUSED', adset_id: SRC.adSet })
    expect(creates(f).map(x => x.op)).toEqual(['create_creative', 'create_ad'])
    expect(f.handoffs).toEqual([]) // existing images are reused: nothing for a person to do
  })
  it('the test design is computed from the structure: what changed, what is constant', async () => {
    const f = runnerFixture(); const r = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    const td = r.ledger.evidence.testDesign as { changed: string[]; heldConstant: string[]; durationDays: number; needsBusinessDecision: string[] }
    expect(td.changed).toEqual(['primary text', 'headline', 'call to action']); expect(td.heldConstant.join(' ')).toContain('identical to the existing ad')
    expect(td.durationDays).toBe(14); expect(td.needsBusinessDecision).toEqual(['Whether to promise a same-day quote'])
  })
  it('a retry reuses the written package and never asks the model again, nor duplicates the ad', async () => {
    const f = runnerFixture(); const first = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    const again = await runCreativeExecution(f.ctx({ rec, market: null, ledger: first.ledger }), f.deps)
    expect(again.status).toBe('ready_to_activate'); expect(f.deps.generateCreative).toHaveBeenCalledTimes(1); expect(creates(f).filter(x => x.op === 'create_ad')).toHaveLength(1)
  })
  it('only genuinely new footage creates a task, and it is just the shots', async () => {
    const f = runnerFixture({ creative: vi.fn(async () => ({ ok: true as const, model: 'm', package: goodPackage({ requires_new_footage: true, video_script: 'Your team lunch sorted. 149 DKK per person, minimum 10 people.', shot_list: ['Falafel platter close-up', 'Hands tearing flatbread', 'Team at a table', 'Box with logo'] }) })) })
    const r = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    expect(r).toMatchObject({ status: 'waiting_for_input', blockers: [{ kind: 'physical', code: 'film_shots' }] })
    expect(f.handoffs).toHaveLength(1); expect(f.handoffs[0]).toMatchObject({ title: 'Film 4 shots for the approved catering ad' })
    expect(creates(f)).toHaveLength(0) // no Meta ad without an asset
    await runCreativeExecution(f.ctx({ rec, market: null, ledger: r.ledger }), f.deps)
    expect(f.handoffs).toHaveLength(1) // asked once
  })
  it('an AI failure creates nothing and is retryable', async () => {
    const f = runnerFixture({ creative: vi.fn(async () => ({ ok: false as const, error: 'The creative could not be written. Nothing was created.' })) })
    const r = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    expect(r.status).toBe('failed'); expect(creates(f)).toHaveLength(0); expect(f.drafts).toHaveLength(0)
  })
  it('ambiguity is a question: two active control ads', async () => {
    const f = runnerFixture(); f.meta.state.ads.set('555', { ...f.meta.state.ads.get(SRC.ad)!, id: '555' })
    const r = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    expect(r).toMatchObject({ status: 'waiting_for_input', blockers: [{ code: 'source_ad' }] }); expect(creates(f)).toHaveLength(0)
  })
  it('account ownership and a missing AI provider are exact blockers', async () => {
    const f = runnerFixture()
    expect((await runCreativeExecution(f.ctx({ rec, market: null, source: { campaignId: SRC.campaign, accountId: 'act_other', name: 'x', currency: 'DKK' } }), f.deps)).blockers[0].code).toBe('account_mismatch')
    const noAi = runnerFixture({ capabilities: discoverCapabilities(inputsFromEnv({ ...PROD_ENV, ANTHROPIC_API_KEY: '' }, ['ads_management'], [])) })
    expect((await runCreativeExecution(noAi.ctx({ rec, market: null }), noAi.deps)).blockers[0]).toMatchObject({ code: 'no_ai', kind: 'access' })
  })
  it('activation resumes only the new ad; the ad set and campaign are untouched', async () => {
    const f = runnerFixture(); const r = await runCreativeExecution(f.ctx({ rec, market: null }), f.deps)
    const out = await runActivation({ ledger: r.ledger, configuredAccountId: SRC.act, durationDays: null, mode: 'creative_execution', save: vi.fn(async () => {}) }, f.deps)
    expect(out.status).toBe('in_motion')
    expect(ops(f).filter(o => o.startsWith('meta_resume'))).toEqual(['meta_resume_ad'])
  })
})

describe('tracking execution', () => {
  it('production today: diagnoses the real stack, then BLOCKS with exact access needs and creates no task', async () => {
    const f = runnerFixture(); const r = await runTrackingExecution(f.ctx({ market: null }), f.deps, 'https://www.killerkebab.com/catering')
    expect(r.status).toBe('waiting_for_access')
    expect(r.blockers.map(b => b.code)).toEqual(['lead_source_missing', 'enquiry_contact_unreadable'])
    expect(f.deps.fetchSiteHtml).toHaveBeenCalledWith('https://www.killerkebab.com/catering'); expect(f.deps.readPixel).toHaveBeenCalledWith('942936014341416')
    expect(r.ledger.evidence.diagnosis).toMatchObject({ site: { platform: 'webflow', gtmContainers: ['GTM-P4RTHWT7'] }, pixel: { id: '942936014341416' } })
    expect(f.handoffs).toEqual([]); expect(creates(f)).toHaveLength(0); expect(r.status).not.toBe('completed')
  })
  it('an unreachable site is evidence, not a failure of the diagnosis', async () => {
    const f = runnerFixture(); (f.deps.fetchSiteHtml as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))
    const r = await runTrackingExecution(f.ctx({ market: null }), f.deps, 'https://www.killerkebab.com/catering')
    expect(r.status).toBe('waiting_for_access'); expect(r.ledger.evidence.diagnosis).toMatchObject({ siteError: 'timeout' })
  })
  it('completes only when the writer\'s own read-back confirms the event', async () => {
    const caps = discoverCapabilities(inputsFromEnv({ ...PROD_ENV, CATERING_LEAD_SOURCE: 'x', WEBFLOW_API_TOKEN: 'x' }, ['ads_management'], []))
    const verify = vi.fn(async () => ({ ok: true, evidence: 'Meta reports 1 CateringBookingConfirmed event received.' }))
    const f = runnerFixture({ capabilities: caps }); f.deps.writers = [{ id: 'meta_capi', write: async () => ({ ref: 'evt-9' }), verify }]
    expect(await runTrackingExecution(f.ctx({ market: null }), f.deps, 'https://www.killerkebab.com/catering')).toMatchObject({ status: 'completed', message: expect.stringContaining('1 CateringBookingConfirmed') })
    verify.mockResolvedValue({ ok: false, evidence: 'no events seen' } as never)
    expect((await runTrackingExecution(f.ctx({ market: null }), f.deps, 'https://www.killerkebab.com/catering')).status).toBe('needs_attention')
  })
})

describe('human work is a last resort', () => {
  it('none of the three production recommendations produces a task unless a physical act is genuinely required', async () => {
    const f = runnerFixture()
    await runTrackingExecution(f.ctx({ market: null }), f.deps, 'https://www.killerkebab.com/catering')
    await runCreativeExecution(f.ctx({ market: null }), f.deps)
    await runCampaignCreation(f.ctx(), f.deps)
    expect(f.deps.createHandoffTask).not.toHaveBeenCalled()
  })
})
