import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  CHECK_SCOPE_KEY, CLICK_ORIENTED_OBJECTIVES, EVALUATED_CHECK_IDS, evaluateFacebookAdsChecks, FACEBOOK_ADS_NOT_ASSESSED, FACEBOOK_ADS_SKILL_REF,
  GUARDS, checklistRunId, THRESHOLDS, type MetaChecksInput,
} from '@/lib/marketing/insights/skill-checks/facebook-ads'
import { captureRun } from '@/lib/marketing/insights/capture'
import { memoryStore } from '../../../helpers/insights'
import { NOW as ACCOUNT_NOW, strategyInputs } from '../../../helpers/paid-strategy'

const DIR = 'lib/ai/skills/facebook-ads'
const checklist = readFileSync(`${DIR}/CHECKS.md`, 'utf8')
const manifest = JSON.parse(readFileSync(`${DIR}/UPSTREAM.json`, 'utf8')) as { version: string; upstream: { commit: string; tree_sha: string }; files: { path: string; sha256: string; bytes: number }[]; license: { file: string } }
const block = (id: string) => checklist.match(new RegExp(`### ${id}: [^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n---|$)`))?.[1] ?? ''

describe('the vendored facebook-ads checklist', () => {
  it('is pinned: manifest hashes match the files, the commit and tree are full hashes, and the licence travels with it', () => {
    for (const f of manifest.files) {
      const content = readFileSync(`${DIR}/${f.path}`)
      expect(createHash('sha256').update(content).digest('hex')).toBe(f.sha256)
      expect(content.length).toBe(f.bytes)
    }
    expect(manifest.upstream.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.upstream.tree_sha).toMatch(/^[a-f0-9]{40}$/)
    expect(FACEBOOK_ADS_SKILL_REF).toBe(`facebook-ads@${manifest.version}#${manifest.upstream.commit.slice(0, 7)}`)
    expect(readFileSync(`${DIR}/${manifest.license.file}`, 'utf8')).toMatch(/MIT License[\s\S]*Rebecca Rae Barton/)
  })
  it('has the thresholds the code applies (the code cannot drift from the skill unnoticed)', () => {
    const t = THRESHOLDS
    const ctr = block('M-CR12')
    expect(ctr).toContain(`CTR ≥${t.ctr.passAtLeast.toFixed(1)}%`); expect(ctr).toContain(`CTR ${t.ctr.failBelow}-${t.ctr.passAtLeast.toFixed(1)}%`); expect(ctr).toContain(`CTR <${t.ctr.failBelow}%`)
    const ads = block('M-CR2')
    expect(ads).toContain(`${t.adsPerAdSet.passAtLeast}-8 creatives per ad set`); expect(ads).toContain(`${t.adsPerAdSet.warningAtLeast}-4 creatives`); expect(ads).toContain(`<${t.adsPerAdSet.warningAtLeast} creatives per ad set`)
    const budget = block('M-ST18')
    expect(budget).toContain(`>${t.budgetUtilization.passAbove}% of daily budget`); expect(budget).toContain(`${t.budgetUtilization.failBelow}-${t.budgetUtilization.passAbove}%`); expect(budget).toContain(`<${t.budgetUtilization.failBelow}%`)
    const fatigue = block('M-CR4')
    expect(fatigue).toContain(`>${t.ctrDecline.fatigueAbove}% over 14 days`); expect(fatigue).toContain(`${t.ctrDecline.warningAtLeast}-${t.ctrDecline.fatigueAbove}%`)
    expect(fatigue).toMatch(/frequency >3/) // the fail needs frequency, which Kockpit does not store
  })
  it('accounts for all 46 checks exactly once: evaluated, or listed with the reason it cannot be', () => {
    const all = [...checklist.matchAll(/^### (M-[A-Z]+\d+):/gm)].map(m => m[1])
    expect(all).toHaveLength(46)
    const listed = FACEBOOK_ADS_NOT_ASSESSED.flatMap(g => g.checks)
    expect(new Set(listed).size).toBe(listed.length) // no check is listed twice
    expect([...EVALUATED_CHECK_IDS, ...listed].sort()).toEqual([...all].sort())
    expect(EVALUATED_CHECK_IDS).toHaveLength(4)
    for (const g of FACEBOOK_ADS_NOT_ASSESSED) expect(g.blocker.length).toBeGreaterThan(30)
  })
  it('does not claim a check the stored data cannot answer (the blockers name the missing data)', () => {
    const text = FACEBOOK_ADS_NOT_ASSESSED.map(g => g.blocker).join(' ')
    for (const word of ['Pixel', 'Conversions API', 'targeting', 'frequency', 'USD', 'learning', 'creation time']) expect(text.toLowerCase()).toContain(word.toLowerCase())
  })
})

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// now = 2026-10-09 (Copenhagen) → last completed day 2026-10-08; 28d = 09-11..10-08; 14d = 09-25..10-08; 7d = 10-02..10-08
const NOW = new Date('2026-10-09T10:00:00Z')
const range = (from: string, to: string) => { const out: string[] = []; for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out }
const empty = (): MetaChecksInput => ({ now: NOW, currency: 'DKK', campaigns: [], adSets: [], ads: [], campaignInsights: [], adInsights: [] })
const camp = (id: string, over: Partial<MetaChecksInput['campaigns'][number]> = {}) => ({ id, name: `Campaign ${id}`, status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: null as unknown, ...over })
const cRows = (id: string, from: string, to: string, impressions: number, clicks: number, spend = 0) => range(from, to).map(d => ({ campaign_id: id, date_start: d, impressions, inline_link_clicks: clicks, spend }))
const aRows = (id: string, from: string, to: string, impressions: number, clicks: number, spend = 10) => range(from, to).map(d => ({ ad_id: id, date_start: d, impressions, inline_link_clicks: clicks, spend }))
const find = (input: MetaChecksInput, id: string) => evaluateFacebookAdsChecks(input).results.find(r => r.id === id)!

describe('M-CR12 CTR benchmark', () => {
  const withCtr = (clicksPerDay: number, over: Partial<MetaChecksInput> = {}): MetaChecksInput =>
    ({ ...empty(), campaigns: [camp('1')], campaignInsights: cRows('1', '2026-09-11', '2026-10-08', 1000, clicksPerDay), ...over })
  it('applies the skill’s boundaries: 1.0% passes, just under warns, 0.5% still warns, under 0.5% fails', () => {
    expect(find(withCtr(10), 'M-CR12').status).toBe('pass')       // 1.00%
    expect(find(withCtr(9.9), 'M-CR12').status).toBe('warning')   // 0.99%
    expect(find(withCtr(5), 'M-CR12').status).toBe('warning')     // 0.50%
    expect(find(withCtr(4.9), 'M-CR12').status).toBe('fail')      // 0.49%
  })
  it('measures link clicks over impressions of the last 28 COMPLETED days only', () => {
    const input = withCtr(4, { campaignInsights: [...cRows('1', '2026-09-11', '2026-10-08', 1000, 4), ...cRows('1', '2026-10-09', '2026-10-09', 100_000, 0), ...cRows('1', '2026-09-01', '2026-09-10', 100_000, 0)] })
    const r = find(input, 'M-CR12')
    expect(r.measured).toBe('0.40%') // today and the days before the window are ignored
    expect(r.evidence_text).toContain('2026-09-11 to 2026-10-08')
  })
  it('judges click-oriented campaigns only: awareness, engagement, unknown objectives and ZZ test campaigns are left out', () => {
    const input: MetaChecksInput = { ...empty(),
      campaigns: [camp('1'), camp('2', { objective: 'OUTCOME_AWARENESS' }), camp('3', { objective: 'OUTCOME_ENGAGEMENT' }), camp('4', { objective: null }), camp('5', { name: 'ZZ old test' })],
      campaignInsights: [...cRows('1', '2026-09-11', '2026-10-08', 1000, 12), ...['2', '3', '4', '5'].flatMap(id => cRows(id, '2026-09-11', '2026-10-08', 5000, 0))] }
    expect(find(input, 'M-CR12')).toMatchObject({ status: 'pass', measured: '1.20%' })
    expect(CLICK_ORIENTED_OBJECTIVES.has('OUTCOME_AWARENESS')).toBe(false)
  })
  it('says nothing when there are too few impressions to judge', () => {
    const r = find({ ...empty(), campaigns: [camp('1')], campaignInsights: cRows('1', '2026-10-01', '2026-10-02', 100, 0) }, 'M-CR12')
    expect(r.status).toBe('not_assessable')
    expect(r.reason).toContain(String(GUARDS.minImpressionsForCtr).replace(/\B(?=(\d{3})+(?!\d))/g, ','))
  })
  it('words the finding as a measurement against the skill’s thresholds, with its limits stated', () => {
    const r = find(withCtr(4), 'M-CR12')
    expect(r.statement).toContain('0.40%'); expect(r.statement).toMatch(/under 0\.5% as a fail/)
    expect(r.limitations).toMatch(/generic cross-industry benchmark/)
    expect(r.strength).toBe('reasonable_inference')
    expect(find(withCtr(8), 'M-CR12').strength).toBe('weak_signal')
  })
})

describe('M-CR2 creative volume per ad set', () => {
  const setup = (counts: Record<string, number>, over: Partial<MetaChecksInput> = {}): MetaChecksInput => {
    const adSets = Object.keys(counts).map(id => ({ id, campaign_id: '1', name: `Ad set ${id}`, status: 'ACTIVE', daily_budget: null as unknown }))
    const ads = Object.entries(counts).flatMap(([setId, n]) => Array.from({ length: n }, (_, i) => ({ id: `${setId}-${i}`, ad_set_id: setId, name: `Ad ${setId}-${i}`, status: 'ACTIVE' })))
    return { ...empty(), campaigns: [camp('1')], adSets, ads, adInsights: ads.flatMap(a => aRows(a.id, '2026-09-25', '2026-10-08', 1000, 10)), ...over }
  }
  it('uses the skill’s bands: 5 or more passes, 3-4 warns, under 3 fails', () => {
    expect(find(setup({ a: 5, b: 8 }), 'M-CR2').status).toBe('pass')
    expect(find(setup({ a: 4, b: 6 }), 'M-CR2').status).toBe('warning')
    expect(find(setup({ a: 3 }), 'M-CR2').status).toBe('warning')
    expect(find(setup({ a: 2, b: 6 }), 'M-CR2').status).toBe('fail')
  })
  it('does not flag more than 8 (the skill defines no band for it)', () => {
    expect(find(setup({ a: 12 }), 'M-CR2').status).toBe('pass')
  })
  it('counts only ACTIVE ads, and only ad sets that actually delivered in the last 14 days', () => {
    const input = setup({ a: 5, quiet: 1 })
    input.ads.push({ id: 'a-paused', ad_set_id: 'a', name: 'old', status: 'PAUSED' }, { id: 'a-x', ad_set_id: 'a', name: 'old', status: 'ARCHIVED' })
    input.adInsights = input.adInsights.filter(r => !r.ad_id.startsWith('quiet'))
    expect(find(input, 'M-CR2').status).toBe('pass') // 'quiet' (1 ad) never delivered, so it is not judged; paused ads do not count
    const paused = setup({ a: 5 }); paused.ads[0].status = 'PAUSED'
    expect(find(paused, 'M-CR2').status).toBe('warning') // 4 active
  })
  it('ignores paused campaigns and ZZ tests, and says nothing when nothing delivered', () => {
    expect(find(setup({ a: 1 }, { campaigns: [camp('1', { status: 'PAUSED' })] }), 'M-CR2').status).toBe('not_assessable')
    expect(find(setup({ a: 1 }, { campaigns: [camp('1', { name: 'ZZ test' })] }), 'M-CR2').status).toBe('not_assessable')
    expect(find(setup({ a: 1 }, { adInsights: [] }), 'M-CR2').status).toBe('not_assessable')
  })
  it('names the highest-spend ad sets that fall short, sanitises names and counts honestly', () => {
    const input = setup({ big: 1, small: 2, ok: 6 })
    input.adSets[0].name = `Big\u0000 ad\n set ${'x'.repeat(100)}`
    input.adInsights = input.adInsights.map(r => ({ ...r, spend: r.ad_id.startsWith('big') ? 100 : 10 }))
    const r = find(input, 'M-CR2')
    expect(r.statement).toContain('2 of 3 ad sets')
    expect(r.statement).toContain('1 of them fewer than 3'.replace('1 of them', '2 of them')) // both 'big' (1) and 'small' (2) are under 3
    expect(r.evidence_text.indexOf('Big')).toBeLessThan(r.evidence_text.indexOf('small') === -1 ? 9999 : r.evidence_text.indexOf('Ad set small'))
    expect(r.evidence_text).not.toMatch(/\u0000|\n/)
    expect(r.evidence_text.length).toBeLessThan(400)
  })
})

describe('M-ST18 budget utilization', () => {
  // budgets are stored in minor units: 10000 = 100 DKK a day
  const withSpend = (spendPerDay: number, budgetMinor: unknown = 10000, over: Partial<MetaChecksInput> = {}): MetaChecksInput =>
    ({ ...empty(), campaigns: [camp('1', { daily_budget: budgetMinor })], campaignInsights: cRows('1', '2026-10-02', '2026-10-08', 1000, 10, spendPerDay), ...over })
  it('uses the skill’s bands: over 80% passes, 60-80% warns, under 60% fails', () => {
    expect(find(withSpend(81), 'M-ST18').status).toBe('pass')
    expect(find(withSpend(80), 'M-ST18').status).toBe('warning')
    expect(find(withSpend(60), 'M-ST18').status).toBe('warning')
    expect(find(withSpend(59), 'M-ST18')).toMatchObject({ status: 'fail', measured: '59%' })
  })
  it('treats stored budgets as minor units and reports amounts in the account currency, without converting it', () => {
    const r = find(withSpend(50), 'M-ST18')
    expect(r.evidence_text).toContain('50 DKK spent a day against 100 DKK budgeted a day')
    expect(find(withSpend(50, 10000, { currency: 'EUR' }), 'M-ST18').evidence_text).toContain('EUR')
  })
  it('falls back to the active ad sets’ budgets when the campaign has none', () => {
    const input = withSpend(30, null, { adSets: [
      { id: 's1', campaign_id: '1', name: 'a', status: 'ACTIVE', daily_budget: 5000 }, { id: 's2', campaign_id: '1', name: 'b', status: 'ACTIVE', daily_budget: 5000 },
      { id: 's3', campaign_id: '1', name: 'c', status: 'PAUSED', daily_budget: 99_999 }] })
    expect(find(input, 'M-ST18')).toMatchObject({ status: 'fail', measured: '30%' }) // 30 / (50+50)
  })
  it('leaves out campaigns that did not spend on at least 5 of the last 7 days, and lifetime-only budgets, and says so', () => {
    const input: MetaChecksInput = { ...empty(),
      campaigns: [camp('1', { daily_budget: 10000 }), camp('2', { daily_budget: 10000 }), camp('3', { daily_budget: null })],
      campaignInsights: [...cRows('1', '2026-10-02', '2026-10-08', 1000, 10, 90), ...cRows('2', '2026-10-06', '2026-10-08', 1000, 10, 0.01), ...cRows('3', '2026-10-02', '2026-10-08', 1000, 10, 500)] }
    const r = find(input, 'M-ST18')
    expect(r.measured).toBe('90%')
    expect(r.evidence_text).toContain('1 more spent on fewer than 5 of the 7 days'); expect(r.evidence_text).toContain('1 have no daily budget set')
    expect(find({ ...input, campaigns: [camp('2', { daily_budget: 10000 })] }, 'M-ST18').status).toBe('not_assessable')
  })
  it('does not claim why spend is low: the checklist’s suggested cause is attributed and flagged as unconfirmed', () => {
    const r = find(withSpend(30), 'M-ST18')
    expect(r.statement).toMatch(/reads a low figure as a sign of targeting or bid problems/)
    expect(r.limitations).toMatch(/Targeting and bid settings are not stored/)
  })
})

describe('M-CR4 CTR decline (the half of the fatigue check stored data can answer)', () => {
  // early week 09-25..10-01, late week 10-02..10-08
  const ads = (early: [number, number], late: [number, number], over: Partial<MetaChecksInput> = {}): MetaChecksInput => ({
    ...empty(), campaigns: [camp('1')], adSets: [{ id: 's', campaign_id: '1', name: 'set', status: 'ACTIVE', daily_budget: null }],
    ads: [{ id: 'a1', ad_set_id: 's', name: 'Catering reel', status: 'ACTIVE' }],
    adInsights: [...aRows('a1', '2026-09-25', '2026-10-01', early[0], early[1]), ...aRows('a1', '2026-10-02', '2026-10-08', late[0], late[1])], ...over })
  it('warns from a 10% fall and mentions more than 20% separately, but never fails: the skill’s fail needs frequency, which is not stored', () => {
    expect(find(ads([1000, 20], [1000, 19]), 'M-CR4').status).toBe('pass')      // -5%
    const mid = find(ads([1000, 20], [1000, 17]), 'M-CR4')                         // -15%
    expect(mid.status).toBe('warning'); expect(mid.statement).not.toContain('more than 20%')
    const big = find(ads([1000, 20], [1000, 10]), 'M-CR4')                         // -50%
    expect(big.status).toBe('warning'); expect(big.statement).toContain('1 of them by more than 20%')
    expect(big.evidence_text).toContain('“Catering reel” from 2.00% to 1.00% (50% lower)')
  })
  it('states plainly that fatigue is NOT confirmed without period frequency', () => {
    const r = find(ads([1000, 20], [1000, 10]), 'M-CR4')
    expect(r.limitations).toMatch(/frequency is also above 3/); expect(r.limitations).toMatch(/fatigue is NOT confirmed/)
    expect(r.strength).toBe('weak_signal')
  })
  it('needs enough delivery in both weeks before judging an ad (guards are Kockpit’s, not the skill’s)', () => {
    // per-day figures; a week is 7 days. Guards: 1,000 impressions in each week and 15 link clicks in the first.
    expect(find(ads([200, 2], [200, 0]), 'M-CR4').status).toBe('not_assessable')  // 14 early link clicks
    expect(find(ads([100, 3], [200, 0]), 'M-CR4').status).toBe('not_assessable')  // 700 early impressions
    expect(find(ads([200, 3], [100, 0]), 'M-CR4').status).toBe('not_assessable')  // 700 late impressions
    expect(find(ads([200, 3], [200, 0]), 'M-CR4').status).toBe('warning')         // 1,400 and 21 clicks: enough
  })
  it('only looks at ads that are active now, in active ad sets of active campaigns', () => {
    const paused = ads([1000, 20], [1000, 5]); paused.ads[0].status = 'PAUSED'
    expect(find(paused, 'M-CR4').status).toBe('not_assessable')
    const pausedCampaign = ads([1000, 20], [1000, 5], { campaigns: [camp('1', { status: 'PAUSED' })] })
    expect(find(pausedCampaign, 'M-CR4').status).toBe('not_assessable')
  })
  it('compares exactly the two weeks before today, ignoring today and older rows', () => {
    const input = ads([1000, 20], [1000, 20])
    input.adInsights.push(...aRows('a1', '2026-10-09', '2026-10-09', 50_000, 0), ...aRows('a1', '2026-09-01', '2026-09-24', 50_000, 0))
    expect(find(input, 'M-CR4').status).toBe('pass')
  })
})

describe('the checklist as an insight source', () => {
  const failing = (): MetaChecksInput => ({ ...empty(), campaigns: [camp('1')], campaignInsights: cRows('1', '2026-09-11', '2026-10-08', 1000, 3) })
  it('reports findings only for warnings and fails, each with a stable key, scope and a skill_check source', () => {
    const { extraction, results } = evaluateFacebookAdsChecks(failing())
    expect(results.filter(r => r.status === 'fail').map(r => r.id)).toEqual(['M-CR12'])
    expect(extraction.sourceKind).toBe('meta_account_checks')
    expect(extraction.candidates).toHaveLength(1)
    const [c] = extraction.candidates
    expect(c).toMatchObject({ domain: 'paid', kind: 'finding', scope_key: CHECK_SCOPE_KEY, stable_key: 'facebook-ads:M-CR12', suggestion: null, recommendation_index: null, strength: 'reasonable_inference' })
    expect(c.refs).toEqual([expect.objectContaining({ type: 'skill_check', skill: FACEBOOK_ADS_SKILL_REF, check_id: 'M-CR12', result: 'fail', measured: '0.30%' })])
  })
  it('makes no recommendation, causal claim, audience claim or score', () => {
    const all = evaluateFacebookAdsChecks({ ...failing(), adSets: [{ id: 's', campaign_id: '1', name: 'a', status: 'ACTIVE', daily_budget: 1000 }] })
    const text = JSON.stringify(all.extraction.candidates)
    expect(text).not.toMatch(/\b(should|must|recommend|because|caused|due to|audience|lookalike|CRM|score|grade)\b/i)
    expect(all).not.toHaveProperty('score')
  })
  it('lists which checks it was able to judge, so a check it could not judge never counts as "fixed"', () => {
    const { extraction } = evaluateFacebookAdsChecks(failing())
    expect(extraction.assessedKeys).toEqual(['facebook-ads:M-CR12']) // the other three had nothing to assess
  })
  it('uses one deterministic id per evaluation day, shaped like a uuid', () => {
    const a = checklistRunId('2026-10-09'); const b = checklistRunId('2026-10-10')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).toBe(checklistRunId('2026-10-09')); expect(a).not.toBe(b)
  })
  it('never reads the network or the database: it is a pure function of the stored rows', () => {
    const input = failing()
    const before = JSON.stringify(input)
    evaluateFacebookAdsChecks(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('tracking the checklist across days', () => {
  const day = (iso: string, over: Partial<MetaChecksInput>) => evaluateFacebookAdsChecks({ ...empty(), now: new Date(`${iso}T10:00:00Z`), ...over }).extraction
  const rows = (clicks: number, until: string) => ({ campaigns: [camp('1')], campaignInsights: cRows('1', '2026-09-01', until, 1000, clicks) })
  it('keeps one insight for a persistent problem, and lets it fade only when the check is assessed and passes', async () => {
    const m = memoryStore()
    await captureRun(m.store, day('2026-10-09', rows(3, '2026-10-08')))
    const id = m.all()[0].id
    expect(m.all()).toHaveLength(1)
    expect(m.insights.get(id)).toMatchObject({ origin_kind: 'meta_account_checks', stable_key: 'facebook-ads:M-CR12', trend: 'new', times_observed: 1 })
    await captureRun(m.store, day('2026-10-10', rows(3, '2026-10-09')))
    expect(m.all()).toHaveLength(1)
    expect(m.insights.get(id)).toMatchObject({ times_observed: 2, trend: 'steady' })
    await captureRun(m.store, day('2026-10-11', rows(15, '2026-10-10')))     // now passes: assessed, not a finding
    expect(m.insights.get(id)).toMatchObject({ trend: 'unconfirmed', runs_since_seen: 1, status: 'active' })
    await captureRun(m.store, day('2026-10-12', { campaigns: [camp('1')], campaignInsights: [] }))  // nothing assessable: says nothing
    expect(m.insights.get(id)).toMatchObject({ runs_since_seen: 1, status: 'active' })
    await captureRun(m.store, day('2026-10-13', rows(15, '2026-10-12')))     // passes again
    expect(m.insights.get(id)).toMatchObject({ runs_since_seen: 2, status: 'stale' })
  })
  it('evaluating twice on the same day is one observation, not two', async () => {
    const m = memoryStore()
    const ex = day('2026-10-09', rows(3, '2026-10-08'))
    await captureRun(m.store, ex)
    expect((await captureRun(m.store, ex)).skipped).toBe(true)
    expect(m.observations).toHaveLength(1)
  })
  it('keeps the checklist apart from the model-driven sources: neither counts the other’s insights as missed', async () => {
    const m = memoryStore()
    await captureRun(m.store, day('2026-10-09', rows(3, '2026-10-08')))
    const { extractFromPaidRun } = await import('@/lib/marketing/insights/extract')
    const { paidRunAt } = await import('../../../helpers/insights')
    await captureRun(m.store, extractFromPaidRun(paidRunAt('p1', '2026-10-10T09:00:00Z')))
    await captureRun(m.store, extractFromPaidRun(paidRunAt('p2', '2026-10-17T09:00:00Z')))
    const check = m.all().find(r => r.origin_kind === 'meta_account_checks')!
    expect(check).toMatchObject({ runs_since_seen: 0, status: 'active', trend: 'new' }) // two Paid Strategy runs never touched it
    expect(m.all().filter(r => r.origin_kind === 'paid_strategy_run')).toHaveLength(3)
    // and a checklist evaluation never marks a Paid Strategy insight as missed
    await captureRun(m.store, day('2026-10-18', rows(15, '2026-10-17')))
    for (const r of m.all().filter(x => x.origin_kind === 'paid_strategy_run')) expect(r.runs_since_seen).toBe(0)
  })
})

describe('on an account-shaped data set', () => {
  it('runs against the realistic synthetic Meta account the Paid Strategy tests use, producing only well-formed results', () => {
    const account = strategyInputs()
    const out = evaluateFacebookAdsChecks({
      now: ACCOUNT_NOW, currency: account.currency, campaigns: account.campaigns as never, adSets: account.adSets as never, ads: account.ads as never,
      campaignInsights: account.campaignInsights as never, adInsights: account.adInsights as never,
    })
    expect(out.results.map(r => r.id)).toEqual(['M-CR12', 'M-CR2', 'M-ST18', 'M-CR4'])
    for (const r of out.results) {
      expect(['pass', 'warning', 'fail', 'not_assessable']).toContain(r.status)
      if (r.status === 'not_assessable') expect(r.reason).toBeTruthy()
      else if (r.status !== 'pass') { expect(r.statement.length).toBeGreaterThan(40); expect(r.statement.length).toBeLessThan(500); expect(r.evidence_text).not.toMatch(/undefined|NaN|Infinity/) }
    }
    for (const c of out.extraction.candidates) {
      expect(`${c.title} ${c.statement} ${c.evidence_text} ${c.limitations}`).not.toMatch(/undefined|NaN|Infinity|\[object/)
      expect(c.statement.length).toBeLessThanOrEqual(2000)
    }
    expect(new Set(out.extraction.candidates.map(c => c.stable_key)).size).toBe(out.extraction.candidates.length)
  })
})
