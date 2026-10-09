import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../../../helpers/paid-strategy'
import { budget, compileInput, creative, newCampaign, tracking } from '../../../../helpers/paid-strategy-implementation'
import { IDS } from '../../../../helpers/paid-strategy'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { StrategyImplementationData } from '@/lib/actions/marketing/paid-strategy-implementation'
import type { ImplementationView } from '@/lib/marketing/paid-strategy/implementation/types'

vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({ prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(), getStrategyImplementations: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
import PaidStrategySection from '@/app/(marketing)/marketing/brain/PaidStrategySection'
import PreviewPanel from '@/app/(marketing)/marketing/brain/ImplementationPreview'
import { compileImplementation } from '@/lib/marketing/paid-strategy/implementation/compile'
import { toClientPreview } from '@/lib/marketing/paid-strategy/implementation/service'
import { confirmLabel, effectiveStatus, isReserving, stateLabel } from '@/lib/marketing/paid-strategy/implementation/state'

const base: PaidStrategyData = { allowed: true, canGenerate: false, latest: run({ id: 'run-1' }), previous: [run({ id: 'run-0', generated_at: '2026-09-01T10:00:00Z' })], latestAttempt: null, error: null }
const view = (over: Partial<ImplementationView>): ImplementationView => ({ id: 'i1', strategyRunId: 'run-1', recommendationIndex: 0, mode: 'implementation_task', status: 'started', linkedTaskId: 'task-9', linkedTaskStatus: 'open', ownerName: 'Adam', budgetReservedDkk: 0, error: null, approvedAt: '2026-10-09T08:00:00Z', ...over })
const render = (implementations?: Partial<StrategyImplementationData>, data: Partial<PaidStrategyData> = {}) => renderToStaticMarkup(
  <PaidStrategySection data={{ ...base, ...data }} implementations={implementations ? { canApprove: true, views: [], error: null, ...implementations } : undefined} />)

describe('Approve & implement on the strategy cards', () => {
  it('is offered on each current recommendation to approvers only, and never on a plain advisory render', () => {
    expect(render({ canApprove: true }).match(/Approve &amp; implement/g)?.length).toBeGreaterThanOrEqual(3)
    expect(render({ canApprove: false })).not.toContain('Approve &amp; implement</button>')
    expect(render(undefined)).not.toMatch(/Approve|Execute|Apply|Run now|Fix it/i)
  })
  it('shows the implementation state after approval and links the task, with no second button', () => {
    const html = render({ views: [view({ recommendationIndex: 0 })] })
    expect(html).toContain('Task created · Adam')
    expect(html).toContain('href="/tasks/task-9"')
    expect(html.match(/Approve &amp; implement<\/button>/g)?.length).toBe(2 + 0) // the other two current cards only (previous run is superseded)
  })
  it('words each state honestly: "started" is never "launched"', () => {
    const pkg = view({ mode: 'implementation_package', status: 'started' })
    expect(stateLabel(pkg)).toBe('Package saved · Task created · Adam')
    expect(stateLabel(view({ status: 'in_motion', mode: 'platform_action', linkedTaskId: null }))).toContain('being monitored')
    expect(stateLabel(view({ status: 'needs_input' }))).toBe('Needs input')
    expect(stateLabel(view({ status: 'completed' }))).toBe('Completed · Adam')
    expect(stateLabel(view({ status: 'failed' }))).toBe('Failed · nothing was changed')
    for (const status of ['prepared', 'needs_input', 'approved', 'started', 'in_motion', 'completed', 'cancelled', 'needs_attention', 'failed'] as const)
      expect(stateLabel(view({ status })), status).not.toMatch(/launched|implemented/i)
  })
  it('shows needs-attention and completed states and keeps them out of the button path', () => {
    for (const [status, text] of [['needs_attention', 'Needs attention'], ['completed', 'Completed'], ['in_motion', 'In motion']] as const)
      expect(render({ views: [view({ status })] })).toContain(text)
  })
  it('marks old runs "Superseded by newer strategy" and offers no button there', () => {
    const html = render({})
    expect(html).toContain('Superseded by newer strategy')
    const previous = html.slice(html.indexOf('Previous runs'))
    expect(previous).not.toContain('Approve &amp; implement</button>')
    expect(previous.match(/Superseded by newer strategy/g)?.length).toBe(3)
  })
  it('keeps historical runs readable and shows what happened to anything implemented from them', () => {
    const html = render({ views: [view({ strategyRunId: 'run-0', recommendationIndex: 1, status: 'completed' })] })
    expect(html).toContain('Test a founder-led Reel angle')
    expect(html).toContain('Completed · Adam')
  })
  it('hides the controls and says why when implementation storage is unavailable', () => {
    const html = render({ error: 'Implementation state is unavailable. Confirm the migration is activated.' })
    expect(html).toContain('Implementation state is unavailable')
    expect(html).not.toContain('Approve &amp; implement</button>')
    expect(html).toContain('Test a retargeting layer') // the strategy itself still renders
  })
  it('derives state from the linked task, and mirrors the database for what still reserves budget', () => {
    expect(effectiveStatus('started', 'done')).toBe('completed')
    expect(effectiveStatus('started', 'cancelled')).toBe('cancelled')
    expect(effectiveStatus('in_motion', 'done')).toBe('in_motion')
    expect(isReserving('started', 'open')).toBe(true)
    expect(isReserving('started', 'done')).toBe(false)
    expect(isReserving('failed', null)).toBe(false); expect(isReserving('completed', null)).toBe(false); expect(isReserving('needs_attention', null)).toBe(true)
  })
})

const form = { owner: 'u1', due: '2026-10-16', reserve: '', targetId: '', action: '', newBudget: '', location: '', set: () => {} }
const panel = (rec: Parameters<typeof compileInput>[0] extends infer T ? T : never, index = 0) => {
  const c = compileImplementation(compileInput(rec as never), index)
  return renderToStaticMarkup(<PreviewPanel preview={toClientPreview(c)} targets={[]} owners={[{ id: 'u1', name: 'Adam' }]} minDate="2026-10-09" form={form} />)
}

describe('confirmation wording states what WILL and WILL NOT happen', () => {
  it('tracking: a task, owner and due date, and explicitly no Meta change', () => {
    const html = panel({ recommendation: tracking })
    for (const t of ['Create an implementation task', 'Kockpit will', 'Kockpit will not', 'This will not change Meta, Google or any ad account.', 'Extra paid-media budget: 0 DKK', 'Owner', 'Due', 'A person must', 'Kockpit cannot automate']) expect(html, t).toContain(t)
    expect(confirmLabel(false)).toBe('Confirm implementation')
  })
  it('creative: a Killer Kreative task and no auto-publishing', () => {
    const html = panel({ recommendation: creative }, 1)
    expect(html).toContain('Create a Killer Kreative task')
    expect(html).toContain('No ad is created or published; the creative must be approved by a person first.')
    expect(html).toContain('This will not change Meta.')
  })
  it('new campaign: a package and task, the reserved ceiling, and no campaign created', () => {
    const html = panel({ recommendation: newCampaign }, 2)
    for (const t of ['Create a structured launch package and implementation task', 'Extra paid-media budget: 2,000 DKK', 'No Meta campaign, ad set, ad or creative will be created in this version.', 'No money is spent until a person launches it.', 'Creating a new campaign structure in Meta is not supported by Kockpit yet.', '8,800 DKK of the shared headroom is available', 'hard cap, not a target', 'Lead form or landing page'])
      expect(html, t).toContain(t)
  })
  it('platform action: the resolved target, before and after, live re-check, and the execute label', () => {
    const c = compileImplementation(compileInput({ recommendation: budget, inputs: { platform: { action: 'set_daily_budget', targetType: 'campaign', targetId: IDS.c1, targetDailyBudget: 80 } } }), 0)
    const html = renderToStaticMarkup(<PreviewPanel preview={toClientPreview(c)} targets={[]} owners={[]} minDate="2026-10-09" form={form} />)
    for (const t of ['Reduce the daily budget', 'from 100 DKK per day to 80 DKK per day', 'Re-read the live state first', 'Budget changes above 20% are refused', 'Existing Meta object']) expect(html, t).toContain(t)
    expect(html).not.toContain('Owner')
    expect(confirmLabel(true)).toBe('Confirm & execute')
    expect(html).not.toContain(IDS.c1)
  })
  it('needs input: lists the smallest missing inputs and offers no owner or due date yet', () => {
    const html = panel({ recommendation: budget }, 3)
    expect(html).toContain('Needed before this can go ahead')
    expect(html).toContain('Which existing campaign or ad set')
    expect(html).toContain('What to change')
    expect(html).not.toContain('Kockpit will</p>')
  })
  it('works at phone width: the dialog is a bottom sheet with a scrollable body', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync('app/(marketing)/marketing/brain/ImplementationPreview.tsx', 'utf8')
    const control = fs.readFileSync('app/(marketing)/marketing/brain/ImplementationControl.tsx', 'utf8')
    expect(control).toContain("e.key === 'Escape'")
    expect(source).toMatch(/items-end[^"]*sm:items-center/)
    expect(source).toContain('max-h-[92dvh]')
    expect(source).toContain('overflow-y-auto')
    expect(source).toContain('shrink-0') // the action buttons are pinned below the scrolling body
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
  })
})
