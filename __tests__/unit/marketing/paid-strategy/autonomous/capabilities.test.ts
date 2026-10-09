import { describe, expect, it } from 'vitest'
import { blockingCapabilities, byId, discoverCapabilities, inputsFromEnv, CAPABILITY_IDS } from '@/lib/marketing/paid-strategy/autonomous/capabilities'

// What production actually has today: Meta system user with ads_management (no pages_manage_ads), Google read-only analytics, no Tag Manager scope.
const GOOGLE = ['openid', 'https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/webmasters.readonly']
const META = ['ads_management', 'ads_read', 'business_management', 'read_insights', 'pages_read_engagement', 'instagram_basic']
const ENV = { META_SYSTEM_USER_TOKEN: 'x', META_AD_ACCOUNT_ID: 'act_1', META_FACEBOOK_PAGE_ID: '1', META_INSTAGRAM_BUSINESS_ACCOUNT_ID: '2', ANTHROPIC_API_KEY: 'x' }
const caps = (env: Record<string, string | undefined> = ENV, meta: string[] | null = META, google = GOOGLE) => discoverCapabilities(inputsFromEnv(env, meta, google))

describe('capability discovery', () => {
  it('reports every capability exactly once', () => {
    expect(caps().map(c => c.id).sort()).toEqual([...CAPABILITY_IDS].sort())
  })
  it('production today: can create PAUSED Meta objects and write copy, cannot write tracking, website, leads or CRM', () => {
    const c = caps()
    for (const id of ['meta_existing_mutation', 'meta_campaign_creation', 'meta_adset_creation', 'meta_ad_creation', 'creative_text_generation'] as const) expect(byId(c, id), id).toMatchObject({ state: 'available', write: true })
    for (const id of ['tracking_gtm_write', 'tracking_ga4_write', 'website_code_write', 'lead_form_write', 'lead_source', 'ordering_stack_write', 'creative_image_generation'] as const) expect(byId(c, id), id).toMatchObject({ state: 'missing', write: false })
  })
  it('creative creation is UNVERIFIED (no pages_manage_ads), which is not a block: Meta decides', () => {
    expect(byId(caps(), 'meta_creative_creation')).toMatchObject({ state: 'unverified', write: true })
    expect(blockingCapabilities(caps(), ['meta_creative_creation'])).toEqual([])
  })
  it('GA4 is read-only: reading works, writing does not', () => {
    expect(byId(caps(), 'tracking_ga4_write')).toMatchObject({ read: true, write: false, state: 'missing' })
    expect(byId(caps(), 'tracking_ga4_write').evidence).toContain('read-only')
  })
  it('detects a capability the moment its scope or variable appears', () => {
    expect(byId(caps(ENV, META, [...GOOGLE, 'https://www.googleapis.com/auth/tagmanager.edit.containers']), 'tracking_gtm_write').state).toBe('available')
    expect(byId(caps(ENV, META, [...GOOGLE, 'https://www.googleapis.com/auth/analytics.edit']), 'tracking_ga4_write').state).toBe('available')
    expect(byId(caps({ ...ENV, WEBFLOW_API_TOKEN: 'x' }), 'website_code_write').state).toBe('available')
    expect(byId(caps({ ...ENV, CATERING_LEAD_SOURCE: 'x' }), 'lead_source').state).toBe('available')
  })
  it('without ads_management nothing on Meta can be written, and unreachable permissions are unverified rather than assumed', () => {
    expect(byId(caps(ENV, ['ads_read']), 'meta_campaign_creation')).toMatchObject({ state: 'missing', write: false })
    expect(byId(caps(ENV, null), 'meta_campaign_creation')).toMatchObject({ state: 'unverified' })
    expect(byId(caps({}, META), 'meta_campaign_creation').state).toBe('missing')
    expect(byId(caps({ ...ENV, ANTHROPIC_API_KEY: undefined }), 'creative_text_generation').state).toBe('missing')
  })
  it('every missing capability names the smallest unblock, and never contains a secret value', () => {
    for (const c of caps().filter(c => c.state === 'missing')) { expect(c.unblock, c.id).toBeTruthy(); expect(c.evidence.length).toBeGreaterThan(10) }
    expect(JSON.stringify(caps({ ...ENV, META_SYSTEM_USER_TOKEN: 'super-secret-token-value' }))).not.toContain('super-secret-token-value')
  })
})
