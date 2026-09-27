/**
 * lib/marketing/paid-recs/tracking-diagnostic.ts
 *
 * Lightweight tracking diagnostic using data already synced into Kockpit.
 * Does NOT fix tracking — only gathers evidence about where the funnel breaks.
 *
 * Data sources:
 *   - meta_campaign_insights: campaign clicks, spend, actions_json (lead events)
 *   - google_ads_campaign_daily: clicks, conversions, cost
 *   - ga4_traffic_sources: paid sessions from GA4 (source/medium = cpc/paid)
 *   - ga4_daily: overall site sessions
 *
 * Output: structured evidence with a likely_break classification:
 *   - no_traffic: campaign is not generating clicks
 *   - traffic_no_platform_conversion: clicks exist but platform reports 0 conversions
 *   - traffic_with_ga4_activity: clicks exist, GA4 shows paid sessions, platform has 0 conversions → tracking mismatch likely
 *   - conversion_exists_outside_platform: GA4 or downstream shows activity platform doesn't → tracking mismatch
 *   - insufficient_evidence: not enough data to diagnose
 *
 * IMPORTANT: This diagnoses, it does NOT fix. The output clearly distinguishes
 * DIAGNOSED from FIXED. Kockpit cannot repair tracking automatically.
 */

import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'

export interface TrackingDiagnosticInput {
  platform: 'meta' | 'google'
  campaignId: string
}

export type LikelyBreak =
  | 'no_traffic'
  | 'traffic_no_platform_conversion'
  | 'traffic_with_ga4_activity'
  | 'conversion_exists_outside_platform'
  | 'insufficient_evidence'

export interface TrackingDiagnosticResult {
  diagnosed: true
  fixed: false
  platform: 'meta' | 'google'
  campaignId: string
  window: { start: string; end: string }
  evidence: {
    platformClicks: number | null
    platformSpend: number | null
    platformConversions: number | null
    platformLeadEvents: number | null
    ga4PaidSessions: number | null
    ga4TotalSessions: number | null
  }
  likely_break: LikelyBreak
  explanation: string
  next_steps: string[]
}

export interface TrackingDiagnosticUnavailable {
  diagnosed: false
  fixed: false
  reason: string
}

export type TrackingDiagnosticOutput = TrackingDiagnosticResult | TrackingDiagnosticUnavailable

export async function runTrackingDiagnostic(
  input: TrackingDiagnosticInput,
): Promise<TrackingDiagnosticOutput> {
  const db = createServiceClient()
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date()
  start.setDate(start.getDate() - 7)
  const startStr = start.toISOString().slice(0, 10)
  const endStr = end.toISOString().slice(0, 10)
  const window = { start: startStr, end: endStr }

  if (input.platform === 'meta') {
    return runMetaDiagnostic(db, input.campaignId, window)
  }
  return runGoogleDiagnostic(db, input.campaignId, window)
}

type Db = ReturnType<typeof createServiceClient>

async function runMetaDiagnostic(
  db: Db,
  campaignId: string,
  window: { start: string; end: string },
): Promise<TrackingDiagnosticOutput> {
  const { data: insights } = await db
    .from('meta_campaign_insights')
    .select('clicks, spend, actions_json')
    .eq('campaign_id', campaignId)
    .gte('date_start', window.start)
    .lte('date_start', window.end)

  if (!insights?.length) {
    return { diagnosed: false, fixed: false, reason: 'No Meta campaign insight data available for the last 7 days.' }
  }

  const clicks = insights.reduce((a, r) => a + (Number(r.clicks) || 0), 0)
  const spend = insights.reduce((a, r) => a + (Number(r.spend) || 0), 0)

  let leadEvents = 0
  for (const row of insights) {
    const actions = row.actions_json as Array<{ action_type: string; value: string }> | null
    if (actions) {
      for (const action of actions) {
        if (action.action_type === 'lead' || action.action_type.startsWith('offsite_conversion')) {
          leadEvents += Number(action.value ?? 0)
        }
      }
    }
  }

  // Check GA4 for paid Facebook/Instagram sessions
  const ga4Paid = await fetchGA4PaidSessions(db, window, ['facebook', 'instagram', 'fb', 'ig', 'meta'])
  const ga4Total = await fetchGA4TotalSessions(db, window)

  const evidence = {
    platformClicks: clicks,
    platformSpend: spend,
    platformConversions: leadEvents,
    platformLeadEvents: leadEvents,
    ga4PaidSessions: ga4Paid,
    ga4TotalSessions: ga4Total,
  }

  return classifyBreak('meta', campaignId, window, evidence)
}

