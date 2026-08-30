'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { AppUser } from '@/lib/types'
import WorkspaceSwitcher from './WorkspaceSwitcher'

/**
 * Marketing nav items defined as a data structure so that future Marketing
 * permission checks can filter this list without touching the rendering code.
 *
 * exact=true: active state requires an exact pathname match.
 * Without exact: active when pathname starts with href + '/'.
 * Morning Brief is exact because /marketing is a prefix of every other route.
 */
const MARKETING_NAV = [
  { href: '/marketing',                         label: 'Morning Brief',          exact: true  },
  { href: '/marketing/needs-review',            label: 'Needs Review',           exact: false },
  { href: '/marketing/paid',                    label: 'Paid',                   exact: false },
  { href: '/marketing/organic',                 label: 'Organic',                exact: false },
  { href: '/marketing/google-business-profile', label: 'Google Business Profile', exact: false },
  { href: '/marketing/content',                 label: 'Content',                exact: false },
  { href: '/marketing/creative-studio',         label: 'Creative Studio',        exact: false },
] as const

export default function MarketingShell({
  user,
  children,
}: {
  user: AppUser
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const initials = user.display_name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-kk-sidebar border-r border-kk-line flex flex-col sticky top-0 h-screen">
        {/* Wordmark */}
        <div className="px-5 pt-6 pb-4">
          <div className="font-black tracking-tight text-2xl text-kk-ink leading-none">
            Killer Kockpit
          </div>
          <div className="text-xs font-bold tracking-widest uppercase text-kk-muted mt-1">
            Marketing
          </div>
        </div>

        {/* Workspace switcher */}
        <div className="px-3 pb-4">
          <WorkspaceSwitcher currentWorkspace="marketing" />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {MARKETING_NAV.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + '/')

            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'flex items-center w-full px-3 py-2.5 rounded-xl text-sm transition-colors',
                  isActive
                    ? 'bg-kk-ink text-white font-medium'
                    : 'text-kk-muted hover:bg-kk-line hover:text-kk-ink',
                ].join(' ')}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* User footer */}
        <div className="border-t border-kk-line mx-3 mb-4 pt-3">
          <div className="flex items-center gap-2.5 px-2">
            <div className="w-8 h-8 rounded-full bg-kk-line flex items-center justify-center text-xs font-bold text-kk-ink shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-kk-ink truncate">
                {user.display_name}
              </div>
              <div className="text-xs text-kk-muted">{user.role}</div>
            </div>
            <button
              onClick={handleSignOut}
              className="text-xs text-kk-muted hover:text-kk-ink transition-colors shrink-0"
              title="Sign out"
            >
              Out
            </button>
          </div>
        </div>
      </aside>

      {/* Main area — no CaptureBar in Marketing M0 */}
      <main className="flex-1 p-7 max-w-7xl w-full mx-auto">
        {children}
      </main>
    </div>
  )
}
