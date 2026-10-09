import { vi } from 'vitest'
import { MetaApiError } from '@/lib/meta/client'
import { MetaCreationUncertainError } from '@/lib/meta/creation'
import { executeTrustedPlan, type PaidMutationAdapter } from '@/lib/marketing/paid-recs/executor'
import { discoverCapabilities, inputsFromEnv } from '@/lib/marketing/paid-strategy/autonomous/capabilities'
import type { MetaPort, RunContext, RunnerDeps, RunStatus } from '@/lib/marketing/paid-strategy/autonomous/runner'
import { emptyLedger, type Blocker, type ExecutionLedger } from '@/lib/marketing/paid-strategy/autonomous/types'
import { goodPackage } from './creative-package'
import { malmoTargeting, pausedAd, SRC, sourceAd, sourceAdSet, sourceCampaign } from './meta-source-config'

type Obj = { id: string; name: string; status: string; effective_status?: string | null; [k: string]: unknown }

/** An in-memory Meta account. Creation is always PAUSED (as the real create calls force), reads reflect writes. */
export function fakeMeta() {
  let n = 800
  const state = {
    campaigns: new Map<string, Obj>(), adSets: new Map<string, Obj>(), ads: new Map<string, Obj>(), creatives: new Map<string, Obj>(),
  }
  const calls: { op: string; validateOnly?: boolean; name?: string }[] = []
  const behave = { failCreate: {} as Record<string, unknown>, uncertain: {} as Record<string, { created: boolean }>, failValidate: null as unknown, ignoreStatus: false }
  const act = SRC.act

  // Source structures: C2 (Copenhagen leads) and C3 (the existing Malmö brand campaign, used only for its geography).
  const c2 = sourceCampaign(), s2 = sourceAdSet(), a2 = sourceAd(), a2p = pausedAd()
  state.campaigns.set(c2.id, { ...c2, effective_status: 'ACTIVE' })
  state.adSets.set(s2.id, { ...s2 }); state.ads.set(a2.id, { ...a2 }); state.ads.set(a2p.id, { ...a2p })
  state.campaigns.set(SRC.malmoCampaign, { ...sourceCampaign({ id: SRC.malmoCampaign, name: 'Malmö Brand - Foodies Always On (V2)', objective: 'OUTCOME_AWARENESS' }), effective_status: 'ACTIVE' })
  state.adSets.set('120000000000000010', { ...sourceAdSet({ id: '120000000000000010', campaign_id: SRC.malmoCampaign, name: 'Malmö Foodies', targeting: { ...malmoTargeting } }) })

  const make = (store: Map<string, Obj>, kind: string, spec: Record<string, unknown>, validateOnly: boolean) => {
    calls.push({ op: `create_${kind}`, validateOnly, name: String(spec.name) })
    if (validateOnly) { if (behave.failValidate) throw behave.failValidate; return { validated: true as const } }
    if (behave.failCreate[kind]) throw behave.failCreate[kind]
    const unc = behave.uncertain[kind]
    const id = String(++n).padStart(18, '9')
    if (unc) { if (unc.created) store.set(id, { id, ...spec, status: 'PAUSED', effective_status: 'PAUSED' } as Obj); delete behave.uncertain[kind]; throw new MetaCreationUncertainError('timeout') }
    store.set(id, { id, ...spec, status: 'PAUSED', effective_status: 'PAUSED' } as Obj)
    return { id }
  }
  const port: MetaPort = {
    readCampaign: vi.fn(async id => { const c = state.campaigns.get(id); if (!c) throw new MetaApiError('not found'); return c as never }),
    readAdSets: vi.fn(async campaignId => [...state.adSets.values()].filter(s => s.campaign_id === campaignId) as never),
    readAds: vi.fn(async campaignId => { const sets = new Set([...state.adSets.values()].filter(s => s.campaign_id === campaignId).map(s => s.id)); return [...state.ads.values()].filter(a => sets.has(String(a.adset_id))) as never }),
    readAdSet: vi.fn(async id => { const s = state.adSets.get(id); if (!s) throw new MetaApiError('not found'); return s as never }),
    readAd: vi.fn(async id => { const a = state.ads.get(id); if (!a) throw new MetaApiError('not found'); const c = a.creative_id ? state.creatives.get(String(a.creative_id)) : null; return { ...a, creative: a.creative ?? (c ? { id: c.id } : null) } as never }),
    findByToken: vi.fn(async (_a: string, kind: 'campaigns' | 'adsets' | 'ads' | 'adcreatives', token: string) => {
      calls.push({ op: `find_${kind}` })
      const store = { campaigns: state.campaigns, adsets: state.adSets, ads: state.ads, adcreatives: state.creatives }[kind]
      return [...store.values()].filter(o => String(o.name).includes(token)).map(o => ({ id: o.id, name: String(o.name), status: o.status }))
    }),
    geoSearch: vi.fn(async () => []),
    createCampaign: vi.fn(async (_a, spec, v) => make(state.campaigns, 'campaign', { name: spec.name, objective: spec.objective, buying_type: spec.buyingType, special_ad_categories: spec.specialAdCategories }, v)),
    createAdSet: vi.fn(async (_a, spec, v) => make(state.adSets, 'adset', { name: spec.name, campaign_id: spec.campaignId, daily_budget: String(spec.dailyBudgetMinor), targeting: spec.targeting, promoted_object: spec.promotedObject, optimization_goal: spec.optimizationGoal, end_time: null }, v)),
    createCreative: vi.fn(async (_a, spec, v) => make(state.creatives, 'creative', { name: spec.name, object_story_spec: spec.objectStorySpec }, v)),
    createAd: vi.fn(async (_a, spec, v) => {
      const r = make(state.ads, 'ad', { name: spec.name, adset_id: spec.adSetId, creative: { id: spec.creativeId } }, v)
      if (behave.ignoreStatus && r.id) state.ads.get(r.id)!.status = 'ACTIVE'
      return r
    }),
    setAdSetEndTime: vi.fn(async (id, iso) => { calls.push({ op: 'set_end_time' }); state.adSets.get(id)!.end_time = iso as never }),
  }
  // The real trusted executor (guardrails, live re-read, read-back) over this fake account.
  const adapter: PaidMutationAdapter = {
    async read(plan) {
      if (!('target_id' in plan)) throw new Error('x')
      const store = plan.target_type === 'ad' ? state.ads : plan.target_type === 'adset' ? state.adSets : state.campaigns
      const o = store.get(plan.target_id)!
      return { platform: 'meta', accountId: act, status: o.status, currency: 'DKK' }
    },
    async mutate(plan) {
      calls.push({ op: plan.action_type })
      if (!('target_id' in plan)) throw new Error('x')
      const store = plan.target_type === 'ad' ? state.ads : plan.target_type === 'adset' ? state.adSets : state.campaigns
      store.get(plan.target_id)!.status = plan.action_type.includes('resume') ? 'ACTIVE' : 'PAUSED'
      return {}
    },
  }
  return { state, calls, behave, port, adapter, executePlan: (plan: Parameters<RunnerDeps['executePlan']>[0]) => executeTrustedPlan(plan, adapter) }
}

