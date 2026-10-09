/**
 * Capability registry: what Kockpit can genuinely DO today, as opposed to read.
 *
 * The compiler asks this registry before choosing an execution path and never silently degrades to a human
 * task. A missing capability becomes an explicit blocker naming exactly what is missing and the smallest
 * action that would unblock it.
 *
 * The evaluation is a pure function of verifiable inputs: which integrations are configured (env var NAMES only,
 * never values), the OAuth scope names the Google account actually granted, and the Meta permissions the system
 * user token reports. Nothing here reads or exposes a secret.
 */

export const CAPABILITY_IDS = [
  'meta_existing_mutation', 'meta_campaign_creation', 'meta_adset_creation', 'meta_creative_creation', 'meta_ad_creation',
  'meta_capi_events', 'tracking_gtm_write', 'tracking_ga4_write', 'website_code_write', 'lead_form_write',
  'lead_source', 'creative_text_generation', 'creative_image_generation', 'ordering_stack_write',
] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export type CapabilityState = 'available' | 'unverified' | 'missing'

export interface Capability {
  id: CapabilityId
  system: string
  /** Kockpit can read this system's data today. */
  read: boolean
  /** Kockpit can WRITE to this system today (what the strategy needs, not merely read). */
  write: boolean
  state: CapabilityState
  /** What the state is based on. Names and scopes only, never values. */
  evidence: string
  /** The smallest action that would make this available. Null when available. */
  unblock: string | null
}

export interface CapabilityInputs {
  env: {
    metaToken: boolean; metaAdAccount: boolean; metaPage: boolean; metaInstagram: boolean; anthropic: boolean
    webflowToken: boolean; leadSourceConfigured: boolean; heapsToken: boolean
  }
  /** Permission names the Meta system user reports (me/permissions, status granted). null = could not be checked. */
  metaPermissions: string[] | null
  /** OAuth scope names granted to any connected Google account. */
  googleScopes: string[]
}

export const GTM_WRITE_SCOPES = ['https://www.googleapis.com/auth/tagmanager.edit.containers', 'https://www.googleapis.com/auth/tagmanager.edit.containerversions', 'https://www.googleapis.com/auth/tagmanager.publish']
export const GA4_WRITE_SCOPES = ['https://www.googleapis.com/auth/analytics.edit']

export function inputsFromEnv(env: Record<string, string | undefined>, metaPermissions: string[] | null, googleScopes: string[]): CapabilityInputs {
  const has = (k: string) => !!env[k]
  return {
    env: {
      metaToken: has('META_SYSTEM_USER_TOKEN'), metaAdAccount: has('META_AD_ACCOUNT_ID'), metaPage: has('META_FACEBOOK_PAGE_ID'), metaInstagram: has('META_INSTAGRAM_BUSINESS_ACCOUNT_ID'),
      anthropic: has('ANTHROPIC_API_KEY'),
      // No code path reads these today; they exist so a future integration is detected the moment its variable appears.
      webflowToken: has('WEBFLOW_API_TOKEN'), leadSourceConfigured: has('CATERING_LEAD_SOURCE'), heapsToken: has('HEAPS_API_TOKEN'),
    },
    metaPermissions, googleScopes,
  }
}

