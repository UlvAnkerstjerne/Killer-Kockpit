'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { canAccessManagementView, canAccessMarketing, canManagePeople, canManageLocations } from '@/lib/permissions'
import type { AppUser, ViewMode } from '@/lib/types'
import CaptureBar from './CaptureBar'
import WorkspaceSwitcher from './WorkspaceSwitcher'

// ─── Inline nav icons (simple SVG, no external dep) ──────────────────────────

function IconToday() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M5 1v3M11 1v3M1.5 6.5h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function IconTasks() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M2 4.5h12M2 8h8M2 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function IconProjects() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M1.5 5.5L8 2l6.5 3.5v7L8 16l-6.5-3.5v-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}
function IconWaiting() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M8 4.5V8l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconDecisions() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M2.5 8.5L6 12l7.5-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconTodos() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M9.5 4.5h4M9.5 11.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function IconMeetings() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <rect x="1" y="3" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M11 6.5l4-2v7l-4-2V6.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}
function IconTeam() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M1 14c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="12" cy="5" r="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M14.5 14c0-2.21-1.12-4-3.5-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function IconInbox() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M1.5 9h3.5l1.5 2h4l1.5-2h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  )
}
function IconPeople() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M2 14c0-3.31 2.69-6 6-6s6 2.69 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function IconLocations() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M8 1.5C5.52 1.5 3.5 3.52 3.5 6c0 3.5 4.5 8.5 4.5 8.5S12.5 9.5 12.5 6c0-2.48-2.02-4.5-4.5-4.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx="8" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  )
}
function IconKnowledge() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <path d="M3 2.5h7l3 3V14H3V2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M10 2.5V5.5H13" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M6 8.5h4M6 11h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function IconSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

const ICON_MAP: Record<string, React.FC> = {
  '/today':       IconToday,
  '/tasks':       IconTasks,
  '/projects':    IconProjects,
  '/waiting-ons': IconWaiting,
  '/decisions':   IconDecisions,
  '/todos':       IconTodos,
  '/meetings':    IconMeetings,
  '/team':        IconTeam,
  '/inbox':       IconInbox,
  '/people':      IconPeople,
  '/locations':   IconLocations,
  '/knowledge':   IconKnowledge,
  '/settings':    IconSettings,
}

// ─── Nav groups ───────────────────────────────────────────────────────────────

const PRIMARY_NAV = [
  { href: '/today',       label: 'Today' },
  { href: '/tasks',       label: 'Tasks' },
  { href: '/projects',    label: 'Projects' },
  { href: '/waiting-ons', label: 'Waiting On' },
  { href: '/decisions',   label: 'Decisions' },
  { href: '/todos',       label: 'To-Dos' },
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
  const marketingAllowed = canAccessMarketing(user.role, user.marketing_access)

  const secondaryNav = [
    { href: '/meetings',  label: 'Meetings',  active: true  },
    { href: '/team',      label: 'Team',      active: true  },
    { href: '/inbox',     label: 'Inbox',     active: false },
    ...(canManagePeople(user.role)    ? [{ href: '/people',    label: 'People',    active: true }] : []),
    ...(canManageLocations(user.role) ? [{ href: '/locations', label: 'Locations', active: true }] : []),
    { href: '/knowledge', label: 'Knowledge', active: false },
    { href: '/settings',  label: 'Settings',  active: true  },
  ]

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

  function NavLink({ href, label, deferred }: { href: string; label: string; deferred?: boolean }) {
    const isActive = pathname === href || pathname.startsWith(href + '/')
    const Icon = ICON_MAP[href]
    return (
      <Link
        href={href}
        className={[
          'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm transition-colors',
          isActive
            ? 'bg-[#ecddc8] text-kk-ink font-bold'
            : 'text-kk-ink/60 hover:bg-kk-soft hover:text-kk-ink',
        ].join(' ')}
      >
        {Icon && (
          <span className={isActive ? 'text-kk-ink' : 'text-kk-ink/50'}>
            <Icon />
          </span>
        )}
        <span className="flex-1 truncate">{label}</span>
      </Link>
    )
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-kk-sidebar border-r border-kk-line flex flex-col sticky top-0 h-screen">

        {/* Brand */}
        <div className="px-5 pt-5 pb-4">
          <div className="font-brand text-[26px] font-black text-kk-brand leading-none tracking-tight">
            KILLER
          </div>
          <div className="font-brand text-[12px] font-extrabold text-kk-ink/80 leading-tight tracking-[0.1em] uppercase mt-1">
            KOCKPIT
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 overflow-y-auto">
          {/* Primary group */}
          <div className="mb-1">
            <div className="px-2.5 mb-1.5 text-[10px] font-bold tracking-[0.12em] uppercase text-kk-ink/40">
              Operations
            </div>
            <div className="space-y-0.5">
              {PRIMARY_NAV.map(item => (
                <NavLink key={item.href} href={item.href} label={item.label} />
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="my-2 border-t border-kk-line" />

          {/* Secondary group */}
          <div className="space-y-0.5">
            {secondaryNav.map(item => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                deferred={!item.active}
              />
            ))}
          </div>
        </nav>

        {/* Org / Personal view toggle */}
        {managementAllowed && (
          <div className="px-3 pb-2">
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

        {/* Workspace switcher */}
        {marketingAllowed && (
          <div className="px-3 pb-2">
            <WorkspaceSwitcher currentWorkspace="management" />
          </div>
        )}

        {/* User */}
        <div className="border-t border-kk-line mx-3 mb-4 pt-3">
          <div className="flex items-center gap-2.5 px-1">
            <div className="w-7 h-7 rounded-full bg-kk-line flex items-center justify-center text-[11px] font-bold text-kk-ink shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-kk-ink truncate leading-tight">
                {user.display_name}
              </div>
              <div className="text-[10px] text-kk-muted">{user.role}</div>
            </div>
            <button
              onClick={handleSignOut}
              className="text-[11px] text-kk-muted hover:text-kk-ink transition-colors shrink-0"
              title="Sign out"
            >
              Log out
            </button>
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {pathname !== '/today' && <CaptureBar user={user} currentView={currentView} />}
        <main className="flex-1 p-4">
          {children}
        </main>
      </div>
    </div>
  )
}
