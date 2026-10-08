// Desktop-only route restriction on mobile for manager roles (rendered AppShell).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const nav = { pathname: '/today', query: '' }
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push() {}, refresh() {} }),
  useSearchParams: () => new URLSearchParams(nav.query),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/analyze-capture', () => ({}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut: async () => {} } }) }))

import AppShell from '@/components/layout/AppShell'

function render(role: string, pathname: string, query = '') {
  nav.pathname = pathname
  nav.query = query
  const user = { id: 'u', role, display_name: 'T', email: 't@example.test', marketing_access: false } as never
  return renderToStaticMarkup(<AppShell user={user}><div>PAGE-CONTENT</div></AppShell>)
}

describe.each(['UM', 'SUPER_ADMIN'])('AppShell mobile gate — %s', role => {
  describe.each(['', 'view=personal', 'view=management'])('query "%s"', q => {
    it.each(['/projects', '/people', '/brain'])('shows the desktop-only gate for %s', p => {
      const html = render(role, p, q)
      expect(html).toContain('Open this section on desktop')
      expect(html).toContain('hidden md:block') // content still rendered for desktop
    })
    it.each(['/today', '/todos', '/tasks', '/meetings', '/kkc/audit', '/kkc/ssp-cph'])('has no gate for %s', p => {
      expect(render(role, p, q)).not.toContain('Open this section on desktop')
    })
  })
})

describe('AppShell — MEMBER and desktop', () => {
  it('MEMBER is never gated', () => {
    expect(render('MEMBER', '/projects')).not.toContain('Open this section on desktop')
  })
  it('managers keep the desktop Personal/Management toggle', () => {
    const html = render('UM', '/today')
    expect(html).toContain('>Org</button>')
    expect(html).toContain('>Mine</button>')
  })
  it('MEMBER has no Org/Mine toggle', () => {
    expect(render('MEMBER', '/today')).not.toContain('>Org</button>')
  })
})
