import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAccessManagementView, canAssignToOthers, MANAGEMENT_ROLES } from '@/lib/permissions'
import { orderPeople, resolveSelectedOwner, todosHref, type TeamPerson } from '@/lib/tasks/tasks-url'
import { ownedBy } from '@/lib/view'
import PersonPills from '@/components/people/PersonPills'
import type { Todo, TeamTodo } from '@/lib/types'
import TeamColumn from './TeamColumn'
import MobileTodoView from './MobileTodoView'
import CompletedTodosSection from './CompletedTodosSection'

export const dynamic = 'force-dynamic'

export default async function TodosPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; owner?: string }>
}) {
  const sp = await searchParams
  const returnTo = sp.returnTo
  const user = await getCurrentUser()
  if (!user) return null

  const isManagement = canAccessManagementView(user.role)
  const supabase = await createClient()

  // Team selector: active management users. Only management users see it or can pick another
  // person; everyone else is always themselves, whatever the URL says.
  const peopleRes = isManagement
    ? await supabase.from('app_users').select('id, display_name').eq('active', true).in('role', MANAGEMENT_ROLES)
    : { data: [] as TeamPerson[] }
  const people = orderPeople((peopleRes.data ?? []) as TeamPerson[])
  const selectedId = resolveSelectedOwner({
    isManagement, currentUserId: user.id, ownerParam: sp.owner, people,
  })
  const viewingOwn = selectedId === user.id

  const pills = isManagement ? (
    <PersonPills
      people={people}
      selectedId={selectedId}
      hrefFor={id => todosHref({ owner: id === user.id ? null : id, returnTo })}
    />
  ) : null

  // ── Another person's list: one read-only column ──────────────────────────────
  // Reads go through the signed-in user's RLS client (management roles may read team to-dos);
  // nothing here can create, complete, edit or reopen another person's to-do.
  if (!viewingOwn) {
    const person = people.find(p => p.id === selectedId)!
    const { data } = await supabase
      .from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id')
      .eq('user_id', selectedId)
      .is('cancelled_at', null)
      .is('completed_at', null)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(500)

    // Defence in depth: RLS lets managers read other users' rows, so keep only the selected person's.
    const theirTodos: TeamTodo[] = ownedBy((data ?? []) as Omit<TeamTodo, 'owner'>[], selectedId, 'user_id').map(t => ({
      ...t,
      priority: t.priority as 1 | 2 | 3 | 4,
      owner: { id: person.id, display_name: person.display_name },
    }))

    return (
      <div className="-m-4 p-4 min-h-screen bg-kraft-light">
        <div className="mb-3">
          {returnTo && (
            <Link href={returnTo} className="sm:hidden flex items-center gap-1.5 text-sm text-kk-muted mb-3 py-1">
              <span className="text-lg leading-none">&lsaquo;</span>
              <span>{returnTo === '/store' ? 'Store Dashboard' : 'Back'}</span>
            </Link>
          )}
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">To-Dos</h1>
        </div>
        {pills}
        <div className="max-w-2xl">
          {/* No `interactive`: read-only on desktop and mobile. */}
          <TeamColumn name={person.display_name.split(' ')[0]} todos={theirTodos} />
        </div>
      </div>
    )
  }

  // ── Own list: fully interactive ──────────────────────────────────────────────
  const [{ data: myData }, { data: completedData }, allUsersResult, projectsResult] = await Promise.all([
    supabase
      .from('todos')
      .select('id, user_id, title, priority, created_at, updated_at, completed_at, cancelled_at, notes, scheduled_for, recurrence_rule, recurrence_day, parent_todo_id, upgraded_to_task_id, upgraded_at, completion_context, completed_by_user_id, sort_order')
      .eq('user_id', user.id)
      .is('completed_at', null)
      .is('cancelled_at', null)
      .is('upgraded_to_task_id', null)
      .order('sort_order', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('todos')
      .select('id, title, completed_at, completion_context, notes, upgraded_to_task_id')
      .eq('user_id', user.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(500),
    canAssignToOthers(user.role) ? getActiveUsers() : Promise.resolve([user]),
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'eq', 'completed')
      .order('title'),
  ])

  // RLS lets managers read other users' rows, so scope to the signed-in user explicitly as well.
  const openTodos = ownedBy((myData ?? []) as Todo[], user.id, 'user_id')

  type CompletedTodoItem = {
    id: string
    title: string
    completed_at: string
    completion_context: string | null
    notes: string | null
    upgraded_to_task_id: string | null
  }
  const completedTodos: CompletedTodoItem[] = (completedData ?? [])
    .filter((t): t is typeof t & { completed_at: string } => !!t.completed_at)

  const allUsers = (allUsersResult as { id: string; display_name: string; email: string }[])
    .map(u => ({ id: u.id, display_name: u.display_name, email: u.email }))

  const myName = user.display_name?.split(' ')[0] ?? 'Me'
  const myTeamTodos: TeamTodo[] = openTodos.map(t => ({
    id: t.id, user_id: t.user_id, title: t.title,
    priority: t.priority as 1 | 2 | 3 | 4,
    created_at: t.created_at, updated_at: t.updated_at,
    completed_at: t.completed_at, cancelled_at: t.cancelled_at,
    notes: t.notes, scheduled_for: t.scheduled_for,
    recurrence_rule: t.recurrence_rule, recurrence_day: t.recurrence_day,
    parent_todo_id: t.parent_todo_id,
    owner: { id: user.id, display_name: user.display_name ?? '' },
  }))

  return (
    <div className="-m-4 p-4 min-h-screen bg-kraft-light">
      {/* ── Mobile view (< 640px) ── */}
      <div className="sm:hidden">
        <MobileTodoView
          myName={myName}
          myTodos={myTeamTodos}
          teamColumns={[]}
          currentUserId={user.id}
          allUsers={allUsers}
          projects={projectsResult.data ?? []}
          returnTo={returnTo}
          belowHeading={pills}
        />
        <CompletedTodosSection todos={completedTodos} />
      </div>

      {/* ── Desktop view (>= 640px) ── */}
      <div className="hidden sm:block">
        <div className="mb-3">
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">To-Dos</h1>
        </div>
        {pills}

        <div className="max-w-2xl">
          <TeamColumn
            name={myName}
            todos={myTeamTodos}
            interactive
            currentUserId={user.id}
            allUsers={allUsers}
            projects={projectsResult.data ?? []}
          />
        </div>

        <CompletedTodosSection todos={completedTodos} />
      </div>
    </div>
  )
}
