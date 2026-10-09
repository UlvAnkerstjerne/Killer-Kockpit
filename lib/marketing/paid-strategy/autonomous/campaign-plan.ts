/**
 * Pure planner: the configuration of an existing campaign + a recommendation + a person's budget -> a validated
 * PAUSED clone for another market, or exact blockers. No I/O, no AI. Every ID in the result came from Meta reads
 * of objects the server resolved from synced data; nothing is read from advice text.
 */

import { majorToMetaBudget, metaBudgetToMajor } from '@/lib/meta/money'
import type { MetaAdConfig, MetaAdSetConfig, MetaCampaignConfig } from '@/lib/meta/campaign-config'
import type { CreateAdSetSpec, CreateCampaignSpec, CreateCreativeSpec } from '@/lib/meta/creation'
import type { Blocker } from './types'

export const SUPPORTED_OBJECTIVES = ['OUTCOME_LEADS', 'OUTCOME_TRAFFIC'] as const
/** Meta's minimum radius for city targeting is 10 miles (17 km). */
export const DEFAULT_CITY_RADIUS_KM = 17
const MARKET_COUNTRY: Record<string, string> = { 'malmö': 'SE', malmo: 'SE', stockholm: 'SE', göteborg: 'SE', gothenburg: 'SE', lund: 'SE', copenhagen: 'DK', københavn: 'DK', aarhus: 'DK', odense: 'DK', aalborg: 'DK' }
export const countryForMarket = (market: string): string | null => MARKET_COUNTRY[market.toLowerCase()] ?? null

export type GeoLocations = Record<string, unknown>

/** The geo definition an existing account campaign already uses for this market, if exactly one distinct one exists. */
export function geoFromExistingTargetings(market: string, candidates: { campaignName: string; targeting: Record<string, unknown> | null }[]): { geo: GeoLocations | null; blocker: Blocker | null; origin: string | null } {
  const re = new RegExp(`(?<![\\p{L}])${market.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu')
  const distinct = new Map<string, { geo: GeoLocations; from: string }>()
  for (const c of candidates) {
    const geo = c.targeting?.geo_locations as GeoLocations | undefined
    if (geo && re.test(c.campaignName)) distinct.set(JSON.stringify(sortKeys(geo)), { geo, from: c.campaignName })
  }
  if (distinct.size === 0) return { geo: null, blocker: null, origin: null }
  if (distinct.size > 1) return { geo: null, origin: null, blocker: { kind: 'input', code: 'geo_ambiguous', message: `Your account has ${distinct.size} different ${market} location definitions.`, unblock: `Say which ${market} location the new campaign should use.` } }
  const only = [...distinct.values()][0]
  return { geo: only.geo, blocker: null, origin: `the location already used by "${only.from}"` }
}

export function geoFromSearch(market: string, countryCode: string, results: { key: string; name: string; country_code: string; type: string }[]): { geo: GeoLocations | null; blocker: Blocker | null; origin: string | null } {
  const exact = results.filter(r => r.type === 'city' && r.country_code === countryCode && r.name.toLowerCase() === market.toLowerCase())
  if (exact.length !== 1) return { geo: null, origin: null, blocker: { kind: 'input', code: 'geo_unresolved', message: `${exact.length === 0 ? 'No' : 'More than one'} Meta city location matched "${market}" in ${countryCode}.`, unblock: `Say the exact city and radius to target for ${market}.` } }
  return { geo: { cities: [{ key: exact[0].key, radius: DEFAULT_CITY_RADIUS_KM, distance_unit: 'kilometer' }], location_types: ['home', 'recent'] }, blocker: null, origin: `Meta's ${market} city location, ${DEFAULT_CITY_RADIUS_KM} km` }
}

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v

/** Replace the source market in copy, including hashtags and compound words (#copenhagenfood -> #malmöfood). */
export function localiseCopy(text: string, from: string, to: string): { text: string; changed: number } {
  let changed = 0
  const toLower = to.toLowerCase()
  const out = text.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), match => {
    changed++
    if (match === match.toUpperCase() && match.length > 1) return to.toUpperCase()
    return match[0] === match[0].toLowerCase() ? toLower : to
  })
  return { text: out, changed }
}

export interface ClonePlan {
  token: string
  market: string
  campaign: CreateCampaignSpec
  adSet: Omit<CreateAdSetSpec, 'campaignId'>
  creative: CreateCreativeSpec
  adName: string
  durationDays: number
  dailyBudgetDkk: number
  totalBudgetDkk: number
  geoOrigin: string
  source: { campaignId: string; adSetId: string; adId: string; creativeId: string; campaignName: string }
  /** What a person reviews before activation. Facts about the structure, not instructions. */
  review: { campaignName: string; adSetName: string; adName: string; objective: string; optimisation: string; geo: string; placements: string; dailyBudgetDkk: number; totalBudgetDkk: number; durationDays: number; destination: string | null; copy: string; reviewNotes: string[] }
}

