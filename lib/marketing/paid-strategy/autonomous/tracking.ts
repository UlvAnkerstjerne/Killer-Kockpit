/**
 * Tracking execution for a Paid Strategy tracking recommendation (a downstream conversion event).
 *
 * Order of work, all deterministic:
 *   1. diagnose   scan the live public page and read the pixel from Meta: what already exists
 *   2. plan       pick a route only if every capability it needs is genuinely available
 *   3. write      through a TrackingWriter (one per system Kockpit can write to)
 *   4. verify     the writer must independently confirm the result; success is never assumed
 *
 * No writer exists in production today (see capabilities.ts), so the honest outcome is a precise blocker.
 * The writer interface is here so the same executor completes the work the moment access exists.
 */

import { byId, type Capability } from './capabilities'
import type { Blocker } from './types'

export interface SiteScan {
  platform: 'webflow' | 'unknown'
  gtmContainers: string[]; pixelIds: string[]; ga4Ids: string[]
  forms: { id: string; name: string; method: string }[]
  fbqEvents: string[]; mailto: string[]
}

const uniq = <T>(a: T[]) => [...new Set(a)]
const all = (re: RegExp, s: string) => [...s.matchAll(re)]

/** Pure: structure only. The HTML is untrusted and is never executed or echoed back whole. */
export function scanSiteHtml(html: string): SiteScan {
  const bounded = html.slice(0, 600_000)
  return {
    platform: /webflow/i.test(bounded) && /data-wf-page|webflow\.(?:js|schunk|shared)/i.test(bounded) ? 'webflow' : 'unknown',
    gtmContainers: uniq(all(/GTM-[A-Z0-9]{4,10}/g, bounded).map(m => m[0])),
    pixelIds: uniq(all(/fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{10,20})/g, bounded).map(m => m[1])),
    ga4Ids: uniq(all(/\bG-[A-Z0-9]{8,12}\b/g, bounded).map(m => m[0])),
    forms: all(/<form\b([^>]*)>/gi, bounded).slice(0, 10).map(m => ({
      id: /\bid="([^"]*)"/.exec(m[1])?.[1] ?? '', name: /\bname="([^"]*)"/.exec(m[1])?.[1] ?? '', method: (/\bmethod="([^"]*)"/.exec(m[1])?.[1] ?? 'get').toLowerCase(),
    })),
    fbqEvents: uniq(all(/fbq\(\s*['"]track['"]\s*,\s*['"]([A-Za-z]+)['"]/g, bounded).map(m => m[1])),
    mailto: uniq(all(/mailto:([^"'?\s>]+)/gi, bounded).map(m => m[1].toLowerCase())),
  }
}

export interface PixelFacts { id: string; name: string; lastFiredTime: string | null; unavailable: boolean }

/** The downstream event the strategy asks for. The name is a custom event so it can never be confused with the existing LEAD. */
export const DOWNSTREAM_EVENT = {
  name: 'CateringBookingConfirmed',
  purpose: 'A catering enquiry that became a confirmed booking, so spend can be judged on bookings and not only on form submissions.',
  fires: 'Once, when a person marks the enquiry as a confirmed booking.',
  parameters: ['value (booking value, if recorded)', 'currency', 'event_id (the enquiry reference, for deduplication)'],
  existingEvent: 'LEAD (fired from the website)',
} as const

export interface TrackingWriter {
  id: 'meta_capi' | 'gtm' | 'webflow'
  write(): Promise<{ ref: string }>
  /** Independent read-back. `ok` must reflect what the destination reports, not what was sent. */
  verify(ref: string): Promise<{ ok: boolean; evidence: string }>
}

export interface TrackingDiagnosis {
  evidence: { site: SiteScan | null; pixel: PixelFacts | null; siteError?: string; capabilities: { id: string; state: string }[] }
  blockers: Blocker[]
  route: 'meta_capi' | null
}

export function diagnoseTracking(caps: Capability[], site: SiteScan | null, pixel: PixelFacts | null, siteError?: string): TrackingDiagnosis {
  const need = (id: Parameters<typeof byId>[1]) => byId(caps, id)
  const blockers: Blocker[] = []
  const lead = need('lead_source'), capi = need('meta_capi_events'), forms = need('lead_form_write')

  // The only route that can observe an OFFLINE booking is a server event from wherever the booking is confirmed.
  if (lead.state === 'missing') blockers.push({
    kind: 'access', code: 'lead_source_missing', capability: 'lead_source',
    message: 'Kockpit cannot see when a catering enquiry becomes a confirmed booking: enquiries arrive as website form emails and there is no CRM or booking status anywhere Kockpit can read.',
    unblock: 'Tell Kockpit where a confirmed catering booking is recorded, or let Kockpit hold a "Booked" mark on each enquiry. Kockpit then sends the CateringBookingConfirmed event to Meta itself.',
  })
  if (forms.state === 'missing') blockers.push({
    kind: 'access', code: 'enquiry_contact_unreadable', capability: 'lead_form_write',
    message: 'To match a booking to the ad click, Kockpit needs the enquiry\'s contact details, but the website form is a native Webflow form whose submissions Kockpit cannot read.',
    unblock: 'Add a Webflow API token with Forms read access to Kockpit.',
  })
  if (capi.state === 'missing') blockers.push({
    kind: 'access', code: 'capi_unavailable', capability: 'meta_capi_events', message: 'Kockpit cannot send server events to the Meta pixel.', unblock: 'Connect the Meta system user token with ads_management.',
  })
  return {
    evidence: { site, pixel, ...(siteError ? { siteError } : {}), capabilities: caps.filter(c => ['meta_capi_events', 'tracking_gtm_write', 'tracking_ga4_write', 'website_code_write', 'lead_source', 'lead_form_write'].includes(c.id)).map(c => ({ id: c.id, state: c.state })) },
    blockers, route: blockers.length === 0 ? 'meta_capi' : null,
  }
}

export type TrackingOutcome =
  | { status: 'completed'; ref: string; evidence: string }
  | { status: 'waiting_for_access'; blockers: Blocker[] }
  | { status: 'needs_attention'; reason: string }

/** Run the chosen writer. Never reports completed unless the writer's own read-back says so. */
export async function executeTracking(diagnosis: TrackingDiagnosis, writers: TrackingWriter[]): Promise<TrackingOutcome> {
  if (diagnosis.blockers.length > 0 || !diagnosis.route) return { status: 'waiting_for_access', blockers: diagnosis.blockers }
  const writer = writers.find(w => w.id === diagnosis.route)
  if (!writer) return { status: 'waiting_for_access', blockers: [{ kind: 'capability', code: 'writer_not_built', capability: 'meta_capi_events', message: 'The route is available but Kockpit has no writer for it yet.', unblock: 'This needs to be built.' }] }
  let ref: string
  try { ref = (await writer.write()).ref } catch (e) {
    return { status: 'needs_attention', reason: `The write was attempted and failed or is uncertain (${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}). Check before retrying.` }
  }
  try {
    const v = await writer.verify(ref)
    return v.ok ? { status: 'completed', ref, evidence: v.evidence } : { status: 'needs_attention', reason: `The write was sent but could not be verified: ${v.evidence}` }
  } catch { return { status: 'needs_attention', reason: 'The write was sent but verification failed. Do not assume it worked.' } }
}