export function discoverCapabilities(i: CapabilityInputs): Capability[] {
  const metaReady = i.env.metaToken && i.env.metaAdAccount
  const perm = (name: string): CapabilityState => !metaReady ? 'missing' : i.metaPermissions == null ? 'unverified' : i.metaPermissions.includes(name) ? 'available' : 'missing'
  const adsManagement = perm('ads_management')
  const metaWrite = (id: CapabilityId, evidence: string): Capability => ({
    id, system: 'Meta Ads', read: i.env.metaToken && i.env.metaAdAccount, write: adsManagement === 'available', state: adsManagement,
    evidence: adsManagement === 'available' ? `Meta system user holds ads_management. ${evidence}` : adsManagement === 'unverified' ? 'Meta permissions could not be checked.' : 'Meta system user token or ad account is not configured, or ads_management is not granted.',
    unblock: adsManagement === 'available' ? null : 'Connect the Meta system user token with ads_management on the Killer Kebab ad account.',
  })
  const pageAccess: CapabilityState = !metaReady || !i.env.metaPage ? 'missing' : i.metaPermissions == null ? 'unverified' : i.metaPermissions.includes('pages_manage_ads') ? 'available' : 'unverified'
  const googleWrite = (scopes: string[]) => scopes.some(s => i.googleScopes.includes(s))
  const gtm = googleWrite(GTM_WRITE_SCOPES), ga4 = googleWrite(GA4_WRITE_SCOPES)

  return [
    metaWrite('meta_existing_mutation', 'Pause/resume and budget changes on existing objects run through the trusted executor.'),
    metaWrite('meta_campaign_creation', 'Campaigns are always created PAUSED.'),
    metaWrite('meta_adset_creation', 'Ad sets are always created PAUSED.'),
    metaWrite('meta_ad_creation', 'Ads are always created PAUSED.'),
    {
      id: 'meta_creative_creation', system: 'Meta Ads', read: metaReady, write: adsManagement === 'available' && pageAccess !== 'missing',
      state: adsManagement !== 'available' ? adsManagement : pageAccess === 'available' ? 'available' : 'unverified',
      evidence: pageAccess === 'available' ? 'ads_management and pages_manage_ads are granted.' : 'ads_management is granted, but the token has no pages_manage_ads; whether the Page is assigned to the system user in Business Manager can only be confirmed by Meta when a creative is validated.',
      unblock: pageAccess === 'available' ? null : 'If Meta refuses a creative, assign the Facebook Page and Instagram account to the Kockpit system user in Business Manager.',
    },
    {
      id: 'meta_capi_events', system: 'Meta Events / Pixel / CAPI', read: metaReady, write: adsManagement === 'available', state: adsManagement,
      evidence: adsManagement === 'available' ? 'The system user can post server events to the account\'s pixel, but Kockpit has no source of qualified-lead or booking events to send.' : 'No ads_management permission.',
      unblock: adsManagement === 'available' ? 'Provide a source of confirmed catering bookings (see lead_source).' : 'Connect the Meta system user token with ads_management.',
    },
    {
      id: 'tracking_gtm_write', system: 'Google Tag Manager', read: false, write: gtm, state: gtm ? 'available' : 'missing',
      evidence: gtm ? 'Tag Manager edit scope granted.' : `No Tag Manager scope is granted to any connected Google account (${i.googleScopes.length} scopes granted, none for tagmanager).`,
      unblock: gtm ? null : 'Reconnect Google with the Tag Manager edit scopes, and give that Google account Edit/Publish on the website container.',
    },
    {
      id: 'tracking_ga4_write', system: 'Google Analytics 4', read: i.googleScopes.includes('https://www.googleapis.com/auth/analytics.readonly'), write: ga4, state: ga4 ? 'available' : 'missing',
      evidence: ga4 ? 'analytics.edit granted.' : 'GA4 is connected read-only (analytics.readonly). Events and conversions cannot be configured.',
      unblock: ga4 ? null : 'Reconnect Google with the analytics.edit scope and give the account Editor on the GA4 property.',
    },
    {
      id: 'website_code_write', system: 'killerkebab.com (Webflow)', read: false, write: i.env.webflowToken, state: i.env.webflowToken ? 'available' : 'missing',
      evidence: i.env.webflowToken ? 'A Webflow API token is configured.' : 'The website is a Webflow site. Kockpit has no Webflow API token and no repository for it (the connected GitHub account has Killer-Kockpit, killer-kalculator and killer-kardio only).',
      unblock: i.env.webflowToken ? null : 'Create a Webflow API token with site custom-code and forms access and add it to Kockpit.',
    },
    {
      id: 'lead_form_write', system: 'Catering enquiry form', read: false, write: i.env.webflowToken, state: i.env.webflowToken ? 'available' : 'missing',
      evidence: 'The enquiry form is a native Webflow form on the website; there is no Meta instant form in the campaign. Kockpit can neither read its submissions nor change it.',
      unblock: i.env.webflowToken ? null : 'Same Webflow API token as website_code_write (forms scope).',
    },
    {
      id: 'lead_source', system: 'CRM / lead destination', read: false, write: false, state: i.env.leadSourceConfigured ? 'available' : 'missing',
      evidence: i.env.leadSourceConfigured ? 'A catering lead source is configured.' : 'Enquiries arrive as Webflow form emails to hello@killerkebab.com. There is no CRM and no store of enquiry status, so Kockpit cannot know when an enquiry becomes a confirmed booking.',
      unblock: i.env.leadSourceConfigured ? null : 'Decide where a confirmed catering booking is recorded (for example a status in Kockpit or a CRM), so it can be sent to Meta as a downstream event.',
    },
    {
      id: 'ordering_stack_write', system: 'HeapsGo ordering', read: false, write: i.env.heapsToken, state: i.env.heapsToken ? 'available' : 'missing',
      evidence: 'No HeapsGo integration exists in Kockpit. Catering enquiries do not go through the ordering stack.', unblock: i.env.heapsToken ? null : 'Not needed for the catering strategy; only relevant if bookings are confirmed in HeapsGo.',
    },
    {
      id: 'creative_text_generation', system: 'Claude (Anthropic)', read: i.env.anthropic, write: i.env.anthropic, state: i.env.anthropic ? 'available' : 'missing',
      evidence: i.env.anthropic ? 'Anthropic is configured (usage tracked in AI Usage).' : 'ANTHROPIC_API_KEY is not configured.', unblock: i.env.anthropic ? null : 'Configure ANTHROPIC_API_KEY.',
    },
    {
      id: 'creative_image_generation', system: 'Image generation', read: false, write: false, state: 'missing',
      evidence: 'Kockpit has no image or video generation integration. Existing ad images are reused by image hash.', unblock: 'Not required while existing assets are reused. New footage is a physical human step.',
    },
  ]
}

export const byId = (caps: Capability[], id: CapabilityId): Capability => {
  const c = caps.find(x => x.id === id)
  if (!c) throw new Error(`Unknown capability ${id}`)
  return c
}

/** Missing or unverified capabilities among `ids`. `unverified` is not blocking: the executor lets Meta decide and maps its answer. */
export function blockingCapabilities(caps: Capability[], ids: readonly CapabilityId[]): Capability[] {
  return ids.map(id => byId(caps, id)).filter(c => c.state === 'missing')
}