export interface PlanInput {
  token: string; market: string; sourceCampaignName: string; sourceMarket: string
  configuredAccountId: string | undefined; sourceAccountId: string; currency: string
  source: { campaign: MetaCampaignConfig; adSets: MetaAdSetConfig[]; ads: MetaAdConfig[] }
  geo: { geo: GeoLocations | null; origin: string | null }
  dailyBudgetDkk: number | null; durationDays: number | null; approvedIncrementalDkk: number
}

const blocked = (...b: Blocker[]) => ({ ok: false as const, blockers: b })
const cap = (code: string, message: string, unblock: string): Blocker => ({ kind: 'capability', code, message, unblock })
/** Meta returns "0" (not null) for a budget field that is not in use. */
const hasBudget = (v: string | null | undefined) => v != null && Number(v) > 0
const text = (v: unknown) => (typeof v === 'string' ? v : '')

export function planCampaignClone(i: PlanInput): { ok: true; plan: ClonePlan } | { ok: false; blockers: Blocker[] } {
  const b: Blocker[] = []
  if (!i.configuredAccountId) return blocked({ kind: 'access', code: 'account_unconfigured', capability: 'meta_campaign_creation', message: 'The Meta ad account is not configured, so account ownership cannot be verified.', unblock: 'Set the Killer Kebab ad account in Kockpit.' })
  if (i.sourceAccountId !== i.configuredAccountId) return blocked({ kind: 'access', code: 'account_mismatch', message: 'The source campaign does not belong to the configured Meta ad account.', unblock: 'Nothing can be created from a campaign in another account.' })
  if (i.currency !== 'DKK') return blocked({ kind: 'input', code: 'currency', message: `The account currency is ${i.currency}, not DKK, so the 15,000 DKK ceiling cannot be applied.`, unblock: 'Not supported.' })

  const { campaign, adSets, ads } = i.source
  if (!SUPPORTED_OBJECTIVES.includes(campaign.objective as never)) b.push(cap('objective_unsupported', `Cloning ${campaign.objective ?? 'this'} campaigns is not supported yet.`, 'Only lead and traffic campaigns can be cloned.'))
  if (campaign.special_ad_categories.length > 0) b.push(cap('special_ad_category', 'The source campaign declares a special ad category, which needs a person to confirm for the new market.', 'Confirm the special ad category and country for the new market.'))
  if (hasBudget(campaign.daily_budget) || hasBudget(campaign.lifetime_budget)) b.push(cap('campaign_budget_unsupported', 'The source campaign uses a campaign-level budget; only ad-set budgets can be cloned.', 'Not supported yet.'))

  const activeSets = adSets.filter(s => s.effective_status === 'ACTIVE' || s.status === 'ACTIVE')
  if (activeSets.length !== 1) b.push({ kind: 'input', code: 'source_adset', message: `The source campaign has ${activeSets.length} active ad sets; exactly one can be mirrored.`, unblock: 'Say which ad set to mirror.' })
  const adSet = activeSets[0]
  if (adSet) {
    if (hasBudget(adSet.lifetime_budget)) b.push(cap('adset_lifetime_budget', 'The source ad set uses a lifetime budget.', 'Not supported yet.'))
    if (adSet.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') b.push(cap('bid_strategy', `Bid strategy ${adSet.bid_strategy ?? 'unknown'} needs a bid amount that cannot be cloned safely.`, 'Not supported yet.'))
    if (!adSet.promoted_object || !adSet.optimization_goal || !adSet.billing_event || !adSet.targeting) b.push(cap('adset_incomplete', 'The source ad set is missing the optimisation, promoted object or targeting needed to clone it.', 'Open the source ad set in Meta and check it is complete.'))
    if (adSet.is_dynamic_creative) b.push(cap('dynamic_creative', 'The source ad set uses dynamic creative.', 'Not supported yet.'))
  }

  const liveAds = ads.filter(a => a.adset_id === adSet?.id && (a.effective_status === 'ACTIVE' || a.status === 'ACTIVE') && a.creative?.object_story_spec)
  if (adSet && liveAds.length === 0) b.push({ kind: 'input', code: 'source_ad', message: 'The source ad set has no active ad with a usable creative.', unblock: 'Say which ad to mirror.' })
  if (liveAds.length > 1) b.push({ kind: 'input', code: 'source_ad_ambiguous', message: `The source ad set has ${liveAds.length} active ads; exactly one can be mirrored.`, unblock: 'Say which ad to mirror.' })

  if (!i.geo.geo) b.push({ kind: 'input', code: 'geo', message: `The ${i.market} location could not be determined.`, unblock: `Say the city and radius to target for ${i.market}.` })
  if (i.dailyBudgetDkk == null || i.durationDays == null) b.push({ kind: 'input', code: 'budget', message: 'The recommendation does not state a daily budget and run length.', unblock: 'Say the daily budget and how many days it should run.' })
  else if (i.dailyBudgetDkk * i.durationDays > i.approvedIncrementalDkk + 1e-9) b.push({ kind: 'input', code: 'budget_over_approval', message: `${i.dailyBudgetDkk} DKK a day for ${i.durationDays} days is ${i.dailyBudgetDkk * i.durationDays} DKK, above the ${i.approvedIncrementalDkk} DKK approved.`, unblock: 'Lower the daily budget or the number of days.' })
  if (b.length) return { ok: false, blockers: b }

  const sourceAd = liveAds[0]
  const oss = JSON.parse(JSON.stringify(sourceAd.creative!.object_story_spec)) as Record<string, Record<string, unknown>>
  const shape = oss.link_data ? 'link_data' : oss.video_data ? 'video_data' : oss.photo_data ? 'photo_data' : null
  if (!shape) return blocked(cap('creative_shape', 'The source creative has a shape that cannot be cloned yet.', 'Not supported yet.'))
  const message = text(oss[shape].message) || text(oss[shape].caption)
  const localised = localiseCopy(message, i.sourceMarket, i.market)
  const messageKey = oss[shape].message !== undefined ? 'message' : 'caption'
  oss[shape][messageKey] = localised.text

  const tag = ` [${i.token}]`
  const campaignName = `${i.sourceCampaignName.replace(/\([^)]*\)\s*$/, '').replace(new RegExp(i.sourceMarket, 'gi'), i.market).trim()} (V1)${tag}`
  const setName = `${adSet!.name.replace(new RegExp(i.sourceMarket, 'gi'), i.market)}${tag}`
  const adName = `${sourceAd.name.replace(new RegExp(i.sourceMarket, 'gi'), i.market)}${tag}`

  const geoOrigin = i.geo.origin ?? 'the resolved location'
  const targeting: Record<string, unknown> = { ...adSet!.targeting!, geo_locations: i.geo.geo! }
  const plan: ClonePlan = {
    token: i.token, market: i.market,
    campaign: { name: campaignName, objective: campaign.objective!, buyingType: campaign.buying_type ?? 'AUCTION', specialAdCategories: [], isAdsetBudgetSharingEnabled: campaign.is_adset_budget_sharing_enabled ?? false },
    adSet: {
      name: setName, dailyBudgetMinor: majorToMetaBudget(i.dailyBudgetDkk!), billingEvent: adSet!.billing_event!, optimizationGoal: adSet!.optimization_goal!, bidStrategy: adSet!.bid_strategy!,
      destinationType: adSet!.destination_type, promotedObject: adSet!.promoted_object!, targeting, attributionSpec: adSet!.attribution_spec,
    },
    creative: { name: `${sourceAd.creative!.name ?? 'Creative'} - ${i.market}${tag}`, objectStorySpec: oss, degreesOfFreedomSpec: sourceAd.creative!.degrees_of_freedom_spec, urlTags: sourceAd.creative!.url_tags },
    adName, durationDays: i.durationDays!, dailyBudgetDkk: i.dailyBudgetDkk!, totalBudgetDkk: Math.round(i.dailyBudgetDkk! * i.durationDays! * 100) / 100, geoOrigin,
    source: { campaignId: campaign.id, adSetId: adSet!.id, adId: sourceAd.id, creativeId: sourceAd.creative!.id, campaignName: i.sourceCampaignName },
    review: {
      campaignName, adSetName: setName, adName, objective: `${campaign.objective} · ${adSet!.optimization_goal}`,
      optimisation: `${adSet!.optimization_goal} on ${String((adSet!.promoted_object as Record<string, unknown>).custom_event_type ?? 'the pixel event')}, ${adSet!.billing_event}, lowest cost`,
      geo: `${i.market}, ${geoOrigin}`,
      placements: [...((targeting.publisher_platforms as string[] | undefined) ?? ['automatic']), ...((targeting.instagram_positions as string[] | undefined) ?? [])].join(', '),
      dailyBudgetDkk: i.dailyBudgetDkk!, totalBudgetDkk: Math.round(i.dailyBudgetDkk! * i.durationDays! * 100) / 100, durationDays: i.durationDays!,
      destination: text((oss[shape] as Record<string, unknown>).link) || null, copy: localised.text,
      reviewNotes: [
        localised.changed ? `${localised.changed} mention${localised.changed === 1 ? '' : 's'} of ${i.sourceMarket} in the ad copy were changed to ${i.market}.` : `The ad copy does not mention ${i.sourceMarket}; it is reused unchanged.`,
        'The destination page is shared with the source campaign. Check it makes sense for this market before activating.',
        'Nothing has been activated. The campaign, ad set and ad are paused and cannot spend.',
      ],
    },
  }
  return { ok: true, plan }
}

export { metaBudgetToMajor }
