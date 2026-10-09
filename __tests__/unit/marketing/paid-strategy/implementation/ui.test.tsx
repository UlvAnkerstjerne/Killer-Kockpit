import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../../../helpers/paid-strategy'
import { budget, compileInput, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'
import { IDS } from '../../../../helpers/paid-strategy'

vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), resumeStrategyImplementation: vi.fn(), activateStrategyImplementation: vi.fn(), cancelStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import PaidStrategySection from '@/app/(marketing)/marketing/brain/PaidStrategySection'
import PreviewPanel, { ActivationPanel } from '@/app/(marketing)/marketing/brain/ImplementationPreview'
import { compileImplementation } from '@/lib/marketing/paid-strategy/implementation/compile'
import { activationReview } from '@/lib/marketing/paid-strategy/implementation/review'
import { toClientPreview } from '@/lib/marketing/paid-strategy/implementation/service'
import { confirmLabel, isReserving, modeLabel, stateLabel } from '@/lib/marketing/paid-strategy/implementation/state'
import type { Blocker } from '@/lib/marketing/paid-strategy/autonomous/types'

const base: PaidStrategyData = { allowed: true, canGenerate: false, latest: run({ id: 'run-1' }), previous: [run({ id: 'run-0', generated_at: '2026-09-01T10:00:00Z' })], latestAttempt: null, error: null }
const blocker = (over: Partial<Blocker> = {}): Blocker => ({ kind: 'access', code: 'lead_source_missing', message: 'Kockpit cannot see when a catering enquiry becomes a confirmed booking.', unblock: 'Tell Kockpit where a confirmed booking is recorded.', ...over })
const view = (over: Partial<ImplementationView> = {}): ImplementationView => ({ id: 'i1', strategyRunId: 'run-1', recommendationIndex: 0, mode: 'tracking_execution', status: 'waiting_for_access', budgetReservedDkk: 0, error: null, approvedAt: '2026-10-10T08:00:00Z', blockers: [blocker()], message: null, review: null, linkedTaskId: null, ...over })
const render = (implementations?: Partial<StrategyImplementationData>, data: Partial<PaidStrategyData> = {}) => renderToStaticMarkup(
  <PaidStrategySection data={{ ...base, ...data }} implementations={implementations ? { canApprove: true, views: [], error: null, ...implementations } : undefined} />)

