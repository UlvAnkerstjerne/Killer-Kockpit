import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { addDays, buildWeekWindow } from './week'
import type { ImpactEvidenceItem, WeeklyImpactEvidence } from './types'

type Db = ReturnType<typeof createServiceClient>
type Row = Record<string, unknown>

function projectFrom(row: Row): { id: string | null; title: string | null } {
  const project = row.projects as { id?: string; title?: string } | null
  return { id: project?.id ?? null, title: project?.title ?? null }
}

function item(
  row: Row,
  kind: ImpactEvidenceItem['kind'],
  occurredAt: string,
  attribution: string,
  url: string,
  detailKey?: string,
): ImpactEvidenceItem {
  const project = projectFrom(row)
  const truncate = (value: unknown, max: number) => {
    if (!value) return null
    const text = String(value).trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  }
  return {
    id: `${kind}:${String(row.id)}`,
    kind,
    title: truncate(row.title ?? row.body ?? 'Untitled', 240) ?? 'Untitled',
    detail: detailKey ? truncate(row[detailKey], 1200) : null,
    occurredAt,
    projectId: project.id ?? (row.project_id ? String(row.project_id) : null),
    projectTitle: project.title,
    status: row.status ? String(row.status) : null,
    url,
    attribution,
  }
}

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, label: string): Promise<T> {
  const { data, error } = await promise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data as T
}

