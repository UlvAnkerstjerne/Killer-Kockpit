import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { WaitingOnStatusBadge } from '@/components/ui/WaitingOnStatusBadge'
import { MeetingStatusBadge } from '@/components/ui/MeetingStatusBadge'
import TaskList from '@/components/tasks/TaskList'
import type { ViewMode, ProjectStatus, WaitingStatus, MeetingStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const canManage = canAccessManagementView(user.role)
  const supabase = await createClient()
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const isManagementView = view === 'management' && canManage

  // All independent reads fire in a single parallel batch.
  // Management-only queries resolve to empty when not applicable.
  const [
    myTasksDueTodayRes,
    myOverdueTasksRes,
    myProjectsRes,
    myOverdueWaitingOnsRes,
    myWaitingOnsDueTodayRes,
    todayMeetingsRes,
    draftMeetingsRes,
    blockedProjectsRes,
    atRiskProjectsRes,
    orgOverdueTasksRes,
    orgOverdueWaitingOnsRes,
  ] = await Promise.all([
    // Personal — always fetched
    supabase
      .from('tasks')
      .select(`id, title, status, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name, email)`)
      .eq('owner_user_id', user.id)
      .gte('due_at', todayStart)
      .lt('due_at', todayEnd)
      .not('status', 'in', '("done","cancelled")')
      .is('archived_at', null)
      .order('priority'),

    supabase
      .from('tasks')
      .select(`id, title, status, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name, email)`)
      .eq('owner_user_id', user.id)
      .lt('due_at', todayStart)
      .not('status', 'in', '("done","cancelled")')
      .is('archived_at', null)
      .order('due_at')
      .limit(10),

    supabase
      .from('projects')
      .select(`id, title, status, due_date, progress, owner_user_id, owner:owner_user_id (id, display_name, email)`)
      .eq('owner_user_id', user.id)
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived")')
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(8),

    supabase
      .from('waiting_ons')
      .select('id, title, status, due_at, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name, email)')
      .eq('owner_user_id', user.id)
      .eq('status', 'open')
      .lt('due_at', todayStart)
      .is('archived_at', null)
      .order('due_at')
      .limit(5),

    supabase
      .from('waiting_ons')
      .select('id, title, status, due_at, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name, email)')
      .eq('owner_user_id', user.id)
      .eq('status', 'open')
      .gte('due_at', todayStart)
      .lt('due_at', todayEnd)
      .is('archived_at', null)
      .order('due_at'),

    // Meetings — always fetched
    supabase
      .from('meetings')
      .select(`id, title, status, scheduled_start, scheduled_end, owner:owner_user_id (id, display_name)`)
      .in('status', ['scheduled', 'open'])
      .gte('scheduled_start', todayStart)
      .lt('scheduled_start', todayEnd)
      .order('scheduled_start'),

    // Draft meetings — management only
    canManage
      ? supabase
          .from('meetings')
          .select('id, title, scheduled_start')
          .eq('status', 'draft')
          .order('scheduled_start', { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] as { id: string; title: string; scheduled_start: string | null }[] }),

    // Management overview — only when in management view
    isManagementView
      ? supabase
          .from('projects')
          .select(`id, title, status, due_date, progress, owner:owner_user_id (id, display_name, email)`)
          .eq('status', 'blocked')
          .is('archived_at', null)
          .order('due_date', { ascending: true, nullsFirst: false })
          .limit(5)
      : Promise.resolve({ data: [] }),

    isManagementView
      ? supabase
          .from('projects')
          .select(`id, title, status, due_date, progress, owner:owner_user_id (id, display_name, email)`)
          .eq('status', 'at_risk')
          .is('archived_at', null)
          .order('due_date', { ascending: true, nullsFirst: false })
          .limit(5)
      : Promise.resolve({ data: [] }),

    isManagementView
      ? supabase
          .from('tasks')
          .select(`id, title, status, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name, email)`)
          .lt('due_at', todayStart)
          .not('status', 'in', '("done","cancelled")')
          .is('archived_at', null)
          .order('due_at')
          .limit(10)
      : Promise.resolve({ data: [] }),

    isManagementView
      ? supabase
          .from('waiting_ons')
          .select(`id, title, status, due_at, waiting_for_name, owner:owner_user_id (id, display_name, email)`)
          .eq('status', 'open')
          .lt('due_at', todayStart)
          .is('archived_at', null)
          .order('due_at')
          .limit(8)
      : Promise.resolve({ data: [] }),
  ])

  const myTasksDueToday   = myTasksDueTodayRes.data
  const myOverdueTasks    = myOverdueTasksRes.data
  const myProjects        = myProjectsRes.data
  const myOverdueWaitingOns    = myOverdueWaitingOnsRes.data
  const myWaitingOnsDueToday   = myWaitingOnsDueTodayRes.data
  const todayMeetings     = todayMeetingsRes.data
  const draftMeetings     = (draftMeetingsRes.data ?? []) as { id: string; title: string; scheduled_start: string | null }[]

  type OrgProject = { id: string; title: string; status: ProjectStatus; due_date: string | null; progress: number | null; owner: { id: string; display_name: string; email: string } | Array<{ id: string; display_name: string; email: string }> | undefined }
  type OrgTask = { id: string; title: string; status: string; priority: number; due_at: string | null; completed_at: string | null; owner_user_id: string | null; owner: { id: string; display_name: string; email: string } | Array<{ id: string; display_name: string; email: string }> | undefined }
  type OrgWaitingOn = { id: string; title: string; status: string; due_at: string | null; waiting_for_name: string | null; owner: { id: string; display_name: string; email: string } | Array<{ id: string; display_name: string; email: string }> | undefined }
  const blockedProjects      = (blockedProjectsRes.data      || []) as OrgProject[]
  const atRiskProjects       = (atRiskProjectsRes.data       || []) as OrgProject[]
  const orgOverdueTasks      = (orgOverdueTasksRes.data      || []) as OrgTask[]
  const orgOverdueWaitingOns = (orgOverdueWaitingOnsRes.data || []) as OrgWaitingOn[]

  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Today</h1>
        <p className="text-sm text-kk-muted mt-0.5">{today}</p>
      </div>

      <div className="grid grid-cols-3 gap-5">

        {/* Tasks due today */}
        <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
            <h2 className="text-sm font-semibold text-kk-ink">
              My tasks due today
              {myTasksDueToday && myTasksDueToday.length > 0 && (
                <span className="text-kk-muted font-normal ml-1">· {myTasksDueToday.length}</span>
              )}
            </h2>
            <Link href="/tasks?status=open" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
              All tasks →
            </Link>
          </div>
          <TaskList tasks={myTasksDueToday || []} currentUser={user} showProject={true} />
          {(!myTasksDueToday || myTasksDueToday.length === 0) && (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">
              Nothing due today.
            </div>
          )}
        </div>

        {/* Overdue */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line">
            <h2 className="text-sm font-semibold text-kk-ink">
              Overdue
              {myOverdueTasks && myOverdueTasks.length > 0 && (
                <span className="text-kk-bad font-normal ml-1">· {myOverdueTasks.length}</span>
              )}
            </h2>
          </div>
          {!myOverdueTasks || myOverdueTasks.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">No overdue tasks.</div>
          ) : (
            <div className="divide-y divide-kk-line">
              {myOverdueTasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-kk-soft transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-kk-ink font-medium truncate">{task.title}</div>
                    <div className="text-xs text-kk-bad mt-0.5">
                      {new Date(task.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* My projects */}
        <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
            <h2 className="text-sm font-semibold text-kk-ink">My projects</h2>
            <Link href="/projects" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
              All projects →
            </Link>
          </div>
          {!myProjects || myProjects.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">
              No active projects you own.
            </div>
          ) : (
            <div className="divide-y divide-kk-line">
              {myProjects.map((project) => {
                const isOverdue = project.due_date && new Date(project.due_date) < now
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                          {project.title}
                        </span>
                        <ProjectStatusBadge status={project.status} />
                      </div>
                      {project.due_date && (
                        <div className={`text-xs mt-0.5 ${isOverdue ? 'text-kk-bad' : 'text-kk-muted'}`}>
                          Due {new Date(project.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </div>
                      )}
                    </div>
                    {project.progress !== null && (
                      <div className="w-20 shrink-0">
                        <div className="text-xs text-kk-muted text-right mb-1">{project.progress}%</div>
                        <div className="progress-bar">
                          <div className="progress-bar-fill" style={{ width: `${project.progress}%` }} />
                        </div>
                      </div>
                    )}
                  </Link>
                )
              })}
            </div>
          )}
        </div>

        {/* My Waiting Ons */}
        {((myOverdueWaitingOns && myOverdueWaitingOns.length > 0) || (myWaitingOnsDueToday && myWaitingOnsDueToday.length > 0)) && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
              <h2 className="text-sm font-semibold text-kk-ink">
                Waiting On
                {myOverdueWaitingOns && myOverdueWaitingOns.length > 0 && (
                  <span className="text-kk-bad font-normal ml-1">· {myOverdueWaitingOns.length} overdue</span>
                )}
              </h2>
              <Link href="/waiting-ons" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
                All →
              </Link>
            </div>
            <div className="divide-y divide-kk-line">
              {[...(myOverdueWaitingOns ?? []), ...(myWaitingOnsDueToday ?? [])].map((wo) => {
                const isOverdue = wo.due_at && wo.due_at < todayStart
                const waitingForUser = Array.isArray(wo.waiting_for_user) ? wo.waiting_for_user[0] : wo.waiting_for_user
                return (
                  <Link key={wo.id} href={`/waiting-ons/${wo.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-kk-soft transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-kk-ink font-medium truncate">{wo.title}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {(waitingForUser?.display_name || wo.waiting_for_name) && (
                          <span className="text-xs text-kk-muted">{waitingForUser?.display_name || wo.waiting_for_name}</span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <WaitingOnStatusBadge status={(isOverdue ? 'overdue' : wo.status) as WaitingStatus} />
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Today's meetings */}
        {(todayMeetings && todayMeetings.length > 0) && (
          <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
              <h2 className="text-sm font-semibold text-kk-ink">
                Today&apos;s meetings
                <span className="text-kk-muted font-normal ml-1">· {todayMeetings.length}</span>
              </h2>
              <Link href="/meetings" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
                All meetings →
              </Link>
            </div>
            <div className="divide-y divide-kk-line">
              {todayMeetings.map((m) => {
                const owner = Array.isArray(m.owner) ? m.owner[0] : m.owner
                return (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">{m.title}</span>
                        <MeetingStatusBadge status={m.status as MeetingStatus} />
                      </div>
                      {owner && <div className="text-xs text-kk-muted mt-0.5">{owner.display_name}</div>}
                    </div>
                    {m.scheduled_start && (
                      <div className="text-xs text-kk-muted shrink-0">
                        {new Date(m.scheduled_start).toLocaleTimeString('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Draft meetings needing review (management only) */}
        {canManage && draftMeetings.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Awaiting review <span className="text-purple-700 font-normal">· {draftMeetings.length}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {draftMeetings.map((m) => (
                <Link
                  key={m.id}
                  href={`/meetings/${m.id}/publish`}
                  className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-kk-ink group-hover:underline truncate">{m.title}</div>
                    {m.scheduled_start && (
                      <div className="text-xs text-kk-muted mt-0.5">
                        {new Date(m.scheduled_start).toLocaleDateString('en-GB', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short' })}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-purple-700 shrink-0">Review →</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Management: blocked projects */}
        {view === 'management' && canManage && (
          <>
            {blockedProjects.length > 0 && (
              <div className="bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    Blocked projects <span className="text-kk-bad">· {blockedProjects.length}</span>
                  </h2>
                </div>
                <div className="divide-y divide-kk-line">
                  {blockedProjects.map((p) => {
                    const owner = Array.isArray(p.owner) ? p.owner[0] : p.owner
                    return (
                      <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-kk-ink group-hover:underline truncate">{p.title}</div>
                          {owner && <div className="text-xs text-kk-muted mt-0.5">{owner.display_name}</div>}
                        </div>
                        <ProjectStatusBadge status={p.status} />
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}

            {atRiskProjects.length > 0 && (
              <div className="bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    At risk <span className="text-kk-warn">· {atRiskProjects.length}</span>
                  </h2>
                </div>
                <div className="divide-y divide-kk-line">
                  {atRiskProjects.map((p) => {
                    const owner = Array.isArray(p.owner) ? p.owner[0] : p.owner
                    return (
                      <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-kk-ink group-hover:underline truncate">{p.title}</div>
                          {owner && <div className="text-xs text-kk-muted mt-0.5">{owner.display_name}</div>}
                        </div>
                        <ProjectStatusBadge status={p.status} />
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}

            {orgOverdueTasks.length > 0 && (
              <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    Overdue across organisation <span className="text-kk-bad">· {orgOverdueTasks.length}</span>
                  </h2>
                </div>
                <TaskList tasks={orgOverdueTasks} currentUser={user} showProject={true} />
              </div>
            )}

            {orgOverdueWaitingOns.length > 0 && (
              <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    Overdue waiting ons <span className="text-kk-bad">· {orgOverdueWaitingOns.length}</span>
                  </h2>
                  <Link href="/waiting-ons?status=overdue&view=management" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
                    All →
                  </Link>
                </div>
                <div className="divide-y divide-kk-line">
                  {orgOverdueWaitingOns.map((wo) => {
                    const owner = Array.isArray(wo.owner) ? wo.owner[0] : wo.owner
                    return (
                      <Link key={wo.id} href={`/waiting-ons/${wo.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-kk-soft transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-kk-ink truncate">{wo.title}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {owner && <span className="text-xs text-kk-muted">{owner.display_name}</span>}
                            {wo.waiting_for_name && <span className="text-xs text-kk-muted">· waiting on {wo.waiting_for_name}</span>}
                          </div>
                        </div>
                        {wo.due_at && (
                          <div className="text-xs text-kk-bad shrink-0">
                            {new Date(wo.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </div>
                        )}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