describe('cards show execution state, not a task', () => {
  it('Approve & implement is offered to approvers only, and never on a plain advisory render', () => {
    expect(render({ canApprove: true }).match(/Approve &amp; implement<\/button>/g)?.length).toBe(3)
    expect(render({ canApprove: false })).not.toContain('Approve &amp; implement</button>')
    expect(render(undefined)).not.toMatch(/Approve|Execute|Apply|Run now|Fix it/i)
  })
  it('a blocked recommendation shows the exact missing thing and the smallest unblock, with Check again and no task link', () => {
    const html = render({ views: [view()] })
    expect(html).toContain('Blocked — needs access: Kockpit cannot see when a catering enquiry becomes a confirmed booking.')
    expect(html).toContain('Smallest unblock:'); expect(html).toContain('Tell Kockpit where a confirmed booking is recorded.')
    expect(html).toContain('Check again'); expect(html).toContain('Cancel and release budget')
    expect(html).not.toMatch(/Open the task|Task created|href="\/tasks/)
    expect(html.match(/Approve &amp; implement<\/button>/g)?.length).toBe(2) // the other two cards
  })
  it('a physical handoff is the only waiting state that mentions filming, and it names exactly that', () => {
    const t = stateLabel(view({ status: 'waiting_for_input', mode: 'creative_execution', blockers: [blocker({ kind: 'physical', code: 'film_shots', message: 'Film 4 shots.', unblock: 'Film 4 shots for the approved catering ad' })] }))
    expect(t).toBe('Waiting for filming: Film 4 shots for the approved catering ad')
    expect(stateLabel(view({ status: 'waiting_for_input', blockers: [blocker({ kind: 'input', message: 'Say which ad is the control.' })] }))).toBe('Waiting for you: Say which ad is the control.')
  })
  it('every status has honest wording; nothing claims "launched" or "implemented" before it is true', () => {
    for (const status of ['prepared', 'needs_input', 'approved', 'planning', 'executing', 'verifying', 'waiting_for_input', 'waiting_for_access', 'ready_to_activate', 'started', 'in_motion', 'completed', 'cancelled', 'needs_attention', 'failed'] as const)
      expect(stateLabel(view({ status })), status).not.toMatch(/launched|task created/i)
    expect(stateLabel(view({ status: 'ready_to_activate' }))).toBe('Ready to activate · created and verified, still paused')
    expect(stateLabel(view({ status: 'in_motion', mode: 'campaign_creation' }))).toBe('In motion · live and being monitored')
    expect(stateLabel(view({ status: 'needs_attention', message: 'Meta did not confirm the ad was created.' }))).toContain('check before retrying')
  })
  it('ready to activate offers review & activate, not a second approve button, and shows the reservation', () => {
    const review = { kind: 'campaign' as const, title: 'Killer Katering - Malmö Leads (V1)', lines: [{ label: 'Daily budget', value: '100 DKK' }], notes: ['Nothing has been activated.'] }
    const html = render({ views: [view({ status: 'ready_to_activate', mode: 'campaign_creation', blockers: [], review, budgetReservedDkk: 2100, message: 'The paused Malmö structure was created and verified.' })] })
    expect(html).toContain('Review &amp; activate'); expect(html).toContain('2,100 DKK reserved'); expect(html).toContain('The paused Malmö structure was created and verified.')
    expect(html.match(/Approve &amp; implement<\/button>/g)?.length).toBe(2)
  })
  it('old runs say "Superseded by newer strategy" and offer nothing; the latest only is implementable', () => {
    const previous = render({}).slice(render({}).indexOf('Previous runs'))
    expect(previous.match(/Superseded by newer strategy/g)?.length).toBe(3); expect(previous).not.toContain('Approve &amp; implement</button>')
  })
  it('a storage problem hides the controls and says why, while the strategy still renders', () => {
    const html = render({ error: 'Implementation state is unavailable. Confirm the migration is activated.' })
    expect(html).toContain('Implementation state is unavailable'); expect(html).not.toContain('Approve &amp; implement</button>'); expect(html).toContain('Test a retargeting layer')
  })
  it('reservation logic mirrors the database', () => {
    for (const s of ['approved', 'planning', 'executing', 'verifying', 'waiting_for_input', 'waiting_for_access', 'ready_to_activate', 'in_motion', 'needs_attention'] as const) expect(isReserving(s), s).toBe(true)
    for (const s of ['prepared', 'needs_input', 'completed', 'cancelled', 'failed'] as const) expect(isReserving(s), s).toBe(false)
  })
})

const form = { owner: 'u1', due: '2026-10-17', targetId: '', action: '', newBudget: '', dailyBudget: '', days: '', set: () => {} }
const panel = (over: Record<string, unknown>, index = 0) => {
  const c = compileImplementation(compileInput(over as never), index)
  return renderToStaticMarkup(<PreviewPanel preview={toClientPreview(c)} targets={[]} owners={[{ id: 'u1', name: 'Adam' }]} minDate="2026-10-10" form={form} />)
}

describe('confirmation wording: what Kockpit will do, where it expects to stop, who it will ask', () => {
  it('tracking: investigates now, says today it will stop at the exact access, creates no task', () => {
    const html = panel({ recommendation: tracking })
    for (const t of ['Kockpit will investigate your live tracking now', 'Where this will stop today', 'Smallest unblock:', 'Kockpit cannot see when a catering enquiry becomes a confirmed booking', 'It will not create a task for work Kockpit can do.', 'Extra paid-media budget: 0 DKK']) expect(html, t).toContain(t)
    expect(confirmLabel('tracking_execution', false)).toBe('Confirm implementation')
  })
  it('creative: Kockpit writes it and builds a paused ad; only filming could reach a person', () => {
    const html = panel({ recommendation: creative }, 1)
    for (const t of ['prepare a paused ad in', 'using only facts the existing ad already states', 'create it PAUSED and read it back', 'It will not publish or spend anything', 'only for the filming', 'If filming is needed, assign it to']) expect(html, t).toContain(t)
    expect(confirmLabel('creative_execution', true)).toBe('Confirm & build (paused)')
  })
  it('Malmö campaign: the exact structure, the reserved budget, and activation as a separate step', () => {
    const html = panel({ recommendation: newCampaign }, 2)
    for (const t of ['Kockpit will build a paused Malmö copy of', '100 DKK a day for 21 days', 'Extra paid-media budget reserved: 2,100 DKK (100 DKK a day for 21 days)', 'It will not activate or spend anything', 'It will not create a task', 'Activating is a separate approval', '8,800 DKK of the shared headroom is available', 'hard cap, not a target']) expect(html, t).toContain(t)
    expect(html).not.toMatch(/Owner|Needed by/)
  })
  it('an existing-campaign change keeps its guardrail wording and "Confirm & execute"', () => {
    const c = compileImplementation(compileInput({ recommendation: budget, inputs: { platform: { action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 80 } } }), 3)
    const html = renderToStaticMarkup(<PreviewPanel preview={toClientPreview(c)} targets={[]} owners={[]} minDate="2026-10-10" form={form} />)
    for (const t of ['from 100 DKK per day to 80 DKK per day', 'Re-read the live state first', 'Budget changes above 20% are refused']) expect(html, t).toContain(t)
    expect(html).not.toContain(IDS.c1); expect(confirmLabel('platform_action', true)).toBe('Confirm & execute')
  })
  it('missing spend is asked for with two plain fields', () => {
    const html = panel({ recommendation: { ...newCampaign, exact_test_or_action: 'Create a new leads campaign in Malmö mirroring C2.' } }, 2)
    expect(html).toContain('Daily budget (DKK)'); expect(html).toContain('Days to run'); expect(html).toContain('Needed before this can go ahead')
  })
  it('modes have plain names', () => { expect([modeLabel('tracking_execution'), modeLabel('creative_execution'), modeLabel('campaign_creation')]).toEqual(['Tracking', 'Creative', 'New campaign']) })
})

describe('the activation review shows exactly what will be switched on', () => {
  const ledger = (evidence: Record<string, unknown>) => ({ version: 'v1' as const, token: 'KK-1', steps: [], blockers: [], evidence })
  it('campaign: names, optimisation, location, placements, budget, run length, destination, copy and the review notes', () => {
    const review = activationReview('campaign_creation', ledger({ plan: { campaignName: 'Killer Katering - Malmö Leads [KK-1]', adSetName: 'Katering Leads - Malmö Broad [KK-1]', adName: 'Carousel [KK-1]', objective: 'OUTCOME_LEADS · OFFSITE_CONVERSIONS', optimisation: 'OFFSITE_CONVERSIONS on LEAD, IMPRESSIONS, lowest cost', geo: "Malmö, the location already used by \"Malmö Brand - Foodies Always On (V2)\"", placements: 'instagram, stream, profile_feed', dailyBudgetDkk: 100, totalBudgetDkk: 2100, durationDays: 21, destination: 'https://www.killerkebab.com/catering', copy: 'Finally. #Malmö', reviewNotes: ['Nothing has been activated.'] } }))!
    const html = renderToStaticMarkup(<ActivationPanel review={review} totalReserved={2100} />)
    for (const t of ['Killer Katering - Malmö Leads [KK-1]', 'Location', 'Malmö Brand - Foodies Always On (V2)', 'Daily budget', '100 DKK', 'Runs for', '21 days from activation', 'Total reserved', '2,100 DKK', 'Destination', 'https://www.killerkebab.com/catering', 'Ad copy', 'Budget reserved: 2,100 DKK', 'Nothing has been activated.']) expect(html, t).toContain(t)
  })
  it('creative: the words, the variable, what changed and what is constant, and the idea it did not use', () => {
    const review = activationReview('creative_execution', ledger({ package: { headline: 'Team lunch, 149 DKK per person', primary_text: 'Catering for your team.', description: 'Minimum 10 people', cta: 'GET_QUOTE', hook_options: ['A', 'B', 'C'] }, testDesign: { variable: 'Offer-first copy', changed: ['primary text', 'headline'], heldConstant: ['The images and the destination link are identical to the existing ad.'], successMetric: 'Higher link-to-lead rate', durationDays: 14, control: 'Carousel V1.1', adSet: 'Katering Leads', needsBusinessDecision: ['Whether to promise a same-day quote'] } }))!
    const html = renderToStaticMarkup(<ActivationPanel review={review} totalReserved={0} />)
    for (const t of ['Team lunch, 149 DKK per person', 'Variable tested', 'Offer-first copy', 'primary text, headline', 'Carousel V1.1, in the same ad set', 'Test length', '14 days', 'identical to the existing ad', 'Whether to promise a same-day quote', 'Nothing is live: the new ad is paused until you activate it.']) expect(html, t).toContain(t)
    expect(activationReview('tracking_execution', ledger({}))).toBeNull(); expect(activationReview('campaign_creation', null)).toBeNull()
  })
  it('works at phone width: a bottom sheet with a scrolling body and pinned actions, closable with Escape', async () => {
    const fs = await import('node:fs')
    const frame = fs.readFileSync('app/(marketing)/marketing/brain/ImplementationPreview.tsx', 'utf8'); const control = fs.readFileSync('app/(marketing)/marketing/brain/ImplementationControl.tsx', 'utf8')
    expect(frame).toMatch(/items-end[^"]*sm:items-center/); expect(frame).toContain('max-h-[92dvh]'); expect(frame).toContain('overflow-y-auto'); expect(frame).toContain('shrink-0'); expect(frame).toContain('role="dialog"'); expect(frame).toContain('aria-modal="true"')
    expect(control).toContain("e.key === 'Escape'")
  })
})
