/**
 * lib/meta/campaign-config.ts
 *
 * READ-ONLY. The richer configuration of an existing campaign / ad sets / ads that is needed to clone a
 * structure safely. Field lists are taken from what the live Graph API (version pinned in api-version.ts)
 * actually returned for a real lead campaign; nothing here writes.
 *
 * Object IDs are validated as numeric strings before they are placed in a path. Callers get plain data;
 * nothing returned here is ever sent to a model.
 */

import { graphFetch } from './client'

const ID = /^\d{1,30}$/
const ACT = /^act_\d{1,30}$/
const assertId = (id: string, what: string) => { if (!ID.test(id)) throw new Error(`Invalid Meta ${what} ID`) }

export interface MetaCampaignConfig {
  id: string; name: string; status: string; objective: string | null; buying_type: string | null
  special_ad_categories: string[]; special_ad_category_country: string[]; bid_strategy: string | null
  daily_budget: string | null; lifetime_budget: string | null; is_adset_budget_sharing_enabled: boolean | null
}
export interface MetaAdSetConfig {
  id: string; campaign_id: string; name: string; status: string; effective_status: string | null
  optimization_goal: string | null; billing_event: string | null; bid_strategy: string | null
  daily_budget: string | null; lifetime_budget: string | null; destination_type: string | null
  promoted_object: Record<string, unknown> | null; targeting: Record<string, unknown> | null
  attribution_spec: Array<Record<string, unknown>> | null; start_time: string | null; end_time: string | null
  is_dynamic_creative: boolean | null
}
export interface MetaCreativeConfig {
  id: string; name: string | null; object_type: string | null; call_to_action_type: string | null
  object_story_spec: Record<string, unknown> | null; asset_feed_spec: Record<string, unknown> | null
  degrees_of_freedom_spec: Record<string, unknown> | null; url_tags: string | null
}
export interface MetaAdConfig { id: string; name: string; status: string; effective_status: string | null; adset_id: string; creative: MetaCreativeConfig | null }

const CAMPAIGN_FIELDS = 'id,name,status,objective,buying_type,special_ad_categories,special_ad_category_country,bid_strategy,daily_budget,lifetime_budget,is_adset_budget_sharing_enabled'
const ADSET_FIELDS = 'id,campaign_id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,destination_type,promoted_object,targeting,attribution_spec,start_time,end_time,is_dynamic_creative'
const CREATIVE_FIELDS = 'creative{id,name,object_type,call_to_action_type,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags}'
const AD_FIELDS = `id,name,status,effective_status,adset_id,${CREATIVE_FIELDS}`

type Page<T> = { data?: T[] }
const list = <T>(body: unknown): T[] => ((body as Page<T>).data ?? [])

export async function fetchMetaCampaignConfig(id: string): Promise<MetaCampaignConfig> {
  assertId(id, 'campaign')
  const c = await graphFetch(id, { fields: CAMPAIGN_FIELDS }) as Partial<MetaCampaignConfig> & { id: string; name: string; status: string }
  return {
    id: c.id, name: c.name, status: c.status, objective: c.objective ?? null, buying_type: c.buying_type ?? null,
    special_ad_categories: c.special_ad_categories ?? [], special_ad_category_country: c.special_ad_category_country ?? [], bid_strategy: c.bid_strategy ?? null,
    daily_budget: c.daily_budget ?? null, lifetime_budget: c.lifetime_budget ?? null, is_adset_budget_sharing_enabled: c.is_adset_budget_sharing_enabled ?? null,
  }
}

export async function fetchMetaAdSetConfigs(campaignId: string): Promise<MetaAdSetConfig[]> {
  assertId(campaignId, 'campaign')
  return list<MetaAdSetConfig>(await graphFetch(`${campaignId}/adsets`, { fields: ADSET_FIELDS, limit: '25' })).map(s => ({
    ...s, effective_status: s.effective_status ?? null, optimization_goal: s.optimization_goal ?? null, billing_event: s.billing_event ?? null, bid_strategy: s.bid_strategy ?? null,
    daily_budget: s.daily_budget ?? null, lifetime_budget: s.lifetime_budget ?? null, destination_type: s.destination_type ?? null, promoted_object: s.promoted_object ?? null,
    targeting: s.targeting ?? null, attribution_spec: s.attribution_spec ?? null, start_time: s.start_time ?? null, end_time: s.end_time ?? null, is_dynamic_creative: s.is_dynamic_creative ?? null,
  }))
}

export async function fetchMetaAdConfigs(campaignId: string): Promise<MetaAdConfig[]> {
  assertId(campaignId, 'campaign')
  return list<MetaAdConfig>(await graphFetch(`${campaignId}/ads`, { fields: AD_FIELDS, limit: '25' })).map(a => ({ ...a, effective_status: a.effective_status ?? null, creative: a.creative ?? null }))
}

export async function fetchMetaAdSetConfig(id: string): Promise<MetaAdSetConfig> {
  assertId(id, 'ad set')
  const s = await graphFetch(id, { fields: ADSET_FIELDS }) as MetaAdSetConfig
  return { ...s, effective_status: s.effective_status ?? null, daily_budget: s.daily_budget ?? null, end_time: s.end_time ?? null }
}

export async function fetchMetaAdConfig(id: string): Promise<MetaAdConfig> {
  assertId(id, 'ad')
  const a = await graphFetch(id, { fields: AD_FIELDS }) as MetaAdConfig
  return { ...a, effective_status: a.effective_status ?? null, creative: a.creative ?? null }
}

/**
 * Reconciliation read: objects in the ad account whose name contains a token. Used to find an object that was
 * created but whose id was never recorded (a timeout after the platform committed), so a retry never duplicates it.
 */
export async function findMetaObjectsByNameToken(adAccountId: string, kind: 'campaigns' | 'adsets' | 'ads' | 'adcreatives', token: string): Promise<Array<{ id: string; name: string; status?: string }>> {
  if (!ACT.test(adAccountId)) throw new Error('Invalid Meta ad account ID')
  const filtering = JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: token }])
  const params: Record<string, string> = { fields: kind === 'adcreatives' ? 'id,name' : 'id,name,status', limit: '25' }
  if (kind !== 'adcreatives') params.filtering = filtering
  const rows = list<{ id: string; name: string; status?: string }>(await graphFetch(`${adAccountId}/${kind}`, params))
  return rows.filter(r => r.name.includes(token))
}

/** Targeting search for a city (read-only). Used only when no existing account campaign already targets the market. */
export async function searchMetaGeoCity(name: string, countryCode: string): Promise<Array<{ key: string; name: string; country_code: string; region?: string; region_id?: number; type: string }>> {
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('Invalid country code')
  return list(await graphFetch('search', { type: 'adgeolocation', q: name.slice(0, 80), location_types: JSON.stringify(['city']), country_code: countryCode, limit: '10' }))
}
