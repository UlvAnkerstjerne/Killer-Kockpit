import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'

vi.mock('next/navigation', () => ({ usePathname: () => '/marketing/brain', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
import BrainView from '@/app/(marketing)/marketing/brain/BrainView'

const brain: BrainData = { allowed: true, canRefresh: false, run: null, latestAttempt: null, error: null }

describe('Marketing Brain headline icon', () => {
  const html = renderToStaticMarkup(<BrainView data={brain} />)
  const h1 = html.slice(html.indexOf('<h1'), html.indexOf('</h1>') + 5)
  it('puts a brain icon before the headline text, inside the h1', () => {
    expect(h1).toContain('data-brain-icon'); expect(h1.indexOf('<svg')).toBeLessThan(h1.indexOf('Marketing Brain'))
  })
  it('is decorative: hidden from assistive technology, so the heading still reads "Marketing Brain"', () => {
    expect(h1).toContain('aria-hidden="true"'); expect(h1.replace(/<[^>]+>/g, '')).toBe('Marketing Brain')
  })
  it('uses the text colour and does not shrink in a narrow header', () => {
    expect(h1).toContain('stroke="currentColor"'); expect(h1).toContain('shrink-0'); expect(h1).toContain('items-center gap-3')
  })
})
