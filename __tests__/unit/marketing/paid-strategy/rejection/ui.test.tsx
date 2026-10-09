import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../../../helpers/paid-strategy'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'

vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), resumeStrategyImplementation: vi.fn(), activateStrategyImplementation: vi.fn(), cancelStrategyImplementation: vi.fn(),
  rejectStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import PaidStrategySection from '@/app/(marketing)/marketing/brain/PaidStrategySection'
import { RejectDialog } from '@/app/(marketing)/marketing/brain/ImplementationPreview'
import { isReserving, stateLabel } from '@/lib/marketing/paid-strategy/implementation/state'

const base: PaidStrategyData = { allowed: true, canGenerate: false, latest: run({ id: 'run-1' }), previous: [run({ id: 'run-0', generated_at: '2026-09-01T10:00:00Z' })], latestAttempt: null, error: null }
const view = (over: Partial<ImplementationView> = {}): ImplementationView => ({ id: 'i1', strategyRunId: 'run-1', recommendationIndex: 2, mode: 'campaign_creation', status: 'ready_to_activate', budgetReservedDkk: 2100, error: null, approvedAt: 'x', blockers: [], message: 'ok', review: null, linkedTaskId: null, ...over })
const render = (implementations?: Partial<StrategyImplementationData>) => renderToStaticMarkup(
  <PaidStrategySection data={base} implementations={implementations ? { canApprove: true, views: [], error: null, ...implementations } : undefined} />)
const REASON = 'We do not want to advertise catering in Malmö.'

describe('Reject appears beside Approve & implement', () => {
  it('approvers get [Reject] [Approve & implement] on every latest recommendation, Reject first and secondary (not the brand button)', () => {
    const html = render({ canApprove: true })
    expect(html.match(/>Reject<\/button>/g)?.length).toBe(3)
    expect(html.match(/Approve &amp; implement<\/button>/g)?.length).toBe(3)
    const reject = html.indexOf('>Reject</button>'); const approve = html.indexOf('Approve &amp; implement</button>')
    expect(reject).toBeGreaterThan(-1); expect(reject).toBeLessThan(approve)
    const rejectTag = html.slice(html.lastIndexOf('<button', reject), reject)
    expect(rejectTag).not.toContain('bg-kk-brand'); expect(rejectTag).toContain('border-kk-line')
  })
  it('is not offered to readers without paid_approve, or on a plain advisory render', () => {
    expect(render({ canApprove: false })).not.toContain('>Reject<')
    expect(render(undefined)).not.toMatch(/Reject/)
  })
  it('previous (superseded) runs have no Reject control and no Approve control', () => {
    const html = render({ canApprove: true })
    const previous = html.slice(html.indexOf('Previous runs'), html.indexOf('Advisory only'))
    expect(previous).not.toContain('>Reject<'); expect(previous).not.toContain('Approve &amp; implement')
    expect(previous).toContain('Superseded by newer strategy')
  })
  it('is also offered where a recommendation is ready to activate or blocked, and never while Kockpit is working or once live', () => {
    const ready = render({ views: [view({ status: 'ready_to_activate', review: { kind: 'campaign', title: 'T', lines: [], notes: [] } })] })
    expect(ready.match(/>Reject<\/button>/g)?.length).toBe(3) // the ready card and the two fresh ones
    expect(ready).toContain('Ready to activate')
    for (const status of ['waiting_for_access', 'needs_attention', 'waiting_for_input'] as const) expect(render({ views: [view({ status, budgetReservedDkk: 0 })] }), status).toContain('>Reject</button>')
    for (const status of ['executing', 'planning', 'in_motion', 'completed'] as const) {
      const html = render({ views: [view({ status })] })
      // the two untouched cards keep their own Reject; the card in that state has none
      expect(html.match(/>Reject<\/button>/g)?.length ?? 0, status).toBe(2)
    }
  })
})

describe('the rejected card state', () => {
  const rejected = view({ status: 'rejected', budgetReservedDkk: 0, review: null, rejectionReason: REASON, rejectedAt: '2026-10-10T10:00:00Z', metaObjectsExist: true })
  it('shows Rejected and the reason, with no Approve button and no Reject button on that card', () => {
    const html = render({ views: [rejected] })
    expect(html).toContain('Rejected'); expect(html).toContain(`&ldquo;${REASON}&rdquo;`.replace('&ldquo;', '“').replace('&rdquo;', '”').replace(/“|”/g, m => m)) // quotes rendered as characters
    expect(html.match(/Approve &amp; implement<\/button>/g)?.length).toBe(2)
    expect(html.match(/>Reject<\/button>/g)?.length).toBe(2)
    expect(html).not.toContain('Review &amp; activate')
  })
  it('says paused Meta objects remain and cannot spend, and reserves nothing', () => {
    const html = render({ views: [rejected] })
    expect(html).toContain('Paused objects created earlier in Meta remain and cannot spend. Nothing was activated or deleted.')
    expect(html).not.toContain('DKK reserved')
  })
  it('a rejection with no reason shows just Rejected; with no Meta objects there is no paused-object warning', () => {
    const html = render({ views: [view({ status: 'rejected', budgetReservedDkk: 0, rejectionReason: null, metaObjectsExist: false })] })
    expect(html).toContain('Rejected'); expect(html).not.toContain('Paused objects created earlier')
  })
  it('it is rendered the same on a reload (state comes from the database, not from the click)', () => { expect(render({ views: [rejected] })).toBe(render({ views: [rejected] })) })
  it('a rejected implementation never counts as a reservation', () => {
    expect(isReserving('rejected')).toBe(false); expect(stateLabel({ status: 'rejected', mode: 'needs_input', blockers: [], message: null })).toBe('Rejected')
  })
})

describe('the confirmation dialog', () => {
  const dialog = (over: Partial<React.ComponentProps<typeof RejectDialog>> = {}) => renderToStaticMarkup(
    <RejectDialog id="rej" title="Launch a Malmö catering leads campaign mirroring C2" reason="" onReason={() => {}} pending={false} error="" reservedDkk={0} metaObjectsExist={false} onCancel={() => {}} onReject={() => {}} {...over} />)
  it('is compact: REJECT STRATEGY, the title, an optional reason with examples, and Cancel / Reject strategy', () => {
    const html = dialog()
    expect(html).toContain('Reject strategy'); expect(html).toContain('Launch a Malmö catering leads campaign mirroring C2'); expect(html).toContain('Reason (optional)')
    for (const ex of ['Not strategically relevant', 'We do not want to offer catering in Malmö', 'Wrong priority right now']) expect(html).toContain(ex)
    expect(html.indexOf('>Cancel<')).toBeLessThan(html.lastIndexOf('>Reject strategy<'))
    expect(html).toContain('maxLength="500"')
  })
  it('explains the release and the paused objects only when they apply, and disables the button while it runs', () => {
    expect(dialog()).not.toContain('released'); expect(dialog()).not.toContain('remain and cannot spend')
    const html = dialog({ reservedDkk: 2100, metaObjectsExist: true })
    expect(html).toContain('The 2,100 DKK reserved for it is released.'); expect(html).toContain('paused objects already created in Meta remain and cannot spend')
    expect(dialog({ pending: true })).toMatch(/disabled=""[^>]*>Rejecting…/)
  })
})
