import type { MetaAdConfig, MetaAdSetConfig, MetaCampaignConfig } from '@/lib/meta/campaign-config'

// Shapes taken from the real C2 lead campaign (Graph API v26): website destination, OFFSITE_CONVERSIONS on the pixel LEAD
// event, Instagram feed placements, one carousel ad. IDs are synthetic.
export const SRC = { campaign: '120000000000000001', adSet: '120000000000000002', ad: '120000000000000003', adPaused: '120000000000000004', creative: '120000000000000005', malmoCampaign: '120000000000000009', act: 'act_7001' }

export const sourceCampaign = (over: Partial<MetaCampaignConfig> = {}): MetaCampaignConfig => ({
  id: SRC.campaign, name: 'Killer Katering - Copenhagen Leads (V1)', status: 'ACTIVE', objective: 'OUTCOME_LEADS', buying_type: 'AUCTION',
  special_ad_categories: [], special_ad_category_country: [], bid_strategy: null, daily_budget: null, lifetime_budget: null, is_adset_budget_sharing_enabled: false, ...over,
})
export const sourceAdSet = (over: Partial<MetaAdSetConfig> = {}): MetaAdSetConfig => ({
  id: SRC.adSet, campaign_id: SRC.campaign, name: 'Katering Leads - Greater Copenhagen Broad', status: 'ACTIVE', effective_status: 'ACTIVE',
  optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: '8000', lifetime_budget: null, destination_type: 'WEBSITE',
  promoted_object: { pixel_id: '942936014341416', custom_event_type: 'LEAD', smart_pse_enabled: false },
  targeting: {
    age_max: 65, age_min: 18,
    geo_locations: { cities: [{ country: 'DK', distance_unit: 'kilometer', key: '609672', name: 'Copenhagen', radius: 26, region: 'Capital Region of Denmark', region_id: '4133' }], location_types: ['frequently_in', 'home', 'recent'] },
    targeting_relaxation_types: { lookalike: 0, custom_audience: 0 }, targeting_automation: { advantage_audience: 0 },
    publisher_platforms: ['instagram'], instagram_positions: ['stream', 'profile_feed'], device_platforms: ['mobile', 'desktop'],
  },
  attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
  start_time: '2026-09-16T22:56:11+0200', end_time: null, is_dynamic_creative: false, ...over,
})
export const COPENHAGEN_COPY = 'Finally. Killer Kebab now does Killer Katering.\n\nOne menu, five dishes: two salads, two spreads, and Killer Falafels.\n\n149 DKK per person. Minimum 10 people.\n\nhello@killerkebab.com\n\n#KillerKatering #Copenhagen #homemade #copenhagenfood #copenhageneats'
export const sourceAd = (over: Partial<MetaAdConfig> = {}): MetaAdConfig => ({
  id: SRC.ad, name: 'Killer Katering Carousel - Leads V1.1', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: SRC.adSet,
  creative: {
    id: SRC.creative, name: 'Killer Katering Carousel', object_type: 'SHARE', call_to_action_type: 'SEE_MENU', asset_feed_spec: null, url_tags: null,
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_OUT' } } },
    object_story_spec: {
      page_id: '112852720485976', instagram_user_id: '17841438098787218',
      link_data: {
        link: 'https://www.killerkebab.com/catering', message: COPENHAGEN_COPY, attachment_style: 'link', call_to_action: { type: 'SEE_MENU', value: { link: 'https://www.killerkebab.com/catering' } },
        child_attachments: [{ link: 'https://www.killerkebab.com/catering', image_hash: '7f7d60b318a37d21328b17baeb45033f', name: 'Killer Katering' }, { link: 'https://www.killerkebab.com/catering', image_hash: '29fe5f197affd3c65a6fc4ff3cba47de', name: 'Killer Katering' }],
      },
    },
  }, ...over,
})
export const pausedAd = (): MetaAdConfig => ({ ...sourceAd(), id: SRC.adPaused, name: 'Killer Katering Carousel - Leads V1', status: 'PAUSED', effective_status: 'PAUSED', creative: { ...sourceAd().creative!, object_story_spec: null } })
export const malmoTargeting = { geo_locations: { cities: [{ country: 'SE', distance_unit: 'kilometer', key: '2429813', name: 'Malmö', radius: 20, region: 'Skåne County', region_id: '3026' }], location_types: ['home', 'recent'] } }
