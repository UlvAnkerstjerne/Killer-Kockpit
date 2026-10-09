import 'server-only'
import { getMetaAuthHeaders } from '@/lib/meta/auth'
import { graphFetch, updateMetaAdSetEndTime } from '@/lib/meta/client'
import {
  fetchMetaAdConfig, fetchMetaAdConfigs, fetchMetaAdSetConfig, fetchMetaAdSetConfigs, fetchMetaCampaignConfig, findMetaObjectsByNameToken, searchMetaGeoCity,
} from '@/lib/meta/campaign-config'
import { createMetaAd, createMetaAdCreative, createMetaAdSet, createMetaCampaign } from '@/lib/meta/creation'
import { executeTrustedPlan } from '@/lib/marketing/paid-recs/executor'
import { metaMutationAdapter } from '@/lib/marketing/paid-recs/platform-adapters'
import { discoverCapabilities, inputsFromEnv, type Capability } from './capabilities'
import type { MetaPort, RunnerDeps } from './runner'
import type { PixelFacts } from './tracking'

export const metaPort: MetaPort = {
  readCampaign: fetchMetaCampaignConfig, readAdSets: fetchMetaAdSetConfigs, readAds: fetchMetaAdConfigs, readAdSet: fetchMetaAdSetConfig, readAd: fetchMetaAdConfig,
  findByToken: findMetaObjectsByNameToken, geoSearch: searchMetaGeoCity,
  createCampaign: createMetaCampaign, createAdSet: createMetaAdSet, createCreative: createMetaAdCreative, createAd: createMetaAd,
  async setAdSetEndTime(id, iso) { await updateMetaAdSetEndTime(id, iso) },
}

/** Permission names the Meta system user reports. null when Meta cannot be reached (reported as "unverified", never assumed). */
export async function readMetaPermissions(): Promise<string[] | null> {
  try {
    const body = await graphFetch('me/permissions') as { data?: { permission: string; status: string }[] }
    return (body.data ?? []).filter(p => p.status === 'granted').map(p => p.permission)
  } catch { return null }
}

export async function readPixel(id: string): Promise<PixelFacts | null> {
  if (!/^\d{10,20}$/.test(id) || !getMetaAuthHeaders()) return null
  try {
    const p = await graphFetch(id, { fields: 'id,name,last_fired_time,is_unavailable' }) as { id: string; name: string; last_fired_time?: string; is_unavailable?: boolean }
    return { id: p.id, name: p.name, lastFiredTime: p.last_fired_time ?? null, unavailable: !!p.is_unavailable }
  } catch { return null }
}

/** Public page, fetched with a timeout and a size cap. The body is untrusted and only ever parsed structurally. */
export async function fetchSiteHtml(url: string): Promise<string> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || !/(^|\.)killerkebab\.com$/.test(u.hostname)) throw new Error('Only killerkebab.com pages can be inspected')
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'KillerKockpit-TrackingDiagnostic/1.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.text()).slice(0, 600_000)
}

export async function loadCapabilities(googleScopes: string[]): Promise<Capability[]> {
  return discoverCapabilities(inputsFromEnv(process.env, await readMetaPermissions(), googleScopes))
}

export const executePlanViaTrustedExecutor: RunnerDeps['executePlan'] = plan => executeTrustedPlan(plan, metaMutationAdapter('DKK'))

