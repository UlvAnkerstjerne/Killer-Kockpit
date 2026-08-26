'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { canAccessManagementView } from '@/lib/permissions'
import type { AppUser, ViewMode } from '@/lib/types'
import CaptureBar from './CaptureBar'

const NAV_ITEMS = [
  { href: '/today',     label: 'Today',    milestone: 1 },
  { href: '/inbox',     label: 'Inbox',    milestone: 2 },
  { href: '/projects',  label: 'Projects', milestone: 1 },
  { href: '/tasks',     label: 'Tasks',    milestone: 1 },
  { href: '/team',      label: 'Team',     milestone: 2 },
  { href: '/people',    label: 'People',   milestone: 2 },
  { href: '/meetings',  label: 'Meetings', milestone: 2 },
  { href: '/knowledge', label: 'Knowledge',milestone: 2 },
]

export default function AppShell({
  user,
  children,
}: {
  user: AppUser
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const managementAllowed = canAccessManagementView(user.role)

  const currentView = (searchParams.get('view') as ViewMode) ??
    (managementAllowed ? 'management' : 'personal')

  function setView(v: ViewMode) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('view', v)
    router.push(`${pathname}?${params.toString()}`)
  }

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
        <div className="px-5 pt-6 pb-7">
          <div className="font-black tracking-tight text-2xl text-kk-ink leading-none">
            Killer Kockpit
          </div>
          <div className="text-xs font-bold tracking-widest uppercase text-kk-muted mt-1">
            Killer Kebab OS
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/')
            const isDeferred = item.milestone > 1

            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'flex items-center justify-between w-full px-3 py-2.5 rounded-xl text-sm transition-colors',
                  active
                    ? 'bg-kk-ink text-white font-medium'
                    : isDeferred
                    ? 'text-kk-muted hover:bg-kk-line hover:text-kk-ink'
                    : 'text-kk-muted hover:bg-kk-line hover:text-kk-ink',
                ].join(' ')}
              >
                {item.label}
                {isDeferred && !active && (
                  <span className="text-xs opacity-50">Soon</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* View toggle — only shown for users with management access */}
        {managementAllowed && (
          <div className="px-3 pb-3">
            <div className="flex bg-white border border-kk-line rounded-xl p-1">
              <button
                onClick={() => setView('management')}
                className={[
                  'flex-1 text-xs py-1.5 px-2 rounded-lg transition-colors',
                  currentView === 'management'
                    ? 'bg-kk-ink text-white font-medium'
                    : 'text-kk-muted hover:text-kk-ink',
                ].join(' ')}
              >
                Org
              </button>
              <button
                onClick={() => setView('personal')}
                className={[
                  'flex-1 text-xs py-1.5 px-2 rounded-lg transition-colors',
                  currentView === 'personal'
                    ? 'bg-kk-ink text-white font-medium'
                    : 'text-kk-muted hover:text-kk-ink',
                ].join(' ')}
              >
                Mine
              </button>
            </div>
          </div>
        )}

        {/* User */}
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

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        <CaptureBar user={user} currentView={currentView} />
        <main className="flex-1 p-7 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
