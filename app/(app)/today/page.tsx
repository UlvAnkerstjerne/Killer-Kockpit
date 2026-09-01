import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { MeetingStatusBadge } from '@/components/ui/MeetingStatusBadge'
import { PriorityBadge } from '@/components/ui/StatusBadge'
import {
  getCopenhagenWeekBounds,
  copenhagenMidnightUTC,
  getDueState,
  sortWorkItems,
  formatCopenhagenWeekRange,
} from '@/lib/today/weekUtils'
import type { WorkItem } from '@/lib/today/weekUtils'
import type { ViewMode, MeetingStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Due-state display config
// ---------------------------------------------------------------------------

const DUE_STATE_CONFIG = {
  overdue:   { label: 'OVERDUE',   cls: 'text-kk-bad   bg-kk-bad-bg' },
  today:     { label: 'TODAY',     cls: 'text-kk-warn  bg-kk-warn-bg' },
  tomorrow:  { label: 'TOMORROW',  cls: 'text-amber-700 bg-amber-50' },
  this_week: { label: '',          cls: '' },
  no_date:   { label: '',          cls: '' },
} as const

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const canManage = canAccessManagementView(user.role)
  const isManagementView = view === 'management' && canManage

  const supabase = await createClient()
  const now = new Date()
  const { weekStart, weekEnd } = getCopenhagenWeekBounds(now)
  const weekStartISO = weekStart.toISOString()
  const weekEndISO   = weekEnd.toISOString()

  // Copenhagen calendar date for today (for meeting day boundaries)
  const todayDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Copenhagen' })
  const [ty, tm, td] = todayDateStr.split('-').map(Number)
  const todayStart    = copenhagenMidnightUTC(ty, tm, td)
  const todayEnd      = copenhagenMidnightUTC(ty, tm, td + 1)
  const todayStartISO = todayStart.toISOString()
  const todayEndISO   = todayEnd.toISOString()

  // All reads fire in parallel
  const [
    unfinishedTasksRes,
    completedTasksRes,
    unfinishedWOsRes,
    fulfilledWOsRes,
    todayMeetingsRes,
    weekMeetingsRes,
    draftMeetingsRes,
  ] = await Promise.all([
    // Unfinished tasks: overdue OR due this week (not done/cancelled, not archived)
    (isManagementView
      ? supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .lt('due_at', weekEndISO)
          .not('due_at', 'is', null)
          .not('status', 'in', '("done","cancelled")')
          .is('archived_at', null)
      : supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .eq('owner_user_id', user.id)
          .lt('due_at', weekEndISO)
          .not('due_at', 'is', null)
          .not('status', 'in', '("done","cancelled")')
          .is('archived_at', null)
    ),

    // Tasks completed this week
    (isManagementView
      ? supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .gte('completed_at', weekStartISO)
          .lt('completed_at', weekEndISO)
          .eq('status', 'done')
          .is('archived_at', null)
      : supabase.from('tasks')
          .select('id, title, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name)')
          .eq('owner_user_id', user.id)
          .gte('completed_at', weekStartISO)
          .lt('completed_at', weekEndISO)
          .eq('status', 'done')
          .is('archived_at', null)
    ),

    // Unfinished waiting ons: overdue OR due this week (open only, not archived)
    (isManagementView
      ? supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name)')
          .lt('due_at', weekEndISO)
          .not('due_at', 'is', null)
          .eq('status', 'open')
          .is('archived_at', null)
      : supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name, waiting_for_user:waiting_for_user_id (id, display_name)')
          .eq('owner_user_id', user.id)
          .lt('due_at', weekEndISO)
          .not('due_at', 'is', null)
          .eq('status', 'open')
          .is('archived_at', null)
    ),

    // Waiting ons fulfilled this week
    (isManagementView
      ? supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name')
          .gte('fulfilled_at', weekStartISO)
          .lt('fulfilled_at', weekEndISO)
          .eq('status', 'fulfilled')
          .is('archived_at', null)
      : supabase.from('waiting_ons')
          .select('id, title, priority, due_at, fulfilled_at, owner_user_id, waiting_for_name')
          .eq('owner_user_id', user.id)
          .gte('fulfilled_at', weekStartISO)
          .lt('fulfilled_at', weekEndISO)
          .eq('status', 'fulfilled')
          .is('archived_at', null)
    ),

    // Today's meetings (scheduled + open)
    supabase.from('meetings')
      .select('id, title, status, scheduled_start, scheduled_end, owner:owner_user_id (id, display_name)')
      .in('status', ['scheduled', 'open'])
      .gte('scheduled_start', todayStartISO)
      .lt('scheduled_start', todayEndISO)
      .order('scheduled_start'),

    // All meetings this week (today + later days)
    supabase.from('meetings')
      .select('id, title, status, scheduled_start, owner:owner_user_id (id, display_name)')
      .in('status', ['scheduled', 'open'])
      .gte('scheduled_start', weekStartISO)
      .lt('scheduled_start', weekEndISO)
      .order('scheduled_start'),

    // Draft meetings awaiting review (management only)
    canManage
      ? supabase.from('meetings')
          .select('id, title, scheduled_start')
          .eq('status', 'draft')
          .order('scheduled_start', { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] as { id: string; title: string; scheduled_start: string | null }[] }),
  ])

  // ---------------------------------------------------------------------------
  // Build unified work list
  // ---------------------------------------------------------------------------

  type RawTask = { id: string; title: string; priority: number; due_at: string | null; completed_at: string | null; owner_user_id: string | null; owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined }
  type RawWO   = { id: string; title: string; priority: number; due_at: string | null; fulfilled_at: string | null; owner_user_id: string | null; waiting_for_name: string | null; waiting_for_user?: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined }

  const unfinishedTasks    = (unfinishedTasksRes.data  || []) as RawTask[]
  const completedTasks     = (completedTasksRes.data   || []) as RawTask[]
  const unfinishedWOs      = (unfinishedWOsRes.data    || []) as RawWO[]
  const fulfilledWOs       = (fulfilledWOsRes.data     || []) as RawWO[]
  const draftMeetings      = (draftMeetingsRes.data    || []) as { id: string; title: string; scheduled_start: string | null }[]

  function ownerName(raw: RawTask | RawWO): string | undefined {
    const owner = (raw as RawTask).owner
    if (!owner) return undefined
    return (Array.isArray(owner) ? owner[0] : owner)?.display_name
  }

  const workItems: WorkItem[] = [
    ...unfinishedTasks.map(t => ({
      id: t.id, kind: 'task' as const,
      title: t.title, priority: t.priority,
      due_at: t.due_at, done_at: null,
      href: `/tasks/${t.id}`,
      ownerName: isManagementView ? ownerName(t) : undefined,
    })),
    ...unfinishedWOs.map(w => ({
      id: w.id, kind: 'waiting_on' as const,
      title: w.title, priority: w.priority,
      due_at: w.due_at, done_at: null,
      href: `/waiting-ons/${w.id}`,
      ownerName: isManagementView ? ownerName(w) : undefined,
    })),
    ...completedTasks.map(t => ({
      id: t.id, kind: 'task' as const,
      title: t.title, priority: t.priority,
      due_at: t.due_at, done_at: t.completed_at,
      href: `/tasks/${t.id}`,
      ownerName: isManagementView ? ownerName(t) : undefined,
    })),
    ...fulfilledWOs.map(w => ({
      id: w.id, kind: 'waiting_on' as const,
      title: w.title, priority: w.priority,
      due_at: w.due_at, done_at: w.fulfilled_at,
      href: `/waiting-ons/${w.id}`,
      ownerName: isManagementView ? ownerName(w) : undefined,
    })),
  ]

  const sorted = sortWorkItems(workItems, now)
  const unfinished = sorted.filter(i => i.done_at === null)
  const done       = sorted.filter(i => i.done_at !== null)

  // Meetings: week list, deduplicated against today's list
  const todayMeetings = (todayMeetingsRes.data || []) as { id: string; title: string; status: string; scheduled_start: string | null; scheduled_end?: string | null; owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined }[]
  const todayIds = new Set(todayMeetings.map(m => m.id))
  const weekMeetings = ((weekMeetingsRes.data || []) as { id: string; title: string; status: string; scheduled_start: string | null; owner: { id: string; display_name: string } | Array<{ id: string; display_name: string }> | undefined }[])
    .filter(m => !todayIds.has(m.id))

  const weekRangeLabel = formatCopenhagenWeekRange(weekStart, weekEnd)

  function formatTime(dt: string | null) {
    if (!dt) return null
    return new Date(dt).toLocaleTimeString('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' })
  }
  function formatDate(dt: string | null) {
    if (!dt) return null
    return new Date(dt).toLocaleDateString('en-GB', { timeZone: 'Europe/Copenhagen', weekday: 'short', day: 'numeric', month: 'short' })
  }

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">This week</h1>
          <p className="text-sm text-kk-muted mt-0.5">{weekRangeLabel}</p>
        </div>

        {canManage && (
          <div className="flex gap-1 text-sm">
            <Link
              href="/today?view=personal"
              className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'personal' ? 'bg-kk-ink text-white' : 'text-kk-muted hover:bg-kk-soft'}`}
            >
              Personal
            </Link>
            <Link
              href="/today?view=management"
              className={`px-3 py-1.5 rounded-lg transition-colors ${view === 'management' ? 'bg-kk-ink text-white' : 'text-kk-muted hover:bg-kk-soft'}`}
            >
              Management
            </Link>
          </div>
        )}
      </div>

      <div className="space-y-6">
        {/* Work list */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
            <h2 className="text-sm font-semibold text-kk-ink">
              Work
              {unfinished.length > 0 && (
                <span className="text-kk-muted font-normal ml-1">· {unfinished.length} open</span>
              )}
            </h2>
            <div className="flex items-center gap-3">
              <Link href="/tasks" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">Tasks →</Link>
              <Link href="/waiting-ons" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">Waiting ons →</Link>
            </div>
          </div>

          {sorted.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-kk-muted">
              Nothing due this week.
            </div>
          ) : (
            <div className="divide-y divide-kk-line">
              {/* Unfinished items */}
              {unfinished.map(item => {
                const state = getDueState(item.due_at, now, weekEnd)
                const cfg = DUE_STATE_CONFIG[state]
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                          {item.title}
                        </span>
                        {item.priority === 1 && <PriorityBadge priority={1} />}
                        {item.kind === 'waiting_on' && (
                          <span className="text-xs text-kk-muted border border-kk-line rounded px-1.5 py-0.5">WO</span>
                        )}
                      </div>
                      {item.ownerName && (
                        <div className="text-xs text-kk-muted mt-0.5">{item.ownerName}</div>
                      )}
                    </div>
                    {cfg.label && (
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${cfg.cls}`}>
                        {cfg.label}
                      </span>
                    )}
                    {!cfg.label && item.due_at && (
                      <span className="text-xs text-kk-muted shrink-0">
                        {formatDate(item.due_at)}
                      </span>
                    )}
                  </Link>
                )
              })}

              {/* Done separator + done items */}
              {done.length > 0 && (
                <>
                  <div className="px-5 py-2 bg-kk-soft">
                    <span className="text-xs font-medium text-kk-muted">Completed this week · {done.length}</span>
                  </div>
                  {done.map(item => (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-kk-soft transition-colors group opacity-70"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-kk-good line-through truncate group-hover:no-underline">
                            {item.title}
                          </span>
                          {item.kind === 'waiting_on' && (
                            <span className="text-xs text-kk-muted border border-kk-line rounded px-1.5 py-0.5">WO</span>
                          )}
                        </div>
                        {item.ownerName && (
                          <div className="text-xs text-kk-muted mt-0.5">{item.ownerName}</div>
                        )}
                      </div>
                      {item.done_at && (
                        <span className="text-xs text-kk-good shrink-0">{formatDate(item.done_at)}</span>
                      )}
                    </Link>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Today's meetings */}
        {todayMeetings.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
              <h2 className="text-sm font-semibold text-kk-ink">
                Today&apos;s meetings <span className="text-kk-muted font-normal">· {todayMeetings.length}</span>
              </h2>
              <Link href="/meetings" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">All →</Link>
            </div>
            <div className="divide-y divide-kk-line">
              {todayMeetings.map(m => {
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
                      <div className="text-xs text-kk-muted shrink-0">{formatTime(m.scheduled_start)}</div>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Rest of week meetings */}
        {weekMeetings.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
              <h2 className="text-sm font-semibold text-kk-ink">
                Later this week <span className="text-kk-muted font-normal">· {weekMeetings.length}</span>
              </h2>
              <Link href="/meetings" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">All →</Link>
            </div>
            <div className="divide-y divide-kk-line">
              {weekMeetings.map(m => {
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
                      <div className="text-xs text-kk-muted shrink-0">{formatDate(m.scheduled_start)}</div>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Draft meetings awaiting review (management only) */}
        {canManage && draftMeetings.length > 0 && (
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Awaiting review <span className="text-purple-700 font-normal">· {draftMeetings.length}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {draftMeetings.map(m => (
                <Link
                  key={m.id}
                  href={`/meetings/${m.id}/publish`}
                  className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-kk-ink group-hover:underline truncate">{m.title}</div>
                    {m.scheduled_start && (
                      <div className="text-xs text-kk-muted mt-0.5">{formatDate(m.scheduled_start)}</div>
                    )}
                  </div>
                  <span className="text-xs text-purple-700 shrink-0">Review →</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
