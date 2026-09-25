import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAccessManagementView, canAssignToOthers, MANAGEMENT_ROLES } from '@/lib/permissions'
import type { Todo, TeamTodo } from '@/lib/types'
import TeamColumn from './TeamColumn'

export const dynamic = 'force-dynamic'

type RawTeamTodo = {
  id: string
  user_id: string
  title: string
  priority: number
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
  notes: string | null
  scheduled_for: string | null
  recurrence_rule: string | null
  recurrence_day: number | null
  parent_todo_id: string | null
  owner:
    | { id: string; display_name: string }
    | Array<{ id: string; display_name: string }>
    | null
}

// Hardcoded display order: current user first, then team
const TEAM_ORDER = ['Kasper Kristiansen', 'Adam Vearey', 'Lydia Mertiri', 'Sara Jørgensen']

export default async function TodosPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const canSeeTeam = canAccessManagementView(user.role)
  const supabase = await createClient()

  // Always load the user's own todos for the interactive column
  const [{ data: myData }, allUsersResult, projectsResult] = await Promise.all([
    supabase
      .from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id, upgraded_to_task_id, upgraded_at, completion_context, completed_by_user_id, sort_order')
      .eq('user_id', user.id)
      .order('sort_order', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(200),
    canAssignToOthers(user.role) ? getActiveUsers() : Promise.resolve([user]),
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'eq', 'completed')
      .order('title'),
  ])

  const todos = (myData ?? []) as Todo[]
  const openTodos = todos.filter(t => !t.completed_at && !t.cancelled_at && !t.upgraded_to_task_id)
  const completedTodos = todos
    .filter(t => !!t.completed_at)
    .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())
  const cancelledTodos = todos
    .filter(t => !!t.cancelled_at && !t.completed_at)
    .sort((a, b) => new Date(b.cancelled_at!).getTime() - new Date(a.cancelled_at!).getTime())

  const allUsers = (allUsersResult as { id: string; display_name: string; email: string }[])
    .map(u => ({ id: u.id, display_name: u.display_name, email: u.email }))

  // For management: load team todos
  let teamColumns: { name: string; todos: TeamTodo[] }[] = []

  if (canSeeTeam) {
    const [teamTodosRes, managementUsersRes] = await Promise.all([
      supabase
        .from('todos')
        .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id, owner:user_id (id, display_name)')
        .is('cancelled_at', null)
        .is('completed_at', null)
        .neq('user_id', user.id) // exclude self — shown in interactive column
        .order('priority', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('app_users')
        .select('id, display_name')
        .eq('active', true)
        .in('role', MANAGEMENT_ROLES)
        .neq('id', user.id)
        .order('display_name'),
    ])

    const teamTodos: TeamTodo[] = ((teamTodosRes.data ?? []) as RawTeamTodo[]).map(t => {
      const raw = t.owner
      const ownerObj = Array.isArray(raw) ? raw[0] : raw
      return {
        id: t.id, user_id: t.user_id, title: t.title,
        priority: t.priority as 1 | 2 | 3 | 4,
        created_at: t.created_at, updated_at: t.updated_at,
        completed_at: t.completed_at, cancelled_at: t.cancelled_at,
        notes: t.notes, scheduled_for: t.scheduled_for,
        recurrence_rule: t.recurrence_rule, recurrence_day: t.recurrence_day,
        parent_todo_id: t.parent_todo_id,
        owner: { id: ownerObj?.id ?? t.user_id, display_name: ownerObj?.display_name ?? '' },
      }
    })

    const managementUsers = (managementUsersRes.data ?? []) as { id: string; display_name: string }[]

    // Build columns in the fixed order
    const todosByUser = new Map<string, TeamTodo[]>()
    for (const t of teamTodos) {
      const arr = todosByUser.get(t.user_id) ?? []
      arr.push(t)
      todosByUser.set(t.user_id, arr)
    }

    // Sort users by TEAM_ORDER, unknowns at end
    const sortedUsers = [...managementUsers].sort((a, b) => {
      const ai = TEAM_ORDER.indexOf(a.display_name)
      const bi = TEAM_ORDER.indexOf(b.display_name)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })

    teamColumns = sortedUsers.map(u => ({
      name: u.display_name.split(' ')[0],
      todos: todosByUser.get(u.id) ?? [],
    }))
  }

  return (
    <div className="-m-4 p-4 min-h-screen bg-[#171717]">
      <div className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-kraft-light">To-Dos</h1>
        <p className="text-sm text-kraft-dark mt-0.5">Everyone&apos;s to-dos</p>
      </div>

      <div className={`grid gap-4`} style={canSeeTeam ? { gridTemplateColumns: `repeat(${1 + teamColumns.length}, 1fr)` } : undefined}>
        {/* My column — same card style as team, but interactive */}
        <TeamColumn
          name={user.display_name?.split(' ')[0] ?? 'Me'}
          todos={openTodos.map(t => ({
            id: t.id, user_id: t.user_id, title: t.title,
            priority: t.priority as 1 | 2 | 3 | 4,
            created_at: t.created_at, updated_at: t.updated_at,
            completed_at: t.completed_at, cancelled_at: t.cancelled_at,
            notes: t.notes, scheduled_for: t.scheduled_for,
            recurrence_rule: t.recurrence_rule, recurrence_day: t.recurrence_day,
            parent_todo_id: t.parent_todo_id,
            owner: { id: user.id, display_name: user.display_name ?? '' },
          }))}
          interactive
          currentUserId={user.id}
          allUsers={allUsers}
          projects={projectsResult.data ?? []}
        />

        {/* Team columns — read-only */}
        {teamColumns.map(col => (
          <TeamColumn key={col.name} name={col.name} todos={col.todos} />
        ))}
      </div>
    </div>
  )
}
