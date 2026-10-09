/**
 * lib/meta/creation.ts
 *
 * The minimum Graph API CREATE calls needed to clone a campaign structure: campaign, ad set, ad creative, ad.
 * Deliberately narrow and typed. This is not a Meta Ads SDK.
 *
 * Safety properties (all unit-tested):
 *   - Every object is created PAUSED. The specs have no status field, so a caller cannot ask for anything else.
 *   - The path must match an allow-list of `act_<id>/<campaigns|adsets|adcreatives|ads>`.
 *   - `validateOnly` sends `execution_options=["validate_only"]`: Meta checks the request and creates nothing.
 *   - Responses are verified to carry an id; an HTTP error or an error envelope throws a MetaApiError.
 *   - Nothing is retried here. A timeout is surfaced to the caller as UNCERTAIN, because the object may exist.
 *
 * Activation (PAUSED -> ACTIVE) is NOT here. It goes through the existing trusted executor and its guardrails.
 */

import { META_GRAPH_BASE_URL } from './api-version'
import { getMetaAuthHeaders } from './auth'
import { MetaApiError } from './client'

const ACT = /^act_\d{1,30}$/
const ID = /^\d{1,30}$/

export class MetaCreationUncertainError extends Error {
  constructor(message: string) { super(message); this.name = 'MetaCreationUncertainError' }
}

export interface CreateCampaignSpec {
  name: string; objective: string; buyingType: string; specialAdCategories: string[]; isAdsetBudgetSharingEnabled: boolean
}
export interface CreateAdSetSpec {
  name: string; campaignId: string; dailyBudgetMinor: number; billingEvent: string; optimizationGoal: string; bidStrategy: string
  destinationType: string | null; promotedObject: Record<string, unknown>; targeting: Record<string, unknown>
  attributionSpec: Array<Record<string, unknown>> | null
}
export interface CreateCreativeSpec { name: string; objectStorySpec: Record<string, unknown>; degreesOfFreedomSpec: Record<string, unknown> | null; urlTags: string | null }
export interface CreateAdSpec { name: string; adSetId: string; creativeId: string }

type Created = { id: string } | { validated: true }

async function post(path: string, params: Record<string, string>, validateOnly: boolean): Promise<Created> {
  const [account, kind] = path.split('/')
  if (!ACT.test(account) || !['campaigns', 'adsets', 'adcreatives', 'ads'].includes(kind) || path.split('/').length !== 2) throw new MetaApiError('Unsupported Meta creation path')
  const headers = getMetaAuthHeaders()
  if (!headers) throw new MetaApiError('META_SYSTEM_USER_TOKEN not configured')
  const body = new URLSearchParams(params)
  if (validateOnly) body.set('execution_options', JSON.stringify(['validate_only']))
  let res: Response
  try {
    res = await fetch(`${META_GRAPH_BASE_URL}/${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  } catch {
    // The request may have reached Meta. Never assume it did not.
    throw new MetaCreationUncertainError('No response from Meta; the object may or may not have been created.')
  }
  let json: { id?: string; success?: boolean; error?: { message?: string; code?: number; type?: string; error_user_msg?: string } }
  try { json = await res.json() as typeof json } catch { throw new MetaCreationUncertainError('Unreadable response from Meta; the object may or may not have been created.') }
  if (!res.ok || json.error) throw new MetaApiError(json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${res.status}`, json.error?.code, json.error?.type)
  if (validateOnly) return { validated: true }
  if (!json.id || !ID.test(json.id)) throw new MetaCreationUncertainError('Meta accepted the request but returned no object id.')
  return { id: json.id }
}

const json = (v: unknown) => JSON.stringify(v)

export function campaignParams(spec: CreateCampaignSpec): Record<string, string> {
  return {
    name: spec.name, objective: spec.objective, buying_type: spec.buyingType, special_ad_categories: json(spec.specialAdCategories),
    is_adset_budget_sharing_enabled: String(spec.isAdsetBudgetSharingEnabled), status: 'PAUSED',
  }
}
export function adSetParams(spec: CreateAdSetSpec): Record<string, string> {
  if (!ID.test(spec.campaignId)) throw new MetaApiError('Invalid campaign ID')
  if (!Number.isSafeInteger(spec.dailyBudgetMinor) || spec.dailyBudgetMinor <= 0) throw new MetaApiError('Invalid daily budget')
  return {
    name: spec.name, campaign_id: spec.campaignId, daily_budget: String(spec.dailyBudgetMinor), billing_event: spec.billingEvent,
    optimization_goal: spec.optimizationGoal, bid_strategy: spec.bidStrategy, promoted_object: json(spec.promotedObject), targeting: json(spec.targeting),
    ...(spec.destinationType ? { destination_type: spec.destinationType } : {}), ...(spec.attributionSpec ? { attribution_spec: json(spec.attributionSpec) } : {}),
    status: 'PAUSED',
  }
}
export function creativeParams(spec: CreateCreativeSpec): Record<string, string> {
  return {
    name: spec.name, object_story_spec: json(spec.objectStorySpec),
    ...(spec.degreesOfFreedomSpec ? { degrees_of_freedom_spec: json(spec.degreesOfFreedomSpec) } : {}), ...(spec.urlTags ? { url_tags: spec.urlTags } : {}),
  }
}
export function adParams(spec: CreateAdSpec): Record<string, string> {
  if (!ID.test(spec.adSetId) || !ID.test(spec.creativeId)) throw new MetaApiError('Invalid ad set or creative ID')
  return { name: spec.name, adset_id: spec.adSetId, creative: json({ creative_id: spec.creativeId }), status: 'PAUSED' }
}

export const createMetaCampaign = (act: string, spec: CreateCampaignSpec, validateOnly = false) => post(`${act}/campaigns`, campaignParams(spec), validateOnly)
export const createMetaAdSet = (act: string, spec: CreateAdSetSpec, validateOnly = false) => post(`${act}/adsets`, adSetParams(spec), validateOnly)
export const createMetaAdCreative = (act: string, spec: CreateCreativeSpec, validateOnly = false) => post(`${act}/adcreatives`, creativeParams(spec), validateOnly)
export const createMetaAd = (act: string, spec: CreateAdSpec, validateOnly = false) => post(`${act}/ads`, adParams(spec), validateOnly)