async function runGoogleDiagnostic(
  db: Db,
  campaignId: string,
  window: { start: string; end: string },
): Promise<TrackingDiagnosticOutput> {
  const { data: daily } = await db
    .from('google_ads_campaign_daily')
    .select('clicks, cost_micros, conversions')
    .eq('campaign_id', campaignId)
    .gte('date', window.start)
    .lte('date', window.end)

  if (!daily?.length) {
    return { diagnosed: false, fixed: false, reason: 'No Google Ads daily data available for the last 7 days.' }
  }

  const clicks = daily.reduce((a, r) => a + (Number(r.clicks) || 0), 0)
  const spend = daily.reduce((a, r) => a + Number(r.cost_micros ?? 0), 0) / 1_000_000
  const conversions = daily.reduce((a, r) => a + (Number(r.conversions) || 0), 0)

  const ga4Paid = await fetchGA4PaidSessions(db, window, ['google'])
  const ga4Total = await fetchGA4TotalSessions(db, window)

  const evidence = {
    platformClicks: clicks,
    platformSpend: spend,
    platformConversions: conversions,
    platformLeadEvents: null,
    ga4PaidSessions: ga4Paid,
    ga4TotalSessions: ga4Total,
  }

  return classifyBreak('google', campaignId, window, evidence)
}

async function fetchGA4PaidSessions(
  db: Db,
  window: { start: string; end: string },
  sources: string[],
): Promise<number | null> {
  const { data } = await db
    .from('ga4_traffic_sources')
    .select('sessions, session_source, session_medium')
    .gte('date', window.start)
    .lte('date', window.end)
    .in('session_medium', ['cpc', 'paid', 'ppc', 'paidsocial'])

  if (!data?.length) return null

  const matchedSessions = data
    .filter(r => sources.some(s => (r.session_source as string).toLowerCase().includes(s)))
    .reduce((a, r) => a + (Number(r.sessions) || 0), 0)

  return matchedSessions
}

async function fetchGA4TotalSessions(
  db: Db,
  window: { start: string; end: string },
): Promise<number | null> {
  const { data } = await db
    .from('ga4_daily')
    .select('sessions')
    .gte('date', window.start)
    .lte('date', window.end)

  if (!data?.length) return null
  return data.reduce((a, r) => a + (Number(r.sessions) || 0), 0)
}

function classifyBreak(
  platform: 'meta' | 'google',
  campaignId: string,
  window: { start: string; end: string },
  evidence: TrackingDiagnosticResult['evidence'],
): TrackingDiagnosticResult {
  const { platformClicks, platformConversions, ga4PaidSessions } = evidence
  let likely_break: LikelyBreak
  let explanation: string
  let next_steps: string[]

  if (platformClicks === null || platformClicks === 0) {
    likely_break = 'no_traffic'
    explanation = 'The campaign did not generate any clicks in the last 7 days. No traffic is reaching the website.'
    next_steps = [
      'Verify the campaign is active and has budget',
      'Check ad creative and targeting settings',
      'Review campaign status in the ad platform',
    ]
  } else if ((platformConversions ?? 0) === 0 && (ga4PaidSessions ?? 0) > 0) {
    likely_break = 'traffic_with_ga4_activity'
    explanation = `The campaign generated ${platformClicks} clicks and GA4 shows ${ga4PaidSessions} paid sessions, but the ad platform reports 0 conversions. This strongly suggests a tracking/pixel mismatch — traffic is arriving but conversion events are not firing back to the ad platform.`
    next_steps = [
      'Verify the Meta pixel / Google Ads conversion tag is installed on the conversion page',
      'Check that the conversion event (lead form submission, purchase, etc.) fires correctly',
      'Use Meta Events Manager or Google Tag Assistant to debug event firing',
      'Verify no cross-domain tracking gaps between landing page and conversion page',
    ]
  } else if ((platformConversions ?? 0) === 0 && ga4PaidSessions === null) {
    likely_break = 'traffic_no_platform_conversion'
    explanation = `The campaign generated ${platformClicks} clicks but the platform reports 0 conversions. GA4 paid session data is unavailable, so we cannot determine whether traffic is actually reaching the website.`
    next_steps = [
      'Verify GA4 is connected and syncing to get more diagnostic evidence',
      'Check that tracking pixels/tags are installed on the website',
      'Review the landing page URL for redirect issues',
      'Check conversion event configuration in the ad platform',
    ]
  } else if ((platformConversions ?? 0) === 0 && (ga4PaidSessions ?? 0) === 0) {
    likely_break = 'traffic_no_platform_conversion'
    explanation = `The campaign generated ${platformClicks} clicks but neither the ad platform nor GA4 show conversions or paid sessions. Traffic may not be reaching the website, or tracking is completely absent.`
    next_steps = [
      'Verify the landing page URL is correct and accessible',
      'Check for redirect chains that may strip tracking parameters',
      'Verify GA4 and ad platform tracking tags are installed',
      'Check whether ad clicks are being intercepted (ad blockers, bot traffic)',
    ]
  } else {
    likely_break = 'insufficient_evidence'
    explanation = `The campaign has ${platformClicks} clicks and ${platformConversions ?? 0} conversions. No clear tracking break detected from available data.`
    next_steps = [
      'Review conversion attribution settings',
      'Compare conversion counts across platforms',
      'Check conversion window settings',
    ]
  }

  return {
    diagnosed: true,
    fixed: false,
    platform,
    campaignId,
    window,
    evidence,
    likely_break,
    explanation,
    next_steps,
  }
}
