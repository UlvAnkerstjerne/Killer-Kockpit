import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import BrainView, { instagramLink } from '@/app/(marketing)/marketing/brain/BrainView'
import { savedRun } from '../../../helpers/creative-brain'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { AppUser } from '@/lib/types'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/actions/marketing/creative-intelligence', () => ({ getCreativeIntelligence: load }))
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
    for (const text of ['What’s working', 'Best hooks', 'Best themes', 'Best products', 'Format performance', 'Exceptional content', 'Evidence', 'Hypothesis', 'Suggested test', '4 Reel / video posts', 'lifetime performance']) expect(html).toContain(text)
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
      for (const [name, markup] of [['populated', html], ['empty', render(null)]]) {
        writeFileSync(`${dir}/${name}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"><title>Synthetic Marketing Brain QA</title></head><body>${markup}</body></html>`)
      }
    }
  })
})