export const PROD_ENV = { META_SYSTEM_USER_TOKEN: 'x', META_AD_ACCOUNT_ID: SRC.act, META_FACEBOOK_PAGE_ID: '1', ANTHROPIC_API_KEY: 'x' }
export const prodCapabilities = (env: Record<string, string> = PROD_ENV, meta: string[] | null = ['ads_management', 'ads_read']) =>
  discoverCapabilities(inputsFromEnv(env, meta, ['https://www.googleapis.com/auth/analytics.readonly']))

export function runnerFixture(over: { capabilities?: RunnerDeps['capabilities']; creative?: RunnerDeps['generateCreative']; now?: () => Date } = {}) {
  const meta = fakeMeta()
  const saved: { status: RunStatus; ledger: string }[] = []
  const handoffs: unknown[] = []
  const drafts: unknown[] = []
  let clock = new Date('2026-10-10T09:00:00Z')
  const deps: RunnerDeps = {
    now: over.now ?? (() => clock), meta: meta.port, capabilities: over.capabilities ?? prodCapabilities(),
    generateCreative: over.creative ?? vi.fn(async () => ({ ok: true as const, package: goodPackage(), model: 'test-model' })),
    fetchSiteHtml: vi.fn(async () => '<html data-wf-page="1"><script src="https://cdn.prod.website-files.com/x/webflow.schunk.1.js"></script><script>fbq(\'init\', \'942936014341416\')</script>GTM-P4RTHWT7</html>'),
    readPixel: vi.fn(async id => ({ id, name: 'Killer Kebab', lastFiredTime: '2026-10-09T10:00:00Z', unavailable: false })), writers: [],
    createHandoffTask: vi.fn(async h => { handoffs.push(h); return 'task-1' }), executePlan: meta.executePlan,
    saveCreativeDraft: vi.fn(async d => { drafts.push(d) }),
  }
  const ledger = (token = 'KK-ab12cd34'): ExecutionLedger => emptyLedger(token)
  const ctx = (over2: Partial<RunContext> = {}): RunContext => ({
    ledger: ledger(),
    rec: { title: 'Launch a Malmö catering leads campaign mirroring C2 structure to test market demand', hypothesis: 'A new Malmö campaign using the same creative and form structure as C2 will generate a lead.', exact_test_or_action: 'Create a new leads-objective campaign targeting the Malmö metro area. Set a daily budget of 100 DKK and run for 21 days, spending at most 2,100 DKK incremental.', success_metric: 'At least 1 verified lead in 21 days.', incremental_budget_dkk: 2100 },
    configuredAccountId: SRC.act, source: { campaignId: SRC.campaign, accountId: SRC.act, name: 'Killer Katering - Copenhagen Leads (V1)', currency: 'DKK' },
    market: 'Malmö', sourceMarket: 'Copenhagen', syncedCampaigns: [{ id: SRC.malmoCampaign, name: 'Malmö Brand - Foodies Always On (V2)', accountId: SRC.act }, { id: SRC.campaign, name: 'Killer Katering - Copenhagen Leads (V1)', accountId: SRC.act }],
    approvedIncrementalDkk: 2100, dailyBudgetDkk: 100, durationDays: 21, ownerUserId: 'u-owner', dueDate: '2026-10-17',
    save: vi.fn(async (status, l) => { saved.push({ status, ledger: JSON.stringify(l) }) }), ...over2,
  })
  return { meta, deps, ctx, saved, handoffs, drafts, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) }, setClock: (d: Date) => { clock = d } }
}
export type { Blocker }
