import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { META_GRAPH_BASE_URL, META_GRAPH_API_VERSION } from '@/lib/meta/api-version'
import { adParams, adSetParams, campaignParams, createMetaAd, createMetaAdCreative, createMetaAdSet, createMetaCampaign, creativeParams, MetaCreationUncertainError } from '@/lib/meta/creation'
import { MetaApiError } from '@/lib/meta/client'
import { findMetaObjectsByNameToken, searchMetaGeoCity } from '@/lib/meta/campaign-config'

const fetchMock = vi.fn()
beforeEach(() => { process.env.META_SYSTEM_USER_TOKEN = 'test-token'; vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
afterEach(() => { vi.unstubAllGlobals() })
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() })
const bodyOf = (call = 0) => Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[call][1].body as string))
const urlOf = (call = 0) => String(fetchMock.mock.calls[call][0])
const ACT = 'act_7001'

const campaign = { name: 'C [KK-1]', objective: 'OUTCOME_LEADS', buyingType: 'AUCTION', specialAdCategories: [], isAdsetBudgetSharingEnabled: false }
const adset = { name: 'S [KK-1]', campaignId: '123', dailyBudgetMinor: 10000, billingEvent: 'IMPRESSIONS', optimizationGoal: 'OFFSITE_CONVERSIONS', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', destinationType: 'WEBSITE', promotedObject: { pixel_id: '9', custom_event_type: 'LEAD' }, targeting: { geo_locations: { cities: [] } }, attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }] }

describe('Meta creation is narrow, typed and always PAUSED', () => {
  it('uses the API version pinned in the repo', () => {
    expect(META_GRAPH_API_VERSION).toBe('v26.0'); expect(META_GRAPH_BASE_URL).toContain('/v26.0')
  })
  it('every create sends status=PAUSED, and the specs have no way to ask for anything else', async () => {
    expect(campaignParams(campaign).status).toBe('PAUSED'); expect(adSetParams(adset).status).toBe('PAUSED'); expect(adParams({ name: 'a', adSetId: '1', creativeId: '2' }).status).toBe('PAUSED')
    for (const spec of [campaign, adset]) expect(Object.keys(spec)).not.toContain('status')
    fetchMock.mockResolvedValue(ok({ id: '111' }))
    await createMetaCampaign(ACT, { ...campaign, status: 'ACTIVE' } as never)
    expect(bodyOf().status).toBe('PAUSED')
  })
  it('sends the documented fields: JSON for objects, minor-unit integers for money', () => {
    expect(campaignParams(campaign)).toMatchObject({ name: 'C [KK-1]', objective: 'OUTCOME_LEADS', buying_type: 'AUCTION', special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false' })
    const p = adSetParams(adset)
    expect(p).toMatchObject({ campaign_id: '123', daily_budget: '10000', billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE' })
    expect(JSON.parse(p.promoted_object)).toEqual({ pixel_id: '9', custom_event_type: 'LEAD' }); expect(JSON.parse(p.attribution_spec)).toHaveLength(1)
    expect(p).not.toHaveProperty('end_time'); expect(p).not.toHaveProperty('start_time')
    expect(JSON.parse(adParams({ name: 'a', adSetId: '1', creativeId: '2' }).creative)).toEqual({ creative_id: '2' })
    expect(creativeParams({ name: 'cr', objectStorySpec: { page_id: '1' }, degreesOfFreedomSpec: null, urlTags: null })).toEqual({ name: 'cr', object_story_spec: '{"page_id":"1"}' })
  })
  it('rejects bad ids and budgets before any request is made', async () => {
    expect(() => adSetParams({ ...adset, campaignId: '12a' })).toThrow('Invalid campaign ID')
    expect(() => adSetParams({ ...adset, dailyBudgetMinor: 100.5 })).toThrow('Invalid daily budget')
    expect(() => adSetParams({ ...adset, dailyBudgetMinor: 0 })).toThrow()
    expect(() => adParams({ name: 'a', adSetId: 'x', creativeId: '2' })).toThrow()
    await expect(createMetaCampaign('act_x', campaign)).rejects.toThrow('Unsupported Meta creation path')
    await expect(createMetaCampaign('7001', campaign)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('posts only to act_<id>/campaigns|adsets|adcreatives|ads, with the system token and no token in the body', async () => {
    fetchMock.mockResolvedValue(ok({ id: '111' }))
    await createMetaCampaign(ACT, campaign); await createMetaAdSet(ACT, adset); await createMetaAdCreative(ACT, { name: 'c', objectStorySpec: {}, degreesOfFreedomSpec: null, urlTags: null }); await createMetaAd(ACT, { name: 'a', adSetId: '1', creativeId: '2' })
    expect([0, 1, 2, 3].map(i => urlOf(i).replace(META_GRAPH_BASE_URL, ''))).toEqual([`/${ACT}/campaigns`, `/${ACT}/adsets`, `/${ACT}/adcreatives`, `/${ACT}/ads`])
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token'); expect(JSON.stringify(bodyOf())).not.toContain('test-token')
  })
  it('validate-only asks Meta to check the request and returns no id', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }))
    expect(await createMetaAdSet(ACT, adset, true)).toEqual({ validated: true })
    expect(JSON.parse(bodyOf().execution_options)).toEqual(['validate_only'])
    fetchMock.mockClear(); fetchMock.mockResolvedValue(ok({ id: '5' })); await createMetaAdSet(ACT, adset, false)
    expect(bodyOf()).not.toHaveProperty('execution_options')
  })
  it('a Meta error becomes a MetaApiError carrying the code; the user-facing message is preferred', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid parameter', error_user_msg: 'The geography is not valid.', code: 100, type: 'OAuthException' } }), headers: new Headers() })
    await expect(createMetaAdSet(ACT, adset)).rejects.toMatchObject({ name: 'MetaApiError', message: 'The geography is not valid.', code: 100 })
  })
  it('a network failure or an unreadable or id-less reply is UNCERTAIN, never a plain failure', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'))
    await expect(createMetaCampaign(ACT, campaign)).rejects.toBeInstanceOf(MetaCreationUncertainError)
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad json') }, headers: new Headers() })
    await expect(createMetaCampaign(ACT, campaign)).rejects.toBeInstanceOf(MetaCreationUncertainError)
    fetchMock.mockResolvedValue(ok({ success: true }))
    await expect(createMetaCampaign(ACT, campaign)).rejects.toBeInstanceOf(MetaCreationUncertainError)
    fetchMock.mockResolvedValue(ok({ id: 'not-numeric' }))
    await expect(createMetaCampaign(ACT, campaign)).rejects.toBeInstanceOf(MetaCreationUncertainError)
  })
  it('never retries: one request per call even on failure', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'))
    await expect(createMetaAd(ACT, { name: 'a', adSetId: '1', creativeId: '2' })).rejects.toBeInstanceOf(MetaCreationUncertainError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('without a configured token it refuses locally', async () => {
    delete process.env.META_SYSTEM_USER_TOKEN
    await expect(createMetaCampaign(ACT, campaign)).rejects.toBeInstanceOf(MetaApiError); expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('read helpers used for reconciliation and geography', () => {
  it('finds objects by name token, filtering client-side as well', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ id: '1', name: 'x [KK-1]', status: 'PAUSED' }, { id: '2', name: 'other' }] }))
    expect(await findMetaObjectsByNameToken(ACT, 'campaigns', '[KK-1]')).toEqual([{ id: '1', name: 'x [KK-1]', status: 'PAUSED' }])
    expect(urlOf()).toContain(`/${ACT}/campaigns`); expect(decodeURIComponent(urlOf())).toContain('"operator":"CONTAIN"')
    await expect(findMetaObjectsByNameToken('act_x', 'ads', 't')).rejects.toThrow('Invalid Meta ad account ID')
  })
  it('city search is a read with a validated country code', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ key: '1', name: 'Malmö', country_code: 'SE', type: 'city' }] }))
    expect(await searchMetaGeoCity('Malmö', 'SE')).toHaveLength(1)
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined() // GET
    await expect(searchMetaGeoCity('Malmö', 'sweden')).rejects.toThrow('Invalid country code')
  })
})
