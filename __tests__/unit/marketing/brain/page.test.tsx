import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import BrainView, { instagramLink, representativePost } from '@/app/(marketing)/marketing/brain/BrainView'
import { savedRun, currentRun, strongSample, media, fingerprint } from '../../../helpers/creative-brain'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import type { CreativeRun, Observation, ObservationBusinessContext } from '@/lib/marketing/brain/types'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { AppUser } from '@/lib/types'
import { InterpretationSchema, validateInterpretation } from '@/lib/ai/creative-interpretation'
import { buildAnalytics } from '@/lib/marketing/brain/analytics'
import { buildCreativeSignals, signalFinding, signalEvidence } from '@/lib/marketing/brain/signals'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/actions/marketing/creative-intelligence', () => ({ getCreativeIntelligence: load }))
// Insights have their own tests (insights/ui.test.tsx); here the section is simply absent.
vi.mock('@/lib/actions/marketing/insights', () => ({ getMarketingInsights: vi.fn(async () => ({ allowed: false, canCapture: false, insights: [], error: null })) }))
vi.mock('@/lib/actions/marketing/paid-strategy', () => ({
  getPaidStrategy: async () => ({ allowed: false, canGenerate: false, latest: null, previous: [], latestAttempt: null, error: null }),
  generatePaidStrategyAnalysis: vi.fn(),
}))
vi.mock('@/lib/actions/marketing/paid-strategy-implementation', () => ({
  getStrategyImplementations: async () => ({ canApprove: false, views: [], error: null }),
  prepareStrategyImplementation: vi.fn(), confirmStrategyImplementation: vi.fn(),
}))
vi.mock('@/app/(marketing)/marketing/brain/RefreshButton', () => ({ default: () => <button>Refresh Creative Intelligence</button> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))
import MarketingBrainPage from '@/app/(marketing)/marketing/brain/page'
import MarketingShell from '@/components/layout/MarketingShell'
const base: BrainData = { allowed: true, canRefresh: false, run: null, latestAttempt: null, error: null }

describe('Marketing Brain page', () => {
  it('has an empty state and caption limitation before the first run', () => {
    const html = renderToStaticMarkup(<BrainView data={base} />)
    expect(html).toContain('No Creative Intelligence run yet')
    expect(html).toContain('Hook classification currently uses available caption/opening copy')
    expect(html).not.toContain('Refresh Creative Intelligence')
  })
  it('renders the persisted run with visible numeric evidence and every required section', async () => {
    load.mockResolvedValue({ ...base, run: savedRun() })
    const html = renderToStaticMarkup(await MarketingBrainPage())
    for (const text of ['learning', 'Best hooks', 'Best themes', 'Best products', 'Format performance', 'What we learned', 'Try next', '4 Reel / video posts', 'lifetime performance']) expect(html).toContain(text)
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('exposes the refresh control only to authorized admins and distinguishes a failed refresh', () => {
    expect(renderToStaticMarkup(<BrainView data={{ ...base, canRefresh: true }} refreshControl={<button>Refresh Creative Intelligence</button>} />)).toContain('Refresh Creative Intelligence')
    expect(renderToStaticMarkup(<BrainView data={base} refreshControl={<button>Refresh Creative Intelligence</button>} />)).not.toContain('Refresh Creative Intelligence')
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: savedRun(), latestAttempt: { status: 'failed', error: 'Refresh failed safely.' } }} />)
    expect(html).toContain('Showing the last saved result')
  })
  it('does not render stored analytics for a denied reader or render arbitrary Instagram URLs', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, allowed: false, run: savedRun() }} />)
    expect(html).not.toContain('Best themes')
    expect(instagramLink('javascript:alert(1)')).toBeUndefined()
    expect(instagramLink('https://evil.example/instagram.com')).toBeUndefined()
  })

  it('renders within the real Marketing shell; optionally exports synthetic visual QA fixtures', () => {
    const user = { id: 'synthetic', display_name: 'Synthetic Admin', role: 'SUPER_ADMIN' } as AppUser
    const render = (run: BrainData['run']) => renderToStaticMarkup(<MarketingShell user={user} marketingPermissions={[]}>
      <BrainView data={{ ...base, canRefresh: true, run }} refreshControl={<button className="rounded-xl bg-kk-brand px-4 py-2.5 text-sm font-medium text-white">Refresh Creative Intelligence</button>} />
    </MarketingShell>)
    const html = render(savedRun())
    expect(html).toContain('href="/marketing/brain"')
    expect(html).toContain('Mobile Marketing')
    // Opt-in local export: no production preview route, auth bypass or real data.
    const dir = process.env.CREATIVE_BRAIN_QA_DIR
    if (dir) {
      mkdirSync(dir, { recursive: true })
      const css = readdirSync('.next/static/chunks').filter(f => f.endsWith('.css')).map(f => readFileSync(`.next/static/chunks/${f}`, 'utf8')).join('\n')
      writeFileSync(`${dir}/style.css`, css)
      for (const [name, markup] of [['populated', html], ['empty', render(null)], ['v2-current', render(currentRun())]]) {
        writeFileSync(`${dir}/${name}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"><title>Synthetic Marketing Brain QA</title></head><body>${markup}</body></html>`)
      }
    }
  })
})

