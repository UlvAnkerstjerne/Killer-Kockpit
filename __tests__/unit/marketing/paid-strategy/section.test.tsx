import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { rec, run } from '../../../helpers/paid-strategy'
import type { PaidStrategyData } from '@/lib/actions/marketing/paid-strategy'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'

vi.mock('@/lib/actions/marketing/paid-strategy', () => ({ getPaidStrategy: vi.fn(), generatePaidStrategyAnalysis: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import PaidStrategySection from '@/app/(marketing)/marketing/brain/PaidStrategySection'
import PaidStrategyButton from '@/app/(marketing)/marketing/brain/PaidStrategyButton'
import BrainView from '@/app/(marketing)/marketing/brain/BrainView'

const base: PaidStrategyData = { allowed: true, canGenerate: false, latest: null, previous: [], latestAttempt: null, error: null }
const render = (data: Partial<PaidStrategyData>, control?: React.ReactNode) => renderToStaticMarkup(<PaidStrategySection data={{ ...base, ...data }} generateControl={control} />)

describe('PAID STRATEGY section', () => {
  it('renders nothing for a reader without access', () => {
    expect(render({ allowed: false })).toBe('')
  })
  it('shows a distinct empty state, and who can generate', () => {
    const html = render({})
    expect(html).toContain('Paid strategy')
    expect(html).toContain('No Paid Strategy analysis yet')
    expect(html).toContain('A SUPER_ADMIN can generate the first analysis.')
    expect(html).not.toContain('<button')
  })
  it('shows the generate control only when the user may generate', () => {
    const control = <button>Generate Paid Strategy</button>
    expect(render({ canGenerate: true }, control)).toContain('Generate Paid Strategy')
    expect(render({ canGenerate: false }, control)).not.toContain('Generate Paid Strategy')
  })
  it('renders all three recommendations with every required field, separating facts from inference', () => {
    const html = render({ latest: run() })
    for (const text of [
      '1. Follow up with people who already watched our Reels (1)', 'Test a retargeting layer for engaged viewers (1)', 'Test a founder-led Reel angle', 'Verify lead tracking before testing more',
      'Retargeting', 'Creative', 'Tracking',
      'Facts · from our data', 'Interpretation · inference, not fact', 'Hypothesis', 'Test or action', 'Success metric', 'Evidence limitations',
      'Copenhagen Brand - Always On (V2) (C1) spent DKK 2,800',
    ]) expect(html, text).toContain(text)
    expect(html.match(/<article/g)).toHaveLength(3)
  })
  it('shows provenance, the hard-cap context and the advisory-only statement', () => {
    const html = render({ latest: run() })
    expect(html).toContain('mesper-meta-ads@2.1.0#cbfc19c')
    expect(html).toContain('synthetic-model')
    expect(html).toContain('Month to date 1,400 of the 15,000 DKK ceiling (a hard cap, not a target)')
    expect(html).toContain('Advisory only. Nothing here changes a campaign.')
    expect(html).toContain('Needs Review')
  })
  it('has no approve, execute or apply control of any kind on the recommendations', () => {
    const html = render({ latest: run(), previous: [run({ id: 'old' })] })
    expect(html).not.toContain('<button')
    expect(html).not.toMatch(/Approve|Execute|Apply|Run now|Fix it/i)
  })
  it('shows the projection next to the month-to-date figure and labels it a projection', () => {
    const html = render({ latest: run() })
    expect(html).toContain('Projection: about 6,200 by month end, about 8,800 DKK spare for new tests')
    const unreliable = render({ latest: run({ evidence: { budget: { monthly_ceiling: 15000, month_to_date_spend: 1400, currency: 'DKK', projection: { projected_month_end_spend: 6200, projected_incremental_headroom: null, reliable: false } } } }) })
    expect(unreliable).toContain('no reliable spare headroom')
  })
  it('shows each recommendation\'s extra budget, and copes with rows saved before the field existed', () => {
    const html = render({ latest: run({ recommendations: [rec(1, { incremental_budget_dkk: 1200 }), rec(2, { title: 'A zero-spend measurement fix', incremental_budget_dkk: 0 })] }) })
    expect(html).toContain('Extra budget needed')
    expect(html).toContain('1,200 DKK on top of existing spend')
    expect(html).toContain('None (no extra spend)')
    const legacy: Record<string, unknown> = { ...rec(1) }
    delete legacy.incremental_budget_dkk
    const old = render({ latest: run({ recommendations: [legacy as never] }) })
    expect(old).not.toContain('Extra budget needed')
    expect(old).toContain('<article')
  })
  it('lists what the analysis could not see', () => {
    expect(render({ latest: run() })).toContain('What this analysis could not see')
    expect(render({ latest: run({ evidence: null }) })).not.toContain('What this analysis could not see')
  })
  it('shows previous runs so earlier analyses can be inspected', () => {
    const html = render({ latest: run(), previous: [run({ id: 'old', generated_at: '2026-09-01T10:00:00Z', recommendations: [rec(1, { title: 'An older idea worth reading' })] })] })
    expect(html).toContain('Previous runs (1)')
    expect(html).toMatch(/1 Sep\w* 2026 · 1 recommendation ·/)
    expect(html).toContain('An older idea worth reading')
  })
  it('escapes model or platform text instead of rendering it as markup', () => {
    const html = render({ latest: run({ recommendations: [rec(1, { title: '<script>alert(1)</script> bad title', evidence: '<img src=x onerror=alert(1)> evidence text here' })] }) })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })
  it('handles a run with no recommendations', () => {
    expect(render({ latest: run({ recommendations: [] }) })).toContain('nothing worth recommending')
  })
  it('shows a failed latest attempt next to the last saved result, and a running notice', () => {
    expect(render({ latest: run(), latestAttempt: { status: 'failed', error: 'Generation failed safely.' } })).toContain('Generation failed safely. Showing the last saved result below.')
    expect(render({ latest: run(), latestAttempt: { status: 'running', error: null } })).toContain('A Paid Strategy analysis is running')
  })
  it('shows a storage error without hiding the section', () => {
    const html = render({ error: 'Paid Strategy storage is unavailable. Confirm the migration is activated.' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('storage is unavailable')
  })
})

describe('PaidStrategyButton', () => {
  it('is a single explicit generate control', () => {
    const html = renderToStaticMarkup(<PaidStrategyButton />)
    expect(html).toContain('Generate Paid Strategy')
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})

describe('inside the existing Marketing Brain', () => {
  const brain: BrainData = { allowed: true, canRefresh: false, run: null, latestAttempt: null, error: null }
  it('appears under the Brain header, alongside the unchanged Creative Intelligence content', () => {
    const html = renderToStaticMarkup(<BrainView data={brain} paidStrategy={<PaidStrategySection data={{ ...base, latest: run() }} />} />)
    expect(html).toContain('Marketing Brain')
    expect(html.indexOf('Paid strategy')).toBeGreaterThan(html.indexOf('Marketing Brain'))
    expect(html.indexOf('Paid strategy')).toBeLessThan(html.indexOf('No Creative Intelligence run yet'))
  })
  it('leaves the Brain unchanged when no strategy section is supplied', () => {
    const html = renderToStaticMarkup(<BrainView data={brain} />)
    expect(html).not.toContain('Paid strategy')
    expect(html).toContain('No Creative Intelligence run yet')
  })
})
