import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { discoverCapabilities, inputsFromEnv } from '@/lib/marketing/paid-strategy/autonomous/capabilities'
import { diagnoseTracking, DOWNSTREAM_EVENT, executeTracking, scanSiteHtml, type TrackingWriter } from '@/lib/marketing/paid-strategy/autonomous/tracking'

const ENV = { META_SYSTEM_USER_TOKEN: 'x', META_AD_ACCOUNT_ID: 'act_1', META_FACEBOOK_PAGE_ID: '1', ANTHROPIC_API_KEY: 'x' }
const META = ['ads_management', 'ads_read']
const caps = (env: Record<string, string> = ENV) => discoverCapabilities(inputsFromEnv(env, META, ['https://www.googleapis.com/auth/analytics.readonly']))
const html = readFileSync('__tests__/fixtures/catering-page.html', 'utf8')
const site = scanSiteHtml(html)
const pixel = { id: '942936014341416', name: 'Killer Kebab', lastFiredTime: '2026-10-08T18:25:12+0000', unavailable: false }

describe('diagnosing the real stack', () => {
  it('reads the platform, container, pixel, form and contact from the live page markup', () => {
    expect(site).toMatchObject({ platform: 'webflow', gtmContainers: ['GTM-P4RTHWT7', 'GTM-FAKE00000'], pixelIds: ['942936014341416'], fbqEvents: ['PageView'], mailto: ['hello@killerkebab.com'] })
    expect(site.forms).toEqual([{ id: 'wf-form-Killer-Katering-Enquiry', name: 'wf-form-Killer-Katering-Enquiry', method: 'get' }])
  })
  it('treats the page as untrusted data: bounded, structural, nothing executed or echoed', () => {
    expect(JSON.stringify(scanSiteHtml('<script>alert(1)</script>'.repeat(50)))).not.toContain('alert')
    expect(scanSiteHtml('plain').platform).toBe('unknown')
    expect(scanSiteHtml('x'.repeat(2_000_000)).forms).toEqual([])
  })
  it('production today: BLOCKED with the exact missing capabilities, and no task', () => {
    const d = diagnoseTracking(caps(), site, pixel)
    expect(d.route).toBeNull()
    expect(d.blockers.map(b => b.code)).toEqual(['lead_source_missing', 'enquiry_contact_unreadable'])
    expect(d.blockers.every(b => b.kind === 'access' && b.unblock.length > 20)).toBe(true)
    expect(d.blockers[0].message).toContain('no CRM or booking status')
    expect(d.evidence.site).toMatchObject({ gtmContainers: expect.arrayContaining(['GTM-P4RTHWT7']) })
    expect(d.evidence.pixel).toMatchObject({ id: '942936014341416' })
  })
  it('does not claim GTM or GA4 access would solve an offline booking', () => {
    const codes = diagnoseTracking(caps(), site, pixel).blockers.map(b => b.capability)
    expect(codes).not.toContain('tracking_gtm_write'); expect(codes).not.toContain('tracking_ga4_write')
  })
  it('names the downstream event distinctly from the existing LEAD', () => {
    expect(DOWNSTREAM_EVENT.name).toBe('CateringBookingConfirmed'); expect(DOWNSTREAM_EVENT.existingEvent).toContain('LEAD')
  })
  it('records a failed site scan as evidence rather than failing', () => {
    expect(diagnoseTracking(caps(), null, pixel, 'timeout').evidence.siteError).toBe('timeout')
  })
})

describe('execution never claims success without a verified write', () => {
  const ready = () => diagnoseTracking(caps({ ...ENV, CATERING_LEAD_SOURCE: 'x', WEBFLOW_API_TOKEN: 'x' }), site, pixel)
  const writer = (verify: TrackingWriter['verify'], write: TrackingWriter['write'] = async () => ({ ref: 'evt-1' })): TrackingWriter => ({ id: 'meta_capi', write: vi.fn(write), verify: vi.fn(verify) })

  it('with access it writes, then verifies, then completes with the writer\'s own evidence', async () => {
    const w = writer(async () => ({ ok: true, evidence: 'Meta reports 1 event received for CateringBookingConfirmed' }))
    expect(ready().route).toBe('meta_capi')
    expect(await executeTracking(ready(), [w])).toEqual({ status: 'completed', ref: 'evt-1', evidence: 'Meta reports 1 event received for CateringBookingConfirmed' })
    expect(w.verify).toHaveBeenCalledWith('evt-1')
  })
  it('a write that cannot be verified is needs_attention, not completed', async () => {
    expect((await executeTracking(ready(), [writer(async () => ({ ok: false, evidence: 'no events seen' }))])).status).toBe('needs_attention')
    expect((await executeTracking(ready(), [writer(async () => { throw new Error('timeout') })])).status).toBe('needs_attention')
  })
  it('a write that throws is uncertain, and verification is never skipped on success', async () => {
    const w = writer(async () => ({ ok: true, evidence: 'x' }), async () => { throw new Error('socket hang up') })
    expect(await executeTracking(ready(), [w])).toMatchObject({ status: 'needs_attention', reason: expect.stringContaining('Check before retrying') })
    expect(w.verify).not.toHaveBeenCalled()
  })
  it('without a writer it waits with a capability blocker; with blockers it never writes', async () => {
    expect(await executeTracking(ready(), [])).toMatchObject({ status: 'waiting_for_access', blockers: [{ code: 'writer_not_built' }] })
    const w = writer(async () => ({ ok: true, evidence: 'x' }))
    expect((await executeTracking(diagnoseTracking(caps(), site, pixel), [w])).status).toBe('waiting_for_access')
    expect(w.write).not.toHaveBeenCalled()
  })
})
