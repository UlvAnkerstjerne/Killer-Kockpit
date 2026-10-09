import type { CreativePackage } from '@/lib/marketing/paid-strategy/autonomous/creative'
import { COPENHAGEN_COPY } from './meta-source-config'

// Grounded in the real existing ad: 149 DKK per person, minimum 10 people, five dishes. Nothing else is promised.
export const goodPackage = (over: Partial<CreativePackage> = {}): CreativePackage => ({
  objective: 'Lift the enquiry rate from catering clicks by leading with the offer the ad already makes.',
  offer_angle: 'Price per person and minimum group size first, the menu second.',
  hook_options: ['149 DKK per person. Minimum 10 people.', 'Lunch for your whole team, sorted.', 'Five dishes. One Killer kitchen. One simple price.'],
  primary_text: 'Catering for your team: 149 DKK per person, minimum 10 people. One menu, five dishes, two salads, two spreads and Killer Falafels. hello@killerkebab.com',
  headline: 'Team lunch, 149 DKK per person', description: 'Minimum 10 people', cta: 'GET_QUOTE', cta_rationale: 'The ad now asks for a quote, matching the offer-first angle.',
  video_script: null, shot_list: [], variable_tested: 'Offer-first copy and a quote call to action against the current brand-announcement copy.',
  success_metric: 'Link-to-lead rate above the existing ad over 14 days, as a directional signal.', experiment_days: 14, requires_new_footage: false,
  needs_business_decision: ['Whether to promise a same-day quote'], ...over,
})
export const SOURCES = { copy: COPENHAGEN_COPY, recommendation: 'Run one direct-response offer creative against the current creative in C2, same audience and budget, for 14 days. Hooks such as a same-day-quote promise.' }
