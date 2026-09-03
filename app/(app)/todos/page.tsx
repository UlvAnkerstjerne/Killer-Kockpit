import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView, MANAGEMENT_ROLES } from '@/lib/permissions'
import type { Todo, TeamTodo } from '@/lib/types'
import TodoPageClient from './TodoPageClient'
import TeamTodosView from './TeamTodosView'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Raw type for the Supabase join result (owner may arrive as object or array)
// ---------------------------------------------------------------------------

type RawTeamTodo = {
  id: string
  user_id: string
  title: string
  priority: number
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
  owner:
    | { id: string; display_name: string }
    | Array<{ id: string; display_name: string }>
    | null
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function TodosPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const canSeeTeam = canAccessManagementView(user.role)

  // Resolve active tab — non-management users always land on My
  const tab = params.tab === 'team' && canSeeTeam ? 'team' : 'my'

  const supabase = await createClient()

  // ── Team view ────────────────────────────────────────────────────────────

  if (tab === 'team') {
    // RLS "todos: management can read all" (migration 027) allows SUPER_ADMIN
    // and UM to SELECT all rows. No user_id filter — we want the whole team.
    // Cancelled todos are excluded (noise; not "in progress" or "done").
    const [teamTodosRes, managementUsersRes] = await Promise.all([
      supabase
        .from('todos')
        .select(
          'id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, owner:user_id (id, display_name)'
        )
        .is('cancelled_at', null)
        .order('priority', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(500),
      // Fetch all active management-role users for the filter bar.
      // This ensures the full team appears even when someone has zero todos.
      supabase
        .from('app_users')
        .select('id, display_name')
        .eq('active', true)
        .in('role', MANAGEMENT_ROLES)
        .order('display_name'),
    ])

    const teamTodos: TeamTodo[] = ((teamTodosRes.data ?? []) as RawTeamTodo[]).map(t => {
      const raw = t.owner
      const ownerObj = Array.isArray(raw) ? raw[0] : raw
      return {
        id:           t.id,
        user_id:      t.user_id,
        title:        t.title,
        priority:     t.priority as 1 | 2 | 3 | 4,
        created_at:   t.created_at,
        updated_at:   t.updated_at,
        completed_at: t.completed_at,
        cancelled_at: t.cancelled_at,
        owner: {
          id:           ownerObj?.id ?? t.user_id,
          display_name: ownerObj?.display_name ?? '',
        },
      }
    })

    const managementUsers = (managementUsersRes.data ?? []) as { id: string; display_name: string }[]

    return (
      <div>
        <PageHeader tab="team" canSeeTeam />
        <TeamTodosView todos={teamTodos} users={managementUsers} />
      </div>
    )
  }

  // ── My To-Dos (existing behaviour, unchanged) ─────────────────────────────

  // RLS "todos: owner can read own" scopes this to the current user.
  // The .eq('user_id', user.id) is belt-and-suspenders over RLS.
  const { data } = await supabase
    .from('todos')
    .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at')
    .eq('user_id', user.id)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(200)

  const todos = (data ?? []) as Todo[]

  const openTodos = todos.filter(t => !t.completed_at && !t.cancelled_at)
  const completedTodos = todos
    .filter(t => !!t.completed_at)
    .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())
  const cancelledTodos = todos
    .filter(t => !!t.cancelled_at && !t.completed_at)
    .sort((a, b) => new Date(b.cancelled_at!).getTime() - new Date(a.cancelled_at!).getTime())

  return (
    <div>
      <PageHeader tab="my" canSeeTeam={canSeeTeam} />
      <TodoPageClient
        openTodos={openTodos}
        completedTodos={completedTodos}
        cancelledTodos={cancelledTodos}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page header — shared between My and Team tabs
// ---------------------------------------------------------------------------

function PageHeader({
  tab,
  canSeeTeam,
}: {
  tab: 'my' | 'team'
  canSeeTeam: boolean
}) {
  return (
    <div className="mb-6">
      {/* Title row */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">To-Dos</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            {tab === 'team'
              ? 'What the team is working on.'
              : 'Your personal to-do list.'}
          </p>
        </div>

        {/* Tab switcher — only visible to management users */}
        {canSeeTeam && (
          <div className="flex gap-1 text-sm">
            <Link
              href="/todos"
              className={[
                'px-3 py-1.5 rounded-lg transition-colors',
                tab === 'my'
                  ? 'bg-kk-ink text-white font-medium'
                  : 'text-kk-muted hover:bg-kk-soft hover:text-kk-ink',
              ].join(' ')}
            >
              My To-Dos
            </Link>
            <Link
              href="/todos?tab=team"
              className={[
                'px-3 py-1.5 rounded-lg transition-colors',
                tab === 'team'
                  ? 'bg-kk-ink text-white font-medium'
                  : 'text-kk-muted hover:bg-kk-soft hover:text-kk-ink',
              ].join(' ')}
            >
              Team
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