export async function collectWeeklyImpactEvidence(
  userId: string,
  selectedDate: string,
): Promise<WeeklyImpactEvidence> {
  const db = createServiceClient()
  const week = buildWeekWindow(selectedDate)
  const nowIso = new Date().toISOString()
  const evidenceEndIso = nowIso < week.endExclusiveIso ? nowIso : week.endExclusiveIso

  const user = await must<Row>(
    db.from('app_users').select('id, display_name, email, active').eq('id', userId).eq('active', true).single(),
    'Active user lookup failed',
  )

  const [tasks, todos, projects, attendeeRows, decisions, waitingOns, authoredUpdateRows, nextTasks, nextWaitingOns, linkedEmployee] = await Promise.all([
    must<Row[]>(db.from('tasks')
      .select('id, title, description, status, completed_at, project_id, projects(id, title)')
      .eq('owner_user_id', userId).eq('status', 'done')
      .gte('completed_at', week.startIso).lt('completed_at', evidenceEndIso)
      .is('archived_at', null).order('completed_at'), 'Completed tasks query failed'),
    must<Row[]>(db.from('todos')
      .select('id, title, notes, completed_at, completed_by_user_id')
      .eq('user_id', userId).gte('completed_at', week.startIso).lt('completed_at', evidenceEndIso)
      .is('cancelled_at', null).order('completed_at'), 'Completed todos query failed'),
    must<Row[]>(db.from('projects')
      .select('id, title, description, status, progress, completed_at, updated_at')
      .eq('owner_user_id', userId).gte('updated_at', week.startIso).lt('updated_at', evidenceEndIso)
      .is('archived_at', null).order('updated_at'), 'Projects query failed'),
    must<Row[]>(db.from('meeting_attendees').select('meeting_id').eq('user_id', userId), 'Meeting attendance query failed'),
    must<Row[]>(db.from('decisions')
      .select('id, title, decision_text, rationale, status, decided_at, updated_at, project_id, projects(id, title)')
      .or(`owner_user_id.eq.${userId},approved_by_user_id.eq.${userId}`)
      .gte('updated_at', week.startIso).lt('updated_at', evidenceEndIso)
      .is('archived_at', null).order('updated_at'), 'Decisions query failed'),
    must<Row[]>(db.from('waiting_ons')
      .select('id, title, notes, status, fulfilled_at, project_id, projects(id, title)')
      .eq('owner_user_id', userId).eq('status', 'fulfilled')
      .gte('fulfilled_at', week.startIso).lt('fulfilled_at', evidenceEndIso)
      .is('archived_at', null).order('fulfilled_at'), 'Waiting Ons query failed'),
    must<Row[]>(db.from('kk_updates')
      .select('id, body, occurred_on, created_at, created_by_user_id')
      .eq('created_by_user_id', userId).gte('created_at', week.startIso).lt('created_at', evidenceEndIso)
      .order('created_at'), 'Universal Updates query failed'),
    must<Row[]>(db.from('tasks')
      .select('id, title, description, status, due_at, project_id, projects(id, title)')
      .eq('owner_user_id', userId).in('status', ['open', 'in_progress', 'blocked', 'pending_review'])
      .gte('due_at', week.endExclusiveIso).lt('due_at', buildWeekWindow(addDays(week.endDate, 1)).endExclusiveIso)
      .is('archived_at', null).order('due_at').limit(12), 'Next-week tasks query failed'),
    must<Row[]>(db.from('waiting_ons')
      .select('id, title, notes, status, due_at, project_id, projects(id, title)')
      .eq('owner_user_id', userId).in('status', ['open', 'overdue'])
      .is('archived_at', null).order('due_at').limit(8), 'Open Waiting Ons query failed'),
    must<Row | null>(db.from('employees').select('id').eq('linked_user_id', userId).maybeSingle(), 'Linked employee query failed'),
  ])

  let linkedUpdateRows: Row[] = []
  if (linkedEmployee?.id) {
    const updateLinks = await must<Row[]>(db.from('kk_update_entities')
      .select('update_id').eq('entity_type', 'employee').eq('entity_id', linkedEmployee.id), 'Linked updates query failed')
    const linkedUpdateIds = updateLinks.map(link => String(link.update_id))
    if (linkedUpdateIds.length > 0) {
      linkedUpdateRows = await must<Row[]>(db.from('kk_updates')
        .select('id, body, occurred_on, created_at, created_by_user_id')
        .in('id', linkedUpdateIds).gte('created_at', week.startIso).lt('created_at', evidenceEndIso), 'Explicitly linked updates query failed')
    }
  }

  const updates = [...new Map([...authoredUpdateRows, ...linkedUpdateRows].map(row => [String(row.id), row])).values()]
  const updateIds = updates.map(row => String(row.id))
  const updateEntityLinks = updateIds.length === 0 ? [] : await must<Row[]>(db.from('kk_update_entities')
    .select('update_id, entity_type, entity_id').in('update_id', updateIds), 'Update entity links query failed')
  const entityIds = (type: string) => [...new Set(updateEntityLinks.filter(link => link.entity_type === type).map(link => String(link.entity_id)))]
  const [updateProjects, updateEmployees, updateLocations] = await Promise.all([
    entityIds('project').length ? must<Row[]>(db.from('projects').select('id, title').in('id', entityIds('project')), 'Update projects query failed') : [],
    entityIds('employee').length ? must<Row[]>(db.from('employees').select('id, name').in('id', entityIds('employee')), 'Update people query failed') : [],
    entityIds('location').length ? must<Row[]>(db.from('locations').select('id, name').in('id', entityIds('location')), 'Update locations query failed') : [],
  ])
  const entityNames = new Map<string, string>([
    ...updateProjects.map(row => [`project:${row.id}`, `Project ${row.title}`] as const),
    ...updateEmployees.map(row => [`employee:${row.id}`, `Person ${row.name}`] as const),
    ...updateLocations.map(row => [`location:${row.id}`, `Location ${row.name}`] as const),
  ])

  const meetingIds = attendeeRows.map(row => String(row.meeting_id))
  const ownedMeetings = await must<Row[]>(db.from('meetings')
    .select('id').eq('owner_user_id', userId)
    .gte('scheduled_start', week.startIso).lt('scheduled_start', evidenceEndIso), 'Owned meetings query failed')
  const allMeetingIds = [...new Set([...meetingIds, ...ownedMeetings.map(row => String(row.id))])]
  const meetings = allMeetingIds.length === 0 ? [] : await must<Row[]>(db.from('meetings')
    .select('id, title, context, status, scheduled_start, actual_start, project_id, projects(id, title), meeting_minutes(body, status)')
    .in('id', allMeetingIds)
    .gte('scheduled_start', week.startIso).lt('scheduled_start', evidenceEndIso)
    .neq('status', 'cancelled').order('scheduled_start'), 'Meetings query failed')

  const completedTasks = tasks.map(row => item(row, 'task', String(row.completed_at), 'Owned task completed', `/tasks/${row.id}`, 'description'))
  const completedTodos = todos.map(row => item(row, 'todo', String(row.completed_at), 'Owned personal to-do completed', '/todos', 'notes'))
  const movedProjects = projects.map(row => ({
    ...item(row, 'project', String(row.completed_at ?? row.updated_at), row.completed_at ? 'Owned project completed' : 'Owned project changed', `/projects/${row.id}`, 'description'),
    detail: [row.description, row.progress != null ? `Progress: ${row.progress}%` : null].filter(Boolean).join(' · ') || null,
  }))
  const meetingItems = meetings.filter(row => row.status === 'published' || Boolean(row.actual_start)).map(row => {
    const minutes = (row.meeting_minutes as Array<{ body?: string; status?: string }> | null)?.find(m => m.status === 'published')
    return item({ ...row, detail: minutes?.body ?? row.context }, 'meeting', String(row.actual_start ?? row.scheduled_start), 'Meeting owner or recorded attendee', `/meetings/${row.id}`, 'detail')
  })
  const decisionItems = decisions.map(row => item(
    row, 'decision', String(row.decided_at ?? row.updated_at),
    'Decision owner or recorded approver', `/decisions/${row.id}`, 'decision_text',
  ))
  const resolvedWaitingOns = waitingOns.map(row => item(row, 'waiting_on', String(row.fulfilled_at), 'Owned Waiting On resolved', `/waiting-ons/${row.id}`, 'notes'))
  const authoredUpdates = updates.map(row => {
    const links = updateEntityLinks
      .filter(link => String(link.update_id) === String(row.id))
      .map(link => entityNames.get(`${link.entity_type}:${link.entity_id}`))
      .filter((name): name is string => Boolean(name))
    return item(
      { ...row, title: row.body, detail: links.length ? `Linked to: ${links.join(', ')}` : null },
      'update', String(row.occurred_on ? `${row.occurred_on}T12:00:00Z` : row.created_at),
      row.created_by_user_id === userId ? 'Universal Update authored' : 'Universal Update explicitly linked to user',
      '/updates', 'detail',
    )
  })
  const nextWeek = [
    ...nextTasks.map(row => item(row, 'task', String(row.due_at), 'Owned open task due next week', `/tasks/${row.id}`, 'description')),
    ...nextWaitingOns.map(row => item(row, 'waiting_on', String(row.due_at ?? week.endExclusiveIso), 'Owned unresolved Waiting On', `/waiting-ons/${row.id}`, 'notes')),
  ]

  return {
    user: { id: String(user.id), name: String(user.display_name), email: String(user.email) },
    week,
    completedTasks,
    completedTodos,
    movedProjects,
    meetings: meetingItems,
    decisions: decisionItems,
    resolvedWaitingOns,
    authoredUpdates,
    nextWeek,
    counts: {
      tasksCompleted: completedTasks.length,
      todosCompleted: completedTodos.length,
      projectsMoved: movedProjects.length,
      meetings: meetingItems.length,
      decisions: decisionItems.length,
      waitingOnsResolved: resolvedWaitingOns.length,
      updatesShared: authoredUpdates.length,
    },
  }
}