describe('Marketing Brain usability', () => {
  it('uses "What we\u2019re learning" instead of "What\u2019s working"', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: savedRun() }} />)
    expect(html).toContain('learning')
    expect(html).not.toContain('What&#x27;s working')
    expect(html).not.toContain("What's working")
  })

  it('shows page title "CMO" as primary heading with module label below', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: savedRun() }} />)
    expect(html).toContain('>CMO</h1>')
    expect(html).toContain('Creative Intelligence')
    expect(html).toContain('Instagram Organic')
  })

  it('renders representative post for exceptional signal', () => {
    const run = savedRun()
    const exceptionalSignal = run.signals.find(s => s.type === 'exceptional_post')
    if (!exceptionalSignal) return // No exceptional in strong sample
    const post = representativePost(exceptionalSignal, run.analytics!.posts)
    expect(post).not.toBeNull()
    expect(post!.id).toBe(exceptionalSignal.supporting_media_ids[0])
  })

  it('renders representative post for repeated pattern signal and labels it as example', () => {
    const run = savedRun()
    const patternSignal = run.signals.find(s => s.type === 'hook_outperformance')!
    const post = representativePost(patternSignal, run.analytics!.posts)
    expect(post).not.toBeNull()
    // Should be the strongest measured supporting post
    expect(patternSignal.supporting_media_ids).toContain(post!.id)
    // HTML should label it
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    expect(html).toContain('Example supporting post')
  })

  it('surfaces metric prominently without AI rewriting', () => {
    const run = savedRun()
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    // The metric string (e.g. "1.5× format median") should appear in card
    expect(html).toContain('format median')
    // Comparison line too
    expect(html).toContain('comparison n=')
  })

  it('omits unknown and generic fingerprint values from classification chips', () => {
    const run = savedRun()
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    // Should not show "Unknown" or "No clear hook" as classification chips
    expect(html).not.toMatch(/Unknown\s*·/)
    expect(html).not.toContain('No clear hook ·')
    expect(html).not.toContain('General brand ·')
  })

  it('renders business context block distinctly when present', () => {
    const run = savedRun()
    const ctx: ObservationBusinessContext = {
      update_id: 'upd-test', project_title: 'Killer Katering',
      occurred_on: '2026-10-04', excerpt: 'Completed a big catering job',
      role: 'case_study',
    }
    const runWithCtx: CreativeRun = {
      ...run,
      observations: run.observations.map((o, i) => i === 0 ? { ...(o as Observation), business_context: ctx } : o),
    }
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: runWithCtx }} />)
    expect(html).toContain('Business context')
    expect(html).toContain('Killer Katering')
    expect(html).toContain('Case study')
    // The amber styling distinguishes it
    expect(html).toContain('amber')
  })

  it('renders cleanly when no business context is present', () => {
    const run = savedRun()
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    // Should not crash, and should not show empty business context blocks
    expect(html).not.toContain('Business context</p>')
  })

  it('renders old runs that lack optional business_context field', () => {
    const run = savedRun()
    // Simulate old run: no business_context on analytics, no business_context on observations
    const oldRun: CreativeRun = {
      ...run,
      analytics: { ...run.analytics!, business_context: undefined },
      observations: run.observations.map(o => {
        const { business_context: _, ...rest } = o
        return rest as Observation
      }),
    }
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: oldRun }} />)
    expect(html).toContain('learning')
    expect(html).toContain('Best hooks')
    expect(html).not.toContain('Business context available to Brain')
  })

  it('renders compact analysis coverage with expandable details', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: savedRun() }} />)
    expect(html).toContain('Last 90 days')
    expect(html).toContain('measured')
    expect(html).toContain('classified')
    expect(html).toContain('Analysis details')
    // Should not have the old large coverage card with separate count blocks
    expect(html).not.toContain('Last 90 completed publication days')
  })

  it('does not use lg:grid-cols or fixed-width layouts that break on mobile', () => {
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run: savedRun() }} />)
    // Cards should not require horizontal scrolling (no min-w on card containers)
    // The observation grid uses responsive classes that stack on mobile
    expect(html).toContain('lg:grid-cols-2')
    // Cards themselves should not have min-width
    expect(html).not.toMatch(/min-w-\[.*\].*article/)
  })

  it('validates length limits in the v2 interpretation schema', () => {
    const valid = { brain_take: 'Short and plain take that is valid.', insights: [{ signal_ids: ['sig-test'], headline: 'A short headline',
      take: 'A short take that is valid and under the limit.', next_move: 'Make a catering Reel with a similar opening and pacing.' }] }
    expect(() => InterpretationSchema.parse(valid)).not.toThrow()
    expect(() => InterpretationSchema.parse({ ...valid, insights: [{ ...valid.insights[0], take: 'A'.repeat(601) }] })).toThrow()
    expect(() => InterpretationSchema.parse({ ...valid, insights: [{ ...valid.insights[0], signal_ids: [] }] })).toThrow()
    expect(() => InterpretationSchema.parse({ ...valid, insights: [{ ...valid.insights[0], signal_ids: ['a', 'b', 'c', 'd', 'e'] }] })).toThrow()
  })

  it('preserves grounding restrictions in interpretation validation', () => {
    const { signals } = strongSample()
    const base = { brain_take: 'These posts stand out, but it is early to say why.', insights: [{ signal_ids: [signals[0].id], headline: 'These posts stand out',
      take: 'This is worth another look before we decide anything.', next_move: 'Run a test comparing the two formats side by side.' }] }
    expect(() => validateInterpretation(base, signals)).not.toThrow()
    const withTake = (take: string) => ({ ...base, insights: [{ ...base.insights[0], take }] })
    expect(() => validateInterpretation(withTake('This content reaches 50% more people.'), signals)).toThrow()
    expect(() => validateInterpretation(withTake('Women respond well to this content.'), signals)).toThrow()
  })

  it('exceptional content section is collapsed by default when present', () => {
    // Create a run with exceptional posts
    const posts = [100, 100, 100, 100, 10000].map((plays, i) => media(i, { plays }))
    const fps = posts.map(p => fingerprint(p))
    const analytics = buildAnalytics(posts, fps, new Date('2026-09-24T12:00:00Z'))
    const signals = buildCreativeSignals(analytics)
    const run: CreativeRun = {
      id: 'exc-run', generated_at: '2026-09-24T12:00:00Z',
      analysis_start: analytics.window.start, analysis_end: analytics.window.end,
      model: 'test', prompt_version: 'test', classification_version: 'test',
      status: 'completed', analytics, signals,
      observations: signals.map(s => ({
        signal_id: s.id, finding: signalFinding(s), evidence: signalEvidence(s),
        interpretation: 'This post stands out significantly in the current sample.',
        suggested_experiment: 'Test replicating the specific creative approach.',
      })),
      classification_counts: { eligible: 5, classified: 5, skipped: 0, failed: 0, deferred: 0 },
      error: null,
    }
    const html = renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
    // Exceptional content should be in a <details> element (collapsed)
    expect(html).toContain('Exceptional content')
    expect(html).toMatch(/<details[\s\S]*?Exceptional content/)
  })
})
