import type { PaidStrategyRun } from '@/lib/marketing/paid-strategy/types'

/** The three recommendations of the 8 Oct 2026 production run, as stored (text unchanged). */
export const REAL_RECS: PaidStrategyRun['recommendations'] = [
  {
    title: 'Add a measurable conversion event to the catering lead funnel before scaling spend',
    evidence: 'C2 (Killer Katering - Copenhagen Leads, V1) has spent 1,972 DKK over 21 days and recorded 6 leads, giving an observed cost per lead of 328.72 DKK (small_sample=true). All 6 are attributed via offsite_conversion.fb_pixel_lead and onsite_web_lead simultaneously, suggesting a Meta-side pixel event rather than a verified CRM or closed-order signal. No revenue, close rate, or customer value data exists in the account. The catering objective (B2B or group orders) implies a meaningful sales cycle before a lead becomes revenue.',
    hypothesis: 'If a downstream qualification signal is added (for example a CRM stage or a confirmed-booking event fed back to Meta via CAPI), the account will be able to distinguish lead quality and make spend decisions based on actual business outcomes rather than raw form submissions.',
    interpretation: 'With only 6 leads in 21 days, no statistical trend is possible. The 328.72 DKK observed cost per lead may be acceptable or unacceptable depending on catering order value and close rate—both unknown. One reading is that the pixel fires correctly on form submission but nothing downstream confirms whether those leads are qualified or convert to bookings, making it impossible to judge whether continued spend is efficient or wasteful.',
    success_metric: "A verified CAPI event for a downstream catering action (qualified lead or confirmed booking) appears in Events Manager with match quality rated 'Great' or above, and at least one such event fires within the next 14 days of C2 running, confirming the pipeline is instrumented end-to-end.",
    recommendation_type: 'tracking',
    evidence_limitations: 'Only 6 leads recorded; no trend claim is possible. Pixel match rate is not in the data—if it is below 90%, event quality may already be compromised. Close rate, customer value, and target CPL are all unknown, so no judgment on whether 328.72 DKK per lead is good or bad can be made. CRM or booking-system integration complexity is unknown.',
    exact_test_or_action: "Map the catering enquiry journey from form submission to confirmed booking. Implement a server-side CAPI event (e.g. 'CateringBookingConfirmed') or a CRM webhook that fires when a lead is marked qualified or won. Verify the event appears in Meta Events Manager with a match quality score before any budget change is considered. No incremental spend is required; this is a measurement setup task. Budget: 0 DKK.",
    incremental_budget_dkk: 0,
  },
  {
    title: 'Test a direct-response offer creative in the catering lead campaign to improve lead volume',
    evidence: 'C2 currently runs one active ad (A3, Killer Katering Carousel - Leads V1.1) with a CPM of 91.09 DKK—more than 3× the CPM of the awareness campaigns C1 (28.24 DKK) and C3 (26.95 DKK). In 21 days of spend, 295 link clicks and 6 leads were recorded, giving a click-to-lead rate of approximately 2%. Only one creative concept is in test; no alternative angle or format has been exposed in this campaign.',
    hypothesis: 'A second creative concept using an explicit offer hook (group size, delivery radius, or response-time guarantee) will generate a higher lead rate per click than the current carousel within a 14-day test window, revealing whether the constraint is the angle or the funnel.',
    interpretation: "The elevated CPM is expected for a leads objective targeting a narrower B2B-adjacent audience, but with a single creative there is no way to know whether the carousel format or the current angle is limiting lead volume. A 2% click-to-lead rate could reflect a landing page issue, an audience mismatch, or a creative that attracts curiosity but not genuine catering intent. One reading is that a more direct offer-framing (e.g. a specific group-size trigger, a price anchor, or a 'get a quote in 24h' promise) might attract higher-intent clicks and lift the lead rate.",
    success_metric: "The new ad's click-to-lead rate over 14 days is higher than A3's current 2% (295 clicks / 6 leads), assessed as a directional signal only given expected small sample size. Secondary: observed cost per lead is lower than A3's 328.72 DKK in the same window.",
    recommendation_type: 'creative',
    evidence_limitations: "Only 6 leads total; no statistical significance is possible in 14 days at this spend level. Target CPL and catering order value are unknown, so 'better' is judged relative to A3 only, not against a profitability threshold. Targeting definition for S3 is unknown—audience quality may be the limiting factor rather than the creative. Click-to-lead rate uses raw counts which may include bots or low-intent traffic.",
    exact_test_or_action: 'Within C2, introduce one new ad alongside A3 using a different concept angle: a single static or short video with an offer-first hook (for example a specific group-size threshold or a same-day-quote promise). Run both ads simultaneously under S3 for 14 days. Do not increase the ad set daily budget of 100 DKK—the test is funded by existing spend. After 14 days, compare link-to-lead rate and observed cost per lead between A3 and the new ad, treating both as observations given the small sample. Budget: 0 DKK incremental.',
    incremental_budget_dkk: 0,
  },
  {
    title: 'Launch a Malmö catering leads campaign mirroring C2 structure to test market demand',
    evidence: 'The account runs two active city-level brand awareness campaigns: C1 for Copenhagen (7,070 DKK, current 28d) and C3 for Malmö (1,396 DKK, current 28d). A leads campaign exists only for Copenhagen (C2, 1,972 DKK, current 28d). Malmö has no active lead-generation campaign. Projected incremental headroom for the remainder of October is 2,721 DKK. The catering vertical (Killer Katering) is named without a city qualifier, but no Malmö leads effort is evidenced in the data.',
    hypothesis: 'A new Malmö catering leads campaign using the same creative and form structure as C2 will generate at least one verified lead within 21 days, indicating the market is worth instrumenting with a proper funnel.',
    interpretation: 'The absence of a Malmö leads campaign may mean catering demand has not been tested there, or that Malmö was deprioritised. If catering is a meaningful revenue line, leaving an entire market without a lead-capture path means the awareness spend in C3 produces no measurable business outcome. One reading is that even a small, time-limited Malmö leads test would reveal whether catering interest exists in that market before committing further awareness budget.',
    success_metric: 'At least 1 verified lead event recorded in Meta Events Manager for the new Malmö campaign within 21 days, with observed cost per lead below the current C2 observed rate of 328.72 DKK, treated as a directional signal only given expected small sample.',
    recommendation_type: 'campaign_structure',
    evidence_limitations: 'Projected incremental headroom of 2,721 DKK is a projection, not a fact; actual remaining capacity may be lower if active campaigns overspend on some days. Malmö audience size for catering intent is unknown. No target CPL or close rate is defined, so cost efficiency cannot be assessed against a profitability benchmark. The recommendation is sequenced after Rec 1 (tracking setup): if the CAPI event is not yet live, leads from this campaign will carry the same attribution uncertainty as C2.',
    exact_test_or_action: 'Create a new leads-objective campaign targeting the Malmö metro area, mirroring the S3 broad targeting logic. Use A3\'s carousel creative (or a Malmö-localised version if copy references Copenhagen locations) as the initial ad. Set a daily budget of 100 DKK and run for 21 days, spending at most 2,100 DKK incremental. Stop and review after 21 days: if zero leads, the market or format needs reassessment before further spend. Incremental budget: 2,100 DKK (within the 2,721 DKK projected headroom; remaining 621 DKK left as buffer for spend variation).',
    incremental_budget_dkk: 2100,
  },
]

/** Tone and clarity targets for the plain-language fields (a fixture of the register, not model output). */
export const HUMAN_COPY = [
  { display_title: 'Track which catering leads actually become customers', display_summary: "Right now we know who fills in the catering form, but not who actually books. Let's fix that before we spend more." },
  { display_title: 'Try a second catering ad with a clearer offer', display_summary: "We only have one catering ad, so we don't know if the message is holding us back. Let's test a second angle." },
  { display_title: 'Give our Copenhagen awareness ads something measurable', display_summary: "We get plenty of reach but can't tell if it brings customers in. Let's test a simple offer we can track. This needs about 2,100 DKK extra spend." },
] as const

/** The same three ideas as a NEW run stores them: detailed fields untouched, plus the display fields. */
export const NEW_RECS = REAL_RECS.map((r, i) => ({ ...r, ...HUMAN_COPY[i] }))
